import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSIGNABLE = new Set([
  'gps.policy.read',
  'gps.policy.write',
  'gps.policy.assign',
  'gps.policy.activate',
  'gps.session.read',
  'gps.location.read',
  'gps.audit.read',
  'gps.installation.manage',
  'gps.tenant.grant',
  'mdm.oauth.configure',
  'visit.catalog.read',
  'visit.catalog.write',
  'visit.schedule.read',
  'visit.schedule.write',
  'visit.result.read',
  'visit.evidence.read',
  'visit.evaluation.recompute',
]);
const denied = () => new ApiError(403, 'gps_forbidden', 'Forbidden');
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const digest = (value: string) => createHash('sha256').update(value).digest();
const normalizedEmail = (value: string) => value.trim().toLowerCase();
const validReason = (value: string) => value.trim().length >= 8 && value.length <= 240;

export class AdminUserAdministrationService {
  constructor(private readonly pool: Pool) {}

  private async manager(db: PoolClient, actorId: string): Promise<void> {
    const row = await db.query(
      "SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id AND p.permission='gps.user.manage' AND p.revoked_at IS NULL WHERE u.id=$1 AND u.state='ACTIVE' FOR SHARE OF u,p",
      [actorId],
    );
    if (!row.rowCount) throw denied();
  }

  private async tenant(db: PoolClient): Promise<string> {
    const row = await db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM geops_operating_tenant WHERE singleton=true FOR SHARE',
    );
    if (!row.rows[0]) throw new ApiError(409, 'tenant_not_established', 'Conflict');
    return row.rows[0].tenant_id;
  }

  private async rejected(
    actorId: string,
    ref: string,
    action: string,
    error: unknown,
  ): Promise<void> {
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId,
      action,
      outcome: 'rejected',
      correlationId: ref,
      metadata: { code: error instanceof ApiError ? error.code : 'dependency_unavailable' },
    }).catch(() => {});
  }

  async list(
    actorId: string,
    ref: string,
  ): Promise<{ users: Record<string, unknown>[]; tenant_id: string }> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.manager(db, actorId);
      const tenantId = await this.tenant(db);
      const rows = await db.query<{
        id: string;
        email: string;
        state: string;
        capabilities: string[];
        tenant_access: boolean;
      }>(
        `SELECT u.id,u.email_normalized AS email,u.state,
          ARRAY(SELECT permission FROM admin_permission p WHERE p.admin_id=u.id AND p.revoked_at IS NULL ORDER BY permission) AS capabilities,
          EXISTS(SELECT 1 FROM gps_data_tenant_access d JOIN gps_health_tenant_access h
            ON h.admin_id=d.admin_id AND h.tenant_id=d.tenant_id AND h.revoked_at IS NULL
            WHERE d.admin_id=u.id AND d.tenant_id=$1 AND d.revoked_at IS NULL) AS tenant_access
         FROM admin_user u ORDER BY u.email_normalized LIMIT 100`,
        [tenantId],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'admin.users.read',
        outcome: 'success',
        correlationId: ref,
        metadata: { count: rows.rows.length },
      });
      await db.query('COMMIT');
      return { users: rows.rows, tenant_id: tenantId };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(actorId, ref, 'admin.users.read', error);
      throw error;
    } finally {
      db.release();
    }
  }

  async create(
    actorId: string,
    ref: string,
    email: string,
    reason: string,
  ): Promise<{
    admin_id: string;
    invitation_id: string;
    invitation_token: string;
    expires_at: string;
  }> {
    const targetEmail = normalizedEmail(email);
    if (!EMAIL.test(targetEmail) || targetEmail.length > 254 || !validReason(reason))
      throw invalid();
    const token = randomBytes(32).toString('base64url');
    const inaccessible = await argon2.hash(randomBytes(32).toString('base64url'), {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.manager(db, actorId);
      await this.tenant(db);
      const id = randomUUID();
      const invitationId = randomUUID();
      const expires = new Date(Date.now() + 24 * 60 * 60_000);
      await db.query(
        "INSERT INTO admin_user(id,email_normalized,password_hash,state) VALUES($1,$2,$3,'LOCKED')",
        [id, targetEmail, inaccessible],
      );
      await db.query(
        'INSERT INTO admin_user_invitation(id,admin_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,$4,$5)',
        [invitationId, id, digest(token), actorId, expires],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'admin.user.create',
        outcome: 'success',
        correlationId: ref,
        metadata: { target_admin_id: id },
      });
      await db.query('COMMIT');
      return {
        admin_id: id,
        invitation_id: invitationId,
        invitation_token: token,
        expires_at: expires.toISOString(),
      };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(actorId, ref, 'admin.user.create', error);
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, 'user_exists', 'Conflict');
      throw error;
    } finally {
      db.release();
    }
  }

  async acceptInvitation(
    invitationId: string,
    token: string,
    password: string,
    ref: string,
  ): Promise<void> {
    if (
      !UUID.test(invitationId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      password.length < 16 ||
      password.length > 1024
    )
      throw denied();
    const db = await this.pool.connect();
    let rejected = false;
    try {
      await db.query('BEGIN');
      const found = await db.query<{
        admin_id: string;
        token_hash: Buffer;
        expires_at: Date;
        consumed_at: Date | null;
        failed_attempts: number;
      }>(
        'SELECT admin_id,token_hash,expires_at,consumed_at,failed_attempts FROM admin_user_invitation WHERE id=$1 FOR UPDATE',
        [invitationId],
      );
      const invitation = found.rows[0];
      if (
        !invitation ||
        invitation.consumed_at ||
        invitation.expires_at <= new Date() ||
        invitation.failed_attempts >= 5
      )
        throw denied();
      const provided = digest(token);
      if (!timingSafeEqual(invitation.token_hash, provided)) {
        await db.query(
          'UPDATE admin_user_invitation SET failed_attempts=failed_attempts+1 WHERE id=$1',
          [invitationId],
        );
        await appendAudit(db, {
          actorType: 'SYSTEM',
          action: 'admin.user.invitation.accept',
          outcome: 'rejected',
          correlationId: ref,
        });
        rejected = true;
        await db.query('COMMIT');
      } else {
        const target = await db.query(
          "SELECT 1 FROM admin_user WHERE id=$1 AND state='LOCKED' FOR UPDATE",
          [invitation.admin_id],
        );
        if (!target.rowCount) throw denied();
        const hash = await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        });
        await db.query(
          "UPDATE admin_user SET password_hash=$2,state='ACTIVE',version=version+1,updated_at=now() WHERE id=$1",
          [invitation.admin_id, hash],
        );
        await db.query('UPDATE admin_user_invitation SET consumed_at=now() WHERE id=$1', [
          invitationId,
        ]);
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: invitation.admin_id,
          action: 'admin.user.invitation.accept',
          outcome: 'success',
          correlationId: ref,
        });
        await db.query('COMMIT');
      }
    } catch (error) {
      await db.query('ROLLBACK');
      throw error instanceof ApiError ? error : denied();
    } finally {
      db.release();
    }
    if (rejected) throw denied();
  }

  async reissueInvitation(
    actorId: string,
    targetId: string,
    ref: string,
    reason: string,
  ): Promise<{
    invitation_id: string;
    invitation_token: string;
    expires_at: string;
  }> {
    if (!UUID.test(targetId) || actorId === targetId || !validReason(reason)) throw invalid();
    const token = randomBytes(32).toString('base64url');
    const invitationId = randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60_000);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.manager(db, actorId);
      await this.tenant(db);
      const target = await db.query(
        "SELECT 1 FROM admin_user WHERE id=$1 AND state='LOCKED' FOR UPDATE",
        [targetId],
      );
      if (!target.rowCount) throw new ApiError(409, 'user_not_locked', 'Conflict');
      await db.query(
        'UPDATE admin_user_invitation SET consumed_at=now() WHERE admin_id=$1 AND consumed_at IS NULL',
        [targetId],
      );
      await db.query(
        'INSERT INTO admin_user_invitation(id,admin_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,$4,$5)',
        [invitationId, targetId, digest(token), actorId, expires],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'admin.user.invitation.reissue',
        outcome: 'success',
        correlationId: ref,
        metadata: { target_admin_id: targetId },
      });
      await db.query('COMMIT');
      return {
        invitation_id: invitationId,
        invitation_token: token,
        expires_at: expires.toISOString(),
      };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(actorId, ref, 'admin.user.invitation.reissue', error);
      throw error;
    } finally {
      db.release();
    }
  }

  private async change(
    actorId: string,
    targetId: string,
    requestId: string,
    action:
      | 'CAPABILITY_GRANT'
      | 'CAPABILITY_REVOKE'
      | 'TENANT_GRANT'
      | 'TENANT_REVOKE'
      | 'USER_REVOKE',
    payload: string,
    reason: string,
    apply: (db: PoolClient, tenantId: string) => Promise<void>,
  ): Promise<void> {
    if (
      !UUID.test(targetId) ||
      !UUID.test(requestId) ||
      !validReason(reason) ||
      actorId === targetId
    )
      throw invalid();
    const hash = digest(JSON.stringify({ action, payload, reason: reason.trim() }));
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.manager(db, actorId);
      const tenantId = await this.tenant(db);
      const prior = await db.query<{
        actor_id: string;
        target_admin_id: string;
        action: string;
        payload_digest: Buffer;
      }>(
        'SELECT actor_id,target_admin_id,action,payload_digest FROM admin_access_change WHERE request_id=$1 FOR UPDATE',
        [requestId],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (
          row.actor_id !== actorId ||
          row.target_admin_id !== targetId ||
          row.action !== action ||
          !row.payload_digest.equals(hash)
        )
          throw new ApiError(409, 'request_conflict', 'Conflict');
        await db.query('COMMIT');
        return;
      }
      const target = await db.query<{ state: string }>(
        'SELECT state FROM admin_user WHERE id=$1 FOR UPDATE',
        [targetId],
      );
      if (!target.rows[0] || (action !== 'USER_REVOKE' && target.rows[0].state === 'REVOKED'))
        throw new ApiError(404, 'user_missing', 'Not found');
      if (action === 'USER_REVOKE' && target.rows[0].state === 'REVOKED')
        throw new ApiError(409, 'user_revoked', 'Conflict');
      await apply(db, tenantId);
      await db.query(
        'INSERT INTO admin_access_change(request_id,actor_id,target_admin_id,action,payload_digest) VALUES($1,$2,$3,$4,$5)',
        [requestId, actorId, targetId, action, hash],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: `admin.access.${action.toLowerCase()}`,
        outcome: 'success',
        correlationId: requestId,
        metadata: { target_admin_id: targetId, tenant_id: tenantId },
      });
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(actorId, requestId, `admin.access.${action.toLowerCase()}`, error);
      throw error;
    } finally {
      db.release();
    }
  }

  async capabilities(
    actorId: string,
    targetId: string,
    requestId: string,
    action: 'GRANT' | 'REVOKE',
    permissions: string[],
    reason: string,
  ): Promise<void> {
    if (
      !Array.isArray(permissions) ||
      permissions.length < 1 ||
      permissions.length > ASSIGNABLE.size ||
      new Set(permissions).size !== permissions.length ||
      permissions.some((permission) => !ASSIGNABLE.has(permission))
    )
      throw invalid();
    const sorted = [...permissions].sort();
    await this.change(
      actorId,
      targetId,
      requestId,
      `CAPABILITY_${action}`,
      sorted.join(','),
      reason,
      async (db) => {
        for (const permission of sorted) {
          if (action === 'GRANT') {
            const current = await db.query(
              'SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission=$2 AND revoked_at IS NULL FOR UPDATE',
              [targetId, permission],
            );
            if (current.rowCount) throw new ApiError(409, 'capability_exists', 'Conflict');
            await db.query(
              'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$3,$4)',
              [targetId, permission, actorId, reason.trim()],
            );
          } else {
            const revoked = await db.query(
              'UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission=$2 AND revoked_at IS NULL',
              [targetId, permission],
            );
            if (!revoked.rowCount) throw new ApiError(409, 'capability_missing', 'Conflict');
          }
        }
      },
    );
  }

  async tenantAccess(
    actorId: string,
    targetId: string,
    requestId: string,
    action: 'GRANT' | 'REVOKE',
    reason: string,
  ): Promise<void> {
    await this.change(
      actorId,
      targetId,
      requestId,
      `TENANT_${action}`,
      'operating-tenant',
      reason,
      async (db, tenantId) => {
        for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access']) {
          if (action === 'GRANT') {
            const current = await db.query(
              `SELECT 1 FROM ${table} WHERE admin_id=$1 AND tenant_id=$2 AND revoked_at IS NULL FOR UPDATE`,
              [targetId, tenantId],
            );
            if (current.rowCount) throw new ApiError(409, 'tenant_access_exists', 'Conflict');
            await db.query(
              `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,$2,$3,$4)`,
              [targetId, tenantId, actorId, reason.trim()],
            );
          } else {
            const revoked = await db.query(
              `UPDATE ${table} SET revoked_at=now() WHERE admin_id=$1 AND tenant_id=$2 AND revoked_at IS NULL`,
              [targetId, tenantId],
            );
            if (!revoked.rowCount) throw new ApiError(409, 'tenant_access_missing', 'Conflict');
          }
        }
      },
    );
  }

  async revokeUser(
    actorId: string,
    targetId: string,
    requestId: string,
    reason: string,
  ): Promise<void> {
    await this.change(
      actorId,
      targetId,
      requestId,
      'USER_REVOKE',
      'account',
      reason,
      async (db) => {
        await db.query(
          "UPDATE admin_user SET state='REVOKED',version=version+1,updated_at=now() WHERE id=$1",
          [targetId],
        );
        await db.query(
          'UPDATE admin_session SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL',
          [targetId],
        );
        await db.query(
          'UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL',
          [targetId],
        );
        for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
          await db.query(
            `UPDATE ${table} SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL`,
            [targetId],
          );
        await db.query(
          'UPDATE admin_user_invitation SET consumed_at=now() WHERE admin_id=$1 AND consumed_at IS NULL',
          [targetId],
        );
        await db.query(
          "UPDATE recovery_request SET status='CANCELLED',code_hash=NULL WHERE admin_id=$1 AND status IN ('PENDING','AUTHORIZED')",
          [targetId],
        );
      },
    );
  }
}
