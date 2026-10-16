import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface SyntheticGrant {
  provider: 'manageengine';
  region: string;
  customerId: string;
  scopes: string[];
  refreshToken: string;
}

export class EncryptedGrantStore {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('Grant key must be 32 bytes');
  }

  async save(grant: SyntheticGrant): Promise<void> {
    if (!grant.customerId || grant.region !== 'synthetic' || !grant.refreshToken)
      throw new Error('Invalid synthetic grant');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const aad = Buffer.from(`${grant.provider}\n${grant.region}\n${grant.customerId}`);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(grant.refreshToken, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    await this.pool.query(
      "INSERT INTO mdm_integration(id,provider,region,customer_id,status,encrypted_refresh_token,token_iv,token_tag,token_key_version,scopes) VALUES($1,$2,$3,$4,'SYNTHETIC_CONNECTED',$5,$6,$7,1,$8) ON CONFLICT(provider,region,customer_id) DO UPDATE SET status='SYNTHETIC_CONNECTED',encrypted_refresh_token=$5,token_iv=$6,token_tag=$7,token_key_version=1,scopes=$8,updated_at=now()",
      [
        randomUUID(),
        grant.provider,
        grant.region,
        grant.customerId,
        encrypted,
        iv,
        tag,
        grant.scopes,
      ],
    );
  }

  async load(region: string, customerId: string): Promise<SyntheticGrant | null> {
    const result = await this.pool.query<{
      encrypted_refresh_token: Buffer;
      token_iv: Buffer;
      token_tag: Buffer;
      scopes: string[];
    }>(
      "SELECT encrypted_refresh_token,token_iv,token_tag,scopes FROM mdm_integration WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND status='SYNTHETIC_CONNECTED'",
      [region, customerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.token_iv);
    decipher.setAAD(Buffer.from(`manageengine\n${region}\n${customerId}`));
    decipher.setAuthTag(row.token_tag);
    const refreshToken = Buffer.concat([
      decipher.update(row.encrypted_refresh_token),
      decipher.final(),
    ]).toString('utf8');
    return { provider: 'manageengine', region, customerId, scopes: row.scopes, refreshToken };
  }

  async disconnect(region: string, customerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE mdm_integration SET status='DISCONNECTED',encrypted_refresh_token=NULL,token_iv=NULL,token_tag=NULL,updated_at=now() WHERE provider='manageengine' AND region=$1 AND customer_id=$2",
      [region, customerId],
    );
  }
}

export class SyntheticTokenManager {
  private readonly access = new Map<string, { token: string; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly store: EncryptedGrantStore,
    private readonly exchange: (
      refreshToken: string,
    ) => Promise<{ token: string; expiresInSeconds: number }>,
    private readonly now: () => number = Date.now,
  ) {}

  async token(region: string, customerId: string): Promise<string> {
    const key = `${region}\n${customerId}`;
    const cached = this.access.get(key);
    if (cached && cached.expiresAt > this.now() + 30_000) return cached.token;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const generation = this.generation.get(key) ?? 0;
    const pending = (async () => {
      const grant = await this.store.load(region, customerId);
      if (!grant) throw new Error('Synthetic grant unavailable');
      const result = await this.exchange(grant.refreshToken);
      if (!result.token || result.expiresInSeconds <= 0)
        throw new Error('Synthetic token exchange failed');
      if ((this.generation.get(key) ?? 0) !== generation)
        throw new Error('Synthetic grant disconnected');
      this.access.set(key, {
        token: result.token,
        expiresAt: this.now() + result.expiresInSeconds * 1000,
      });
      return result.token;
    })();
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  disconnect(region: string, customerId: string): Promise<void> {
    const key = `${region}\n${customerId}`;
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.access.delete(key);
    return this.store.disconnect(region, customerId);
  }
}
