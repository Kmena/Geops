import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';
import { requireInstallationAccess } from './device-identity/admin-scope.js';
import type { GpsPolicyService } from './gps-policy-service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function input(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return body;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 240)
    throw new ApiError(422, 'invalid_reason', 'Invalid request');
  return value.trim();
}

export class GpsAdministrationService {
  constructor(
    private readonly pool: Pool,
    private readonly policies: GpsPolicyService,
  ) {}

  private async rejected(
    adminId: string,
    requestId: string,
    action: string,
    error: unknown,
  ): Promise<void> {
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action,
      outcome: 'rejected',
      correlationId: requestId,
      metadata: { code: error instanceof ApiError ? error.code : 'dependency_unavailable' },
    }).catch(() => {});
  }

  private async lockedCapability(
    db: PoolClient,
    adminId: string,
    capability: string,
  ): Promise<void> {
    const found = await db.query(
      'SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission=$2 AND revoked_at IS NULL FOR SHARE',
      [adminId, capability],
    );
    if (!found.rowCount) throw new ApiError(403, 'gps_forbidden', 'Forbidden');
  }

  async capabilities(
    adminId: string,
    requestId: string,
  ): Promise<{ capabilities: string[]; tenant_ids: string[] }> {
    const rows = await this.pool.query<{ permission: string }>(
      "SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL AND permission LIKE 'gps.%' ORDER BY permission",
      [adminId],
    );
    const tenants = await this.pool.query<{ tenant_id: string }>(
      `SELECT d.tenant_id FROM gps_data_tenant_access d
       JOIN gps_health_tenant_access h ON h.admin_id=d.admin_id AND h.tenant_id=d.tenant_id AND h.revoked_at IS NULL
       WHERE d.admin_id=$1 AND d.revoked_at IS NULL ORDER BY d.tenant_id`,
      [adminId],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'gps.capabilities.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: rows.rowCount ?? 0 },
    });
    return {
      capabilities: rows.rows.map((row) => row.permission),
      tenant_ids: tenants.rows.map((row) => row.tenant_id),
    };
  }

  async devices(adminId: string, requestId: string): Promise<{ items: Record<string, unknown>[] }> {
    await this.policies.requireCapability(adminId, 'gps.session.read', requestId);
    const rows = await this.pool.query<{
      device_id: string;
      tenant_id: string;
      installation_id: string | null;
      assignment_version: string | null;
    }>(
      `SELECT d.id AS device_id,b.customer_id AS tenant_id,i.installation_id,
         s.assignment_version FROM geops_device d
       JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state='ACTIVE'
       JOIN gps_data_tenant_access g ON g.tenant_id=b.customer_id
         AND g.admin_id=$1 AND g.revoked_at IS NULL
       LEFT JOIN gps_device_installation i ON i.device_id=d.id AND i.retired_at IS NULL
       LEFT JOIN gps_device_assignment_state s ON s.device_id=d.id
       WHERE d.status='ACTIVE' ORDER BY d.id LIMIT 100`,
      [adminId],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'gps.devices.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: rows.rowCount ?? 0 },
    });
    return {
      items: rows.rows.map((row) => ({
        device_id: row.device_id,
        tenant_id: row.tenant_id,
        installation_id: row.installation_id,
        assignment_version: Number(row.assignment_version ?? 0),
      })),
    };
  }

  async activate(
    adminId: string,
    requestId: string,
    deviceId: string,
    why: string,
  ): Promise<Record<string, unknown>> {
    if (!uuid.test(deviceId)) throw new ApiError(422, 'invalid_device', 'Invalid request');
    await this.policies.requireCapability(adminId, 'gps.installation.manage', requestId);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.lockedCapability(db, adminId, 'gps.installation.manage');
      await requireInstallationAccess(db, adminId, 'synthetic');
      const device = await db.query<{ status: string }>(
        'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
        [deviceId],
      );
      if (device.rows[0]?.status !== 'ACTIVE') throw new ApiError(404, 'not_found', 'Not found');
      const binding = await db.query<{ id: string; customer_id: string }>(
        "SELECT id,customer_id FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE' FOR SHARE",
        [deviceId],
      );
      const activeBinding = binding.rows[0];
      if (binding.rows.length !== 1 || !activeBinding)
        throw new ApiError(409, 'binding_conflict', 'Conflict');
      await requireInstallationAccess(db, adminId, activeBinding.customer_id);
      const installed = await db.query(
        'SELECT 1 FROM gps_device_installation WHERE device_id=$1 AND retired_at IS NULL FOR UPDATE',
        [deviceId],
      );
      if (installed.rowCount) throw new ApiError(409, 'installation_exists', 'Conflict');
      const installationId = randomUUID();
      await db.query(
        `INSERT INTO gps_device_installation(installation_id,device_id,activated_at,
         activation_binding_id,activation_tenant_id) VALUES($1,$2,now(),$3,$4)`,
        [installationId, deviceId, activeBinding.id, activeBinding.customer_id],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'gps.installation.activate',
        outcome: 'success',
        correlationId: requestId,
        metadata: { reason: why, installation_id: installationId },
      });
      await db.query('COMMIT');
      return { installation_id: installationId, device_id: deviceId, state: 'ACTIVE' };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(adminId, requestId, 'gps.installation.activate', error);
      throw error;
    } finally {
      db.release();
    }
  }

  async retire(
    adminId: string,
    requestId: string,
    installationId: string,
    why: string,
  ): Promise<void> {
    if (!uuid.test(installationId))
      throw new ApiError(422, 'invalid_installation', 'Invalid request');
    await this.policies.requireCapability(adminId, 'gps.installation.manage', requestId);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.lockedCapability(db, adminId, 'gps.installation.manage');
      await requireInstallationAccess(db, adminId, 'synthetic');
      const row = await db.query<{ device_id: string; activation_tenant_id: string }>(
        'SELECT device_id,activation_tenant_id FROM gps_device_installation WHERE installation_id=$1 AND retired_at IS NULL FOR UPDATE',
        [installationId],
      );
      if (!row.rows[0]) throw new ApiError(404, 'not_found', 'Not found');
      await requireInstallationAccess(db, adminId, row.rows[0].activation_tenant_id);
      await db.query(
        'UPDATE gps_device_installation SET retired_at=now() WHERE installation_id=$1',
        [installationId],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId: row.rows[0].device_id,
        action: 'gps.installation.retire',
        outcome: 'success',
        correlationId: requestId,
        metadata: { reason: why, installation_id: installationId },
      });
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(adminId, requestId, 'gps.installation.retire', error);
      throw error;
    } finally {
      db.release();
    }
  }

  async proposeGrant(
    adminId: string,
    requestId: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const data = input(body, ['request_id', 'target_admin_id', 'tenant_id', 'action', 'reason']);
    if (
      typeof data.request_id !== 'string' ||
      !uuid.test(data.request_id) ||
      typeof data.target_admin_id !== 'string' ||
      !uuid.test(data.target_admin_id) ||
      typeof data.tenant_id !== 'string' ||
      data.tenant_id.length < 1 ||
      data.tenant_id.length > 256 ||
      (data.action !== 'GRANT' && data.action !== 'REVOKE')
    )
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    const why = reason(data.reason);
    await this.policies.requireCapability(adminId, 'gps.tenant.grant', requestId);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          target_admin_id: data.target_admin_id,
          tenant_id: data.tenant_id,
          action: data.action,
          reason: why,
        }),
      )
      .digest();
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.lockedCapability(db, adminId, 'gps.tenant.grant');
      const prior = await db.query<{
        proposed_by: string;
        payload_digest: Buffer;
        approved_at: Date | null;
      }>(
        'SELECT proposed_by,payload_digest,approved_at FROM gps_tenant_grant_request WHERE id=$1 FOR UPDATE',
        [data.request_id],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].proposed_by !== adminId || !prior.rows[0].payload_digest.equals(hash))
          throw new ApiError(409, 'request_conflict', 'Conflict');
        await db.query('COMMIT');
        return {
          request_id: data.request_id,
          state: prior.rows[0].approved_at ? 'APPROVED' : 'PENDING',
        };
      }
      const target = await db.query("SELECT 1 FROM admin_user WHERE id=$1 AND state='ACTIVE'", [
        data.target_admin_id,
      ]);
      const operating = await db.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM geops_operating_tenant WHERE singleton=true',
      );
      if (operating.rows[0] && operating.rows[0].tenant_id !== data.tenant_id)
        throw new ApiError(403, 'gps_forbidden', 'Forbidden');
      const tenant = await db.query(
        "SELECT 1 FROM mdm_binding WHERE customer_id=$1 AND (state='ACTIVE' OR (customer_id='synthetic' AND provider='fake' AND state='PENDING')) LIMIT 1",
        [data.tenant_id],
      );
      if (!target.rowCount || !tenant.rowCount)
        throw new ApiError(422, 'grant_target_invalid', 'Invalid request');
      await db.query(
        `INSERT INTO gps_tenant_grant_request(id,proposed_by,target_admin_id,tenant_id,action,reason,payload_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [data.request_id, adminId, data.target_admin_id, data.tenant_id, data.action, why, hash],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'gps.tenant-grant.propose',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          request_id: String(data.request_id),
          action: String(data.action),
          tenant_id: data.tenant_id,
        },
      });
      await db.query('COMMIT');
      return { request_id: data.request_id, state: 'PENDING' };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(adminId, requestId, 'gps.tenant-grant.propose', error);
      throw error;
    } finally {
      db.release();
    }
  }

  async approveGrant(
    adminId: string,
    requestId: string,
    grantId: string,
  ): Promise<Record<string, unknown>> {
    if (!uuid.test(grantId)) throw new ApiError(422, 'invalid_request', 'Invalid request');
    await this.policies.requireCapability(adminId, 'gps.tenant.grant', requestId);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.lockedCapability(db, adminId, 'gps.tenant.grant');
      const request = await db.query<{
        proposed_by: string;
        target_admin_id: string;
        tenant_id: string;
        action: 'GRANT' | 'REVOKE';
        reason: string;
        proposed_at: Date;
        approved_at: Date | null;
        approved_by: string | null;
      }>('SELECT * FROM gps_tenant_grant_request WHERE id=$1 FOR UPDATE', [grantId]);
      const row = request.rows[0];
      if (!row) throw new ApiError(404, 'not_found', 'Not found');
      if (row.proposed_by === adminId)
        throw new ApiError(403, 'second_approver_required', 'Forbidden');
      if (row.proposed_at.getTime() < Date.now() - 86_400_000)
        throw new ApiError(410, 'grant_request_expired', 'Gone');
      if (row.approved_at) {
        if (row.approved_by !== adminId) throw new ApiError(409, 'already_approved', 'Conflict');
        await db.query('COMMIT');
        return { request_id: grantId, state: 'APPROVED' };
      }
      const target = await db.query(
        "SELECT 1 FROM admin_user WHERE id=$1 AND state='ACTIVE' FOR SHARE",
        [row.target_admin_id],
      );
      if (!target.rowCount) throw new ApiError(409, 'target_inactive', 'Conflict');
      if (row.action === 'GRANT') {
        const operating = await db.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM geops_operating_tenant WHERE singleton=true',
        );
        if (operating.rows[0] && operating.rows[0].tenant_id !== row.tenant_id)
          throw new ApiError(403, 'gps_forbidden', 'Forbidden');
        const tenant = await db.query(
          "SELECT 1 FROM mdm_binding WHERE customer_id=$1 AND (state='ACTIVE' OR (customer_id='synthetic' AND provider='fake' AND state='PENDING')) LIMIT 1",
          [row.tenant_id],
        );
        if (!tenant.rowCount) throw new ApiError(409, 'tenant_inactive', 'Conflict');
      }
      for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access']) {
        if (row.action === 'GRANT') {
          const prior = await db.query(
            `SELECT 1 FROM ${table} WHERE admin_id=$1 AND tenant_id=$2 AND revoked_at IS NULL FOR UPDATE`,
            [row.target_admin_id, row.tenant_id],
          );
          if (prior.rowCount) throw new ApiError(409, 'grant_exists', 'Conflict');
          await db.query(
            `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,$2,$3,$4)`,
            [row.target_admin_id, row.tenant_id, adminId, row.reason],
          );
        } else {
          const revoked = await db.query(
            `UPDATE ${table} SET revoked_at=now() WHERE admin_id=$1 AND tenant_id=$2 AND revoked_at IS NULL`,
            [row.target_admin_id, row.tenant_id],
          );
          if (!revoked.rowCount) throw new ApiError(409, 'grant_missing', 'Conflict');
        }
      }
      await db.query(
        'UPDATE gps_tenant_grant_request SET approved_by=$2,approved_at=now() WHERE id=$1',
        [grantId, adminId],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'gps.tenant-grant.approve',
        outcome: 'success',
        correlationId: requestId,
        metadata: { request_id: grantId, action: row.action, tenant_id: row.tenant_id },
      });
      await db.query('COMMIT');
      return { request_id: grantId, state: 'APPROVED' };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(adminId, requestId, 'gps.tenant-grant.approve', error);
      throw error;
    } finally {
      db.release();
    }
  }
}

export function registerGpsAdministrationRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: GpsAdministrationService,
): void {
  app.get('/v1/admin/gps-capabilities', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.capabilities(admin.id, request.id);
  });
  app.get('/v1/admin/gps-devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.devices(admin.id, request.id);
  });
  app.post('/v1/admin/gps-installations', async (request, reply) => {
    const admin = await requireAdmin(request, auth, true);
    const body = input(request.body, ['device_id', 'reason']);
    const result = await service.activate(
      admin.id,
      request.id,
      String(body.device_id),
      reason(body.reason),
    );
    reply.code(201);
    return result;
  });
  app.post<{ Params: { id: string } }>(
    '/v1/admin/gps-installations/:id/retire',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth, true);
      const body = input(request.body, ['reason']);
      await service.retire(admin.id, request.id, request.params.id, reason(body.reason));
      reply.code(204);
      return undefined;
    },
  );
  app.post('/v1/admin/gps-tenant-grants/proposals', async (request, reply) => {
    const admin = await requireAdmin(request, auth, true);
    const result = await service.proposeGrant(admin.id, request.id, request.body);
    reply.code(result.state === 'PENDING' ? 201 : 200);
    return result;
  });
  app.post<{ Params: { id: string } }>(
    '/v1/admin/gps-tenant-grants/:id/approve',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      if (request.body && Object.keys(input(request.body, [])).length)
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      return service.approveGrant(admin.id, request.id, request.params.id);
    },
  );
}
