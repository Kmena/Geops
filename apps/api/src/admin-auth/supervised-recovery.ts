import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';

const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const TEN_MINUTES = 10 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bad = () => new ApiError(403, 'recovery_unavailable', 'Recovery unavailable');
const normalized = (email: string): string => {
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) throw bad();
  return value;
};

interface RequestRow {
  id: string;
  admin_id: string;
  status: string;
  expires_at: Date;
}

export class SupervisedRecoveryService {
  constructor(
    private readonly pool: Pool,
    private readonly sessionKey: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (sessionKey.length < 32) throw new Error('Recovery key must be at least 32 bytes');
  }

  private hash(code: string): Buffer {
    return createHmac('sha256', this.sessionKey).update(code).digest();
  }

  private async audit(
    client: PoolClient,
    action: string,
    adminId: string,
    ref: string,
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id) VALUES($1,'SYSTEM',$2,$3,'success',$4)",
      [randomUUID(), adminId, action, ref],
    );
  }

  /** Test/setup-only: operational custodian enrollment requires an approved out-of-band ceremony. */
  async registerSyntheticCustodian(email: string, password: string): Promise<string> {
    if (password.length < 16 || password.length > 1024) throw bad();
    const id = randomUUID();
    const hash = await argon2.hash(password, HASH_OPTIONS);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO recovery_custodian(id,email_normalized,password_hash,state) VALUES($1,$2,$3,'ACTIVE')",
        [id, normalized(email), hash],
      );
      await client.query(
        "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id) VALUES($1,'SYSTEM',$2,'admin.recovery.custodian.synthetic_provision','success',$3)",
        [randomUUID(), id, randomUUID()],
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async request(adminId: string, ref = randomUUID()): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query('SELECT id FROM admin_user WHERE id=$1 FOR UPDATE', [
        adminId,
      ]);
      if (target.rowCount !== 1) throw bad();
      await client.query(
        "UPDATE recovery_request SET status='CANCELLED',code_hash=NULL WHERE admin_id=$1 AND status IN ('PENDING','AUTHORIZED')",
        [adminId],
      );
      const id = randomUUID();
      await client.query(
        "INSERT INTO recovery_request(id,admin_id,status,expires_at,audit_ref) VALUES($1,$2,'PENDING',$3,$4)",
        [id, adminId, new Date(this.now().getTime() + TEN_MINUTES), ref],
      );
      await this.audit(client, 'admin.recovery.request', adminId, ref);
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async authenticatedCustodian(
    client: PoolClient,
    id: string,
    password: string,
    adminId: string,
  ): Promise<void> {
    const result = await client.query<{ password_hash: string }>(
      "SELECT c.password_hash FROM recovery_custodian c JOIN admin_user a ON a.id=$2 WHERE c.id=$1 AND c.state='ACTIVE' AND c.email_normalized<>a.email_normalized",
      [id, adminId],
    );
    if (!result.rows[0] || !(await argon2.verify(result.rows[0].password_hash, password)))
      throw bad();
  }

  async approve(requestId: string, custodianId: string, password: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<RequestRow>(
        'SELECT * FROM recovery_request WHERE id=$1 FOR UPDATE',
        [requestId],
      );
      const request = row.rows[0];
      if (request?.status !== 'PENDING' || request.expires_at <= this.now()) throw bad();
      await this.authenticatedCustodian(client, custodianId, password, request.admin_id);
      await client.query(
        'INSERT INTO recovery_approval(request_id,custodian_id,approved_at) VALUES($1,$2,$3) ON CONFLICT(request_id,custodian_id) DO UPDATE SET approved_at=EXCLUDED.approved_at,revoked_at=NULL',
        [requestId, custodianId, this.now()],
      );
      await this.audit(client, 'admin.recovery.approve', request.admin_id, requestId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeApproval(requestId: string, custodianId: string, password: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<RequestRow>(
        'SELECT * FROM recovery_request WHERE id=$1 FOR UPDATE',
        [requestId],
      );
      const request = row.rows[0];
      if (!request || !['PENDING', 'AUTHORIZED'].includes(request.status)) throw bad();
      await this.authenticatedCustodian(client, custodianId, password, request.admin_id);
      const changed = await client.query(
        'UPDATE recovery_approval SET revoked_at=$3 WHERE request_id=$1 AND custodian_id=$2 AND revoked_at IS NULL',
        [requestId, custodianId, this.now()],
      );
      if (changed.rowCount !== 1) throw bad();
      await client.query(
        "UPDATE recovery_request SET status='PENDING',code_hash=NULL WHERE id=$1",
        [requestId],
      );
      await this.audit(client, 'admin.recovery.approval_revoke', request.admin_id, requestId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async issueCode(requestId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<RequestRow>(
        'SELECT * FROM recovery_request WHERE id=$1 FOR UPDATE',
        [requestId],
      );
      const request = row.rows[0];
      if (request?.status !== 'PENDING' || request.expires_at <= this.now()) throw bad();
      const approvals = await client.query<{ n: number }>(
        "SELECT count(DISTINCT c.id)::int AS n FROM recovery_approval p JOIN recovery_custodian c ON c.id=p.custodian_id JOIN admin_user a ON a.id=$2 WHERE p.request_id=$1 AND p.revoked_at IS NULL AND c.state='ACTIVE' AND c.email_normalized<>a.email_normalized",
        [requestId, request.admin_id],
      );
      if ((approvals.rows[0]?.n ?? 0) < 2) throw bad();
      const code = randomBytes(32).toString('base64url');
      await client.query(
        "UPDATE recovery_request SET status='AUTHORIZED',code_hash=$2 WHERE id=$1",
        [requestId, this.hash(code)],
      );
      await this.audit(client, 'admin.recovery.authorize', request.admin_id, requestId);
      await client.query('COMMIT');
      return code;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async consume(code: string, newPassword: string): Promise<void> {
    if (newPassword.length < 16 || newPassword.length > 1024) throw bad();
    const passwordHash = await argon2.hash(newPassword, HASH_OPTIONS);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<RequestRow>(
        'SELECT * FROM recovery_request WHERE code_hash=$1 FOR UPDATE',
        [this.hash(code)],
      );
      const request = row.rows[0];
      if (request?.status !== 'AUTHORIZED' || request.expires_at <= this.now()) throw bad();
      const approvals = await client.query<{ n: number }>(
        "SELECT count(DISTINCT c.id)::int AS n FROM recovery_approval p JOIN recovery_custodian c ON c.id=p.custodian_id JOIN admin_user a ON a.id=$2 WHERE p.request_id=$1 AND p.revoked_at IS NULL AND c.state='ACTIVE' AND c.email_normalized<>a.email_normalized",
        [request.id, request.admin_id],
      );
      if ((approvals.rows[0]?.n ?? 0) < 2) throw bad();
      await client.query(
        "UPDATE admin_user SET password_hash=$2,state='ACTIVE',version=version+1,updated_at=$3 WHERE id=$1",
        [request.admin_id, passwordHash, this.now()],
      );
      await client.query(
        'UPDATE admin_session SET revoked_at=$2 WHERE admin_id=$1 AND revoked_at IS NULL',
        [request.admin_id, this.now()],
      );
      await client.query(
        "UPDATE recovery_request SET status='CONSUMED',code_hash=NULL,consumed_at=$2 WHERE id=$1",
        [request.id, this.now()],
      );
      await this.audit(client, 'admin.recovery.consume', request.admin_id, request.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeCustodian(custodianId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(
        "UPDATE recovery_custodian SET state='REVOKED',revoked_at=$2 WHERE id=$1 AND state='ACTIVE'",
        [custodianId, this.now()],
      );
      if (changed.rowCount !== 1) throw bad();
      await client.query(
        'UPDATE recovery_approval SET revoked_at=$2 WHERE custodian_id=$1 AND revoked_at IS NULL',
        [custodianId, this.now()],
      );
      await client.query(
        "UPDATE recovery_request SET status='CANCELLED',code_hash=NULL WHERE id IN (SELECT request_id FROM recovery_approval WHERE custodian_id=$1) AND status IN ('PENDING','AUTHORIZED')",
        [custodianId],
      );
      await client.query(
        "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id) VALUES($1,'SYSTEM',$2,'admin.recovery.custodian.revoke','success',$3)",
        [randomUUID(), custodianId, randomUUID()],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
