import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

/** Real grants are encrypted at rest; the mounted grant remains a read-only fallback. */
export class RealMdmGrantStore {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
    readonly region: string,
    readonly customerId: string,
  ) {
    if (key.length !== 32) throw new Error('Invalid MDM grant key');
  }

  private encrypt(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`manageengine\n${this.region}\n${this.customerId}\nreal`));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  async load(): Promise<string | null> {
    const result = await this.pool.query<{
      encrypted_refresh_token: Buffer;
      token_iv: Buffer;
      token_tag: Buffer;
    }>(
      `SELECT encrypted_refresh_token,token_iv,token_tag FROM mdm_integration
       WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND status='REAL_CONNECTED'`,
      [this.region, this.customerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.token_iv);
      decipher.setAAD(Buffer.from(`manageengine\n${this.region}\n${this.customerId}\nreal`));
      decipher.setAuthTag(row.token_tag);
      return Buffer.concat([
        decipher.update(row.encrypted_refresh_token),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ApiError(503, 'mdm_grant_unavailable', 'MDM unavailable');
    }
  }

  async activate(
    db: PoolClient,
    token: string,
    actorId: string,
    correlationId: string,
    scopes: string[] = ['MDMOnDemand.MDMInventory.READ'],
  ): Promise<void> {
    const current = await db.query<{ state: string; remote_revoked: boolean }>(
      `SELECT state,remote_revoked FROM mdm_connection_control
       WHERE provider='manageengine' AND region=$1 AND customer_id=$2 FOR UPDATE`,
      [this.region, this.customerId],
    );
    const row = current.rows[0];
    if (row && (row.state !== 'DISCONNECTED' || !row.remote_revoked))
      throw new ApiError(409, 'mdm_already_connected', 'Conflict');
    const encrypted = this.encrypt(token);
    await db.query(
      `INSERT INTO mdm_integration
       (id,provider,region,customer_id,status,encrypted_refresh_token,token_iv,token_tag,token_key_version,scopes)
       VALUES($1,'manageengine',$2,$3,'REAL_CONNECTED',$4,$5,$6,1,$7)
       ON CONFLICT(provider,region,customer_id) DO UPDATE SET
       status='REAL_CONNECTED',encrypted_refresh_token=$4,token_iv=$5,token_tag=$6,
       token_key_version=1,scopes=$7,updated_at=now()`,
      [
        randomUUID(),
        this.region,
        this.customerId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        scopes,
      ],
    );
    await db.query(
      `INSERT INTO mdm_connection_control
       (provider,region,customer_id,state,credential_digest,remote_revoked)
       VALUES('manageengine',$1,$2,'CONNECTED',$3,false)
       ON CONFLICT(provider,region,customer_id) DO UPDATE SET
       state='CONNECTED',credential_digest=$3,remote_revoked=false,updated_at=now()`,
      [this.region, this.customerId, digest(token)],
    );
    await appendAudit(db, {
      actorType: 'ADMIN',
      actorId,
      action: 'mdm.oauth.connect',
      outcome: 'success',
      correlationId,
      metadata: { provider: 'manageengine', region: this.region },
    });
  }

  async rotate(oldToken: string, newToken: string): Promise<void> {
    if (oldToken === newToken) return;
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock_shared(350019)');
      const control = await db.query<{ state: string; credential_digest: Buffer }>(
        `SELECT state,credential_digest FROM mdm_connection_control
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2 FOR UPDATE`,
        [this.region, this.customerId],
      );
      if (
        control.rows[0]?.state !== 'CONNECTED' ||
        !control.rows[0].credential_digest.equals(digest(oldToken))
      )
        throw new ApiError(503, 'mdm_grant_rotated', 'MDM unavailable');
      const recorded = await db.query<{ scopes: string[] }>(
        `SELECT scopes FROM mdm_integration WHERE provider='manageengine'
         AND region=$1 AND customer_id=$2 FOR UPDATE`,
        [this.region, this.customerId],
      );
      const encrypted = this.encrypt(newToken);
      await db.query(
        `INSERT INTO mdm_integration
         (id,provider,region,customer_id,status,encrypted_refresh_token,token_iv,token_tag,token_key_version,scopes)
         VALUES($1,'manageengine',$2,$3,'REAL_CONNECTED',$4,$5,$6,1,$7)
         ON CONFLICT(provider,region,customer_id) DO UPDATE SET
         status='REAL_CONNECTED',encrypted_refresh_token=$4,token_iv=$5,token_tag=$6,
         token_key_version=1,scopes=$7,updated_at=now()`,
        [
          randomUUID(),
          this.region,
          this.customerId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          recorded.rows[0]?.scopes ?? ['MDMOnDemand.MDMInventory.READ'],
        ],
      );
      await db.query(
        `UPDATE mdm_connection_control SET credential_digest=$3,updated_at=now()
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
        [this.region, this.customerId, digest(newToken)],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async remove(): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(350019)');
      const control = await db.query<{ state: string; remote_revoked: boolean }>(
        `SELECT state,remote_revoked FROM mdm_connection_control
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2 FOR UPDATE`,
        [this.region, this.customerId],
      );
      if (control.rows[0]?.state === 'DISCONNECTED' && control.rows[0].remote_revoked)
        await db.query(
          `UPDATE mdm_integration SET status='DISCONNECTED',encrypted_refresh_token=NULL,
           token_iv=NULL,token_tag=NULL,updated_at=now()
           WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
          [this.region, this.customerId],
        );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
