import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  generation: string;
  source: 'admin' | 'legacy';
}

type Stored = {
  generation: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
  updated_at: Date;
};

const TENANT = 'synthetic';
const LOCK = 350019;

export function validOAuthClientValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 2048 &&
    value.trim() === value &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

/** Client and grant encryption use distinct keys and authenticated domains. */
export class MdmOAuthClientStore {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    grantKey: Buffer,
    readonly region: string,
    private readonly legacy?: { clientId: string; clientSecret: string },
    readonly webOrigin?: string,
  ) {
    if (grantKey.length !== 32) throw new Error('Invalid MDM encryption key');
    this.key = Buffer.from(
      hkdfSync('sha256', grantKey, Buffer.alloc(0), 'GEOPS-MDM-OAUTH-CLIENT-v1', 32),
    );
  }

  private aad(generation: string): Buffer {
    return Buffer.from(`manageengine\n${TENANT}\n${this.region}\n${generation}\nclient-v1`);
  }

  private async tenant(db: Pool | PoolClient): Promise<void> {
    const row = await db.query(
      'SELECT 1 FROM geops_operating_tenant WHERE singleton=true AND tenant_id=$1',
      [TENANT],
    );
    if (!row.rowCount) throw new ApiError(409, 'tenant_not_established', 'Conflict');
  }

  async load(): Promise<OAuthClient | null> {
    await this.tenant(this.pool);
    const row = (
      await this.pool.query<Stored>(
        `SELECT generation::text,ciphertext,iv,tag,key_version,updated_at
         FROM mdm_oauth_client_config WHERE tenant_id=$1 AND region=$2`,
        [TENANT, this.region],
      )
    ).rows[0];
    if (!row) {
      return this.legacy ? { ...this.legacy, generation: 'legacy', source: 'legacy' } : null;
    }
    try {
      if (row.key_version !== 1) throw new Error('Key version');
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAAD(this.aad(row.generation));
      decipher.setAuthTag(row.tag);
      const value = JSON.parse(
        Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'),
      ) as Record<string, unknown>;
      if (!validOAuthClientValue(value.clientId) || !validOAuthClientValue(value.clientSecret))
        throw new Error('Invalid client');
      return {
        clientId: value.clientId,
        clientSecret: value.clientSecret,
        generation: row.generation,
        source: 'admin',
      };
    } catch {
      // A damaged administrative record must never fall back to mounted values.
      throw new ApiError(503, 'mdm_oauth_config_unavailable', 'MDM unavailable');
    }
  }

  async status(): Promise<{
    configured: boolean;
    source: 'admin' | 'legacy' | 'none';
    region: string;
  }> {
    const client = await this.load();
    return { configured: Boolean(client), source: client?.source ?? 'none', region: this.region };
  }

  async assertGeneration(db: Pool | PoolClient, generation: string): Promise<void> {
    const row = await db.query<{ generation: string }>(
      'SELECT generation::text FROM mdm_oauth_client_config WHERE tenant_id=$1 AND region=$2',
      [TENANT, this.region],
    );
    if ((row.rows[0]?.generation ?? 'legacy') !== generation)
      throw new ApiError(409, 'mdm_oauth_config_changed', 'Authorization expired');
  }

  async requireAdmin(adminId: string, db: Pool | PoolClient = this.pool): Promise<void> {
    const permission = await db.query(
      `SELECT 1 FROM admin_permission WHERE admin_id=$1
       AND permission='mdm.oauth.configure' AND revoked_at IS NULL FOR SHARE`,
      [adminId],
    );
    if (!permission.rowCount) throw new ApiError(403, 'mdm_oauth_config_forbidden', 'Forbidden');
  }

  async save(
    adminId: string,
    correlationId: string,
    clientId: string,
    clientSecret: string,
    onlyIfMissing = false,
  ): Promise<void> {
    if (!validOAuthClientValue(clientId) || !validOAuthClientValue(clientSecret))
      throw new ApiError(400, 'mdm_oauth_client_invalid', 'Invalid request');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      await this.tenant(db);
      await this.requireAdmin(adminId, db);
      if (onlyIfMissing) {
        const existing = await db.query(
          `SELECT 1 FROM mdm_oauth_client_config WHERE tenant_id=$1 AND region=$2 FOR UPDATE`,
          [TENANT, this.region],
        );
        if (existing.rowCount)
          throw new ApiError(409, 'mdm_oauth_client_already_configured', 'Conflict');
      }
      const limit = await db.query(
        `INSERT INTO mdm_oauth_config_rate(tenant_id,admin_id,next_allowed_at)
         VALUES($1,$2,now()+interval '15 seconds')
         ON CONFLICT(tenant_id,admin_id) DO UPDATE SET
         next_allowed_at=now()+interval '15 seconds'
         WHERE mdm_oauth_config_rate.next_allowed_at<=now() RETURNING 1`,
        [TENANT, adminId],
      );
      if (!limit.rowCount) throw new ApiError(429, 'mdm_oauth_config_rate_limited', 'Try later');
      const connected = await db.query(
        `SELECT 1 FROM mdm_connection_control WHERE provider='manageengine' AND region=$1
         AND (state<>'DISCONNECTED' OR remote_revoked=false) LIMIT 1`,
        [this.region],
      );
      if (connected.rowCount)
        throw new ApiError(409, 'mdm_disconnect_required', 'Disconnect ManageEngine first');
      const activeGrant = await db.query(
        `SELECT 1 FROM mdm_integration WHERE provider='manageengine' AND region=$1
         AND status='REAL_CONNECTED' LIMIT 1`,
        [this.region],
      );
      if (activeGrant.rowCount)
        throw new ApiError(409, 'mdm_disconnect_required', 'Disconnect ManageEngine first');
      const generation = randomUUID();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(this.aad(generation));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ clientId, clientSecret }), 'utf8'),
        cipher.final(),
      ]);
      await db.query(
        `INSERT INTO mdm_oauth_client_config
         (tenant_id,region,generation,ciphertext,iv,tag,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(tenant_id,region) DO UPDATE SET
         generation=$3,ciphertext=$4,iv=$5,tag=$6,updated_by=$7,updated_at=now()`,
        [TENANT, this.region, generation, ciphertext, iv, cipher.getAuthTag(), adminId],
      );
      await db.query('DELETE FROM mdm_oauth_pending WHERE region=$1', [this.region]);
      await db.query(
        `UPDATE mdm_integration SET status='DISCONNECTED',encrypted_refresh_token=NULL,
         token_iv=NULL,token_tag=NULL,updated_at=now()
         WHERE provider='manageengine' AND region=$1 AND status='DISCONNECTED'`,
        [this.region],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'mdm.oauth.client.configure',
        outcome: 'success',
        correlationId,
        metadata: { provider: 'manageengine', region: this.region },
      });
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'mdm.oauth.client.configure',
        outcome: 'rejected',
        correlationId,
        metadata: { code: error instanceof ApiError ? error.code : 'mdm_oauth_config_failed' },
      }).catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
