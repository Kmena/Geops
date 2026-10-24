import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { requireInstallationAccess } from '../device-identity/admin-scope.js';
import { ApiError } from '../errors.js';

const LOCK_ID = 350019;
type State = 'CONNECTED' | 'DISCONNECTING' | 'DISCONNECTED';

interface ConnectionRow {
  state: State;
  credential_digest: Buffer;
  remote_revoked: boolean;
}

/** Cross-process gate for every real-MDM operation. No credential value is stored in PostgreSQL. */
export class MdmConnectionControl {
  private readonly refreshSource: string | (() => Promise<string | null>);

  constructor(
    private readonly pool: Pool,
    private readonly region: string,
    private readonly customerId: string,
    refreshToken: string | (() => Promise<string | null>),
  ) {
    this.refreshSource = refreshToken;
  }

  private async digest(): Promise<Buffer | null> {
    const token =
      typeof this.refreshSource === 'string' ? this.refreshSource : await this.refreshSource();
    return token ? createHash('sha256').update(token).digest() : null;
  }

  private async row(db: PoolClient): Promise<ConnectionRow | undefined> {
    const result = await db.query<ConnectionRow>(
      `SELECT state,credential_digest,remote_revoked FROM mdm_connection_control
       WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
      [this.region, this.customerId],
    );
    return result.rows[0];
  }

  private async initialize(db: PoolClient, digest: Buffer): Promise<void> {
    await db.query(
      `INSERT INTO mdm_connection_control(provider,region,customer_id,state,credential_digest)
       VALUES('manageengine',$1,$2,'CONNECTED',$3) ON CONFLICT DO NOTHING`,
      [this.region, this.customerId, digest],
    );
  }

  async withConnected<T>(operation: () => Promise<T>): Promise<T> {
    const digest = await this.digest();
    if (!digest) throw new ApiError(503, 'mdm_disconnected', 'MDM unavailable');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock_shared($1)', [LOCK_ID]);
      await this.initialize(db, digest);
      const current = await this.row(db);
      if (current?.state !== 'CONNECTED' || !current.credential_digest.equals(digest))
        throw new ApiError(503, 'mdm_disconnected', 'MDM unavailable');
      const result = await operation();
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async isConnected(): Promise<boolean> {
    const digest = await this.digest();
    if (!digest) return false;
    const result = await this.pool.query<ConnectionRow>(
      `SELECT state,credential_digest,remote_revoked FROM mdm_connection_control
       WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
      [this.region, this.customerId],
    );
    const row = result.rows[0];
    return !row || (row.state === 'CONNECTED' && row.credential_digest.equals(digest));
  }

  async authorizationState(): Promise<'never' | 'connected' | 'disconnecting' | 'disconnected'> {
    const result = await this.pool.query<ConnectionRow>(
      `SELECT state,credential_digest,remote_revoked FROM mdm_connection_control
       WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
      [this.region, this.customerId],
    );
    const row = result.rows[0];
    if (!row) return (await this.digest()) ? 'connected' : 'never';
    if (row.state === 'DISCONNECTING') return 'disconnecting';
    if (row.state === 'DISCONNECTED') return 'disconnected';
    const digest = await this.digest();
    return digest && row.credential_digest.equals(digest) ? 'connected' : 'disconnected';
  }

  async disconnect(
    actorId: string,
    correlationId: string,
    remoteRevoke: () => Promise<boolean>,
  ): Promise<boolean> {
    const digest = await this.digest();
    if (!digest) throw new ApiError(503, 'mdm_disconnected', 'MDM unavailable');
    const db = await this.pool.connect();
    let alreadyRevoked = false;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      await this.initialize(db, digest);
      const current = await this.row(db);
      if (!current?.credential_digest.equals(digest))
        throw new ApiError(503, 'mdm_credential_mismatch', 'MDM unavailable');
      alreadyRevoked = current.state === 'DISCONNECTED' && current.remote_revoked;
      if (!alreadyRevoked) {
        await db.query(
          `UPDATE mdm_connection_control SET state='DISCONNECTING',remote_revoked=false,updated_at=now()
           WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
          [this.region, this.customerId],
        );
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'mdm.disconnect.started',
          outcome: 'success',
          correlationId,
          metadata: { provider: 'manageengine' },
        });
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
    if (alreadyRevoked) return true;

    let revoked = false;
    try {
      revoked = await remoteRevoke();
    } catch {
      revoked = false;
    }
    const result = await this.pool.connect();
    let effectiveRevoked = revoked;
    try {
      await result.query('BEGIN');
      await result.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      if (revoked)
        await result.query(
          `UPDATE mdm_connection_control SET state='DISCONNECTED',remote_revoked=true,updated_at=now()
           WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND state='DISCONNECTING'`,
          [this.region, this.customerId],
        );
      const current = await this.row(result);
      effectiveRevoked =
        revoked || Boolean(current?.state === 'DISCONNECTED' && current.remote_revoked);
      await appendAudit(result, {
        actorType: 'ADMIN',
        actorId,
        action: 'mdm.disconnect.remote',
        outcome: effectiveRevoked ? 'success' : 'failure',
        correlationId,
        metadata: { remote_revoked: effectiveRevoked },
      });
      await result.query('COMMIT');
    } catch (error) {
      await result.query('ROLLBACK');
      throw error;
    } finally {
      result.release();
    }
    return effectiveRevoked;
  }

  /** Requires a newly mounted OAuth grant and an authenticated administrative ceremony. */
  async reconnect(
    actorId: string,
    correlationId: string,
    verifyNewGrant: () => Promise<unknown>,
    reason = 'Authorized new MDM grant',
  ): Promise<void> {
    const check = async (db: PoolClient, digest: Buffer) => {
      await requireInstallationAccess(db, actorId, 'synthetic');
      const permission = await db.query(
        `SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.tenant.grant'
         AND revoked_at IS NULL FOR SHARE`,
        [actorId],
      );
      if (!permission.rowCount) throw new ApiError(403, 'gps_forbidden', 'Forbidden');
      const current = await this.row(db);
      if (
        current?.state !== 'DISCONNECTED' ||
        !current.remote_revoked ||
        current.credential_digest.equals(digest)
      )
        throw new ApiError(409, 'mdm_reconnect_requires_new_grant', 'Conflict');
    };
    const validate = async (digest: Buffer, finish: boolean): Promise<void> => {
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
        await check(db, digest);
        if (finish) {
          await db.query(
            `UPDATE mdm_connection_control SET state='CONNECTED',credential_digest=$3,
         remote_revoked=false,updated_at=now()
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
            [this.region, this.customerId, digest],
          );
          await appendAudit(db, {
            actorType: 'ADMIN',
            actorId,
            action: 'mdm.reconnect',
            outcome: 'success',
            correlationId,
            metadata: {
              provider: 'manageengine',
              reason_sha256: createHash('sha256').update(reason.trim()).digest('hex'),
            },
          });
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    };
    const initialDigest = await this.digest();
    if (!initialDigest) throw new ApiError(503, 'mdm_disconnected', 'MDM unavailable');
    await validate(initialDigest, false);
    // Vendor verification may refresh a grant; it must not run under the exclusive DB lock.
    await verifyNewGrant();
    const finalDigest = await this.digest();
    if (!finalDigest) throw new ApiError(503, 'mdm_disconnected', 'MDM unavailable');
    await validate(finalDigest, true);
  }
}
