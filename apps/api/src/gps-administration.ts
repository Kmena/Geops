import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';
import { requireInstallationAccess } from './device-identity/admin-scope.js';
import type { GpsPolicyService } from './gps-policy-service.js';

type TrackingOwnership = 'CORPORATE_MANAGED' | 'PERSONAL_BYOD' | 'UNVERIFIED';

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
      display_label: string;
      tenant_id: string;
      installation_id: string | null;
      assignment_version: string | null;
      ownership: 'CORPORATE_MANAGED' | 'PERSONAL_BYOD' | 'UNVERIFIED' | null;
      mdm_state: string | null;
      verification_source: string | null;
      ownership_valid_until: Date | null;
      ownership_version: string | null;
      tracking_authorized: boolean | null;
      privacy_notice_at: Date | null;
      last_location_at: Date | null;
      last_ack_at: Date | null;
      capture_state: string | null;
    }>(
      `SELECT d.id AS device_id,d.display_label,coalesce(b.customer_id,t.tenant_id) AS tenant_id,i.installation_id,
         s.assignment_version,o.ownership,o.mdm_state,o.verification_source,
         o.valid_until AS ownership_valid_until,o.version AS ownership_version,
         o.tracking_authorized,o.privacy_notice_at,
         loc.captured_at AS last_location_at,sync.last_ack_at,health.tracking_state AS capture_state
       FROM geops_device d
       LEFT JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state='ACTIVE'
       LEFT JOIN geops_device_tenant t ON t.device_id=d.id AND b.id IS NULL
       JOIN gps_data_tenant_access g ON g.tenant_id=coalesce(b.customer_id,t.tenant_id)
         AND g.admin_id=$1 AND g.revoked_at IS NULL
       LEFT JOIN gps_device_installation i ON i.device_id=d.id AND i.retired_at IS NULL
         AND i.activation_tenant_id=coalesce(b.customer_id,t.tenant_id)
         AND (i.activation_binding_id=b.id OR (b.id IS NULL AND i.activation_binding_id IS NULL))
       LEFT JOIN gps_device_assignment_state s ON s.device_id=d.id
       LEFT JOIN gps_device_ownership o ON o.device_id=d.id
       LEFT JOIN gps_sync_status sync ON sync.device_id=d.id
       LEFT JOIN LATERAL (SELECT captured_at FROM position_event
         WHERE device_id=d.id AND tenant_id=coalesce(b.customer_id,t.tenant_id)
         ORDER BY captured_at DESC LIMIT 1) loc ON true
       LEFT JOIN LATERAL (SELECT tracking_state FROM gps_device_health_event
         WHERE device_id=d.id AND tenant_id=coalesce(b.customer_id,t.tenant_id)
         ORDER BY observed_at DESC LIMIT 1) health ON true
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
        display_label: row.display_label,
        tenant_id: row.tenant_id,
        installation_id: row.installation_id,
        assignment_version: Number(row.assignment_version ?? 0),
        ownership: row.ownership ?? 'UNVERIFIED',
        mdm_state: row.mdm_state ?? 'UNKNOWN',
        verification_source: row.verification_source ?? 'NONE',
        ownership_valid_until: row.ownership_valid_until?.toISOString() ?? null,
        ownership_version: Number(row.ownership_version ?? 0),
        tracking_authorized: Boolean(
          row.tracking_authorized &&
            row.ownership_valid_until &&
            row.ownership_valid_until > new Date(),
        ),
        privacy_notice_at: row.privacy_notice_at?.toISOString() ?? null,
        last_location_at: row.last_location_at?.toISOString() ?? null,
        last_ack_at: row.last_ack_at?.toISOString() ?? null,
        capture_state: row.capture_state ?? 'UNKNOWN',
      })),
    };
  }

  async setTrackingAuthorization(
    adminId: string,
    requestId: string,
    deviceId: string,
    expectedVersion: number,
    payload: {
      ownership: TrackingOwnership;
      valid_until?: string;
      authorization_basis?: string;
      privacy_notice_at?: string;
      evidence_ref?: string;
      reason: string;
    },
  ): Promise<Record<string, unknown>> {
    if (!uuid.test(deviceId)) throw new ApiError(422, 'invalid_device', 'Invalid request');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw new ApiError(428, 'ownership_version_required', 'If-Match required');
    const authorized = payload.ownership !== 'UNVERIFIED';
    const until = authorized ? new Date(payload.valid_until ?? '') : null;
    const notice = authorized ? new Date(payload.privacy_notice_at ?? '') : null;
    if (
      authorized &&
      (!until ||
        !Number.isFinite(until.getTime()) ||
        until <= new Date() ||
        !notice ||
        !Number.isFinite(notice.getTime()) ||
        notice > new Date() ||
        typeof payload.authorization_basis !== 'string' ||
        payload.authorization_basis.trim().length < 8 ||
        payload.authorization_basis.length > 240 ||
        typeof payload.evidence_ref !== 'string' ||
        payload.evidence_ref.trim().length < 8 ||
        payload.evidence_ref.length > 240)
    )
      throw new ApiError(422, 'invalid_tracking_authorization', 'Invalid request');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.lockedCapability(db, adminId, 'gps.policy.assign');
      await requireInstallationAccess(db, adminId, 'synthetic');
      const device = await db.query<{ status: string; tenant_id: string | null }>(
        `SELECT d.status,coalesce(b.customer_id,t.tenant_id) AS tenant_id
         FROM geops_device d
         LEFT JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state='ACTIVE'
         LEFT JOIN geops_device_tenant t ON t.device_id=d.id AND b.id IS NULL
         WHERE d.id=$1 FOR UPDATE OF d`,
        [deviceId],
      );
      if (device.rows[0]?.status !== 'ACTIVE' || !device.rows[0].tenant_id)
        throw new ApiError(404, 'not_found', 'Not found');
      await requireInstallationAccess(db, adminId, device.rows[0].tenant_id);
      const prior = await db.query<{ version: string }>(
        'SELECT version FROM gps_device_ownership WHERE device_id=$1 FOR UPDATE',
        [deviceId],
      );
      const version = Number(prior.rows[0]?.version ?? 0);
      if (version !== expectedVersion)
        throw new ApiError(412, 'ownership_version_conflict', 'Conflict');
      let mdm: { region: string; customer_id: string; mdm_device_id: string } | undefined;
      if (payload.ownership === 'CORPORATE_MANAGED') {
        const found = await db.query<{
          region: string;
          customer_id: string;
          mdm_device_id: string;
        }>(
          `SELECT m.region,m.customer_id,m.mdm_device_id
            FROM mdm_inventory_device m
            WHERE m.geops_device_id=$1 AND m.provider='manageengine'
              AND m.status='managed' AND m.platform='android' AND NOT m.removed
              AND m.customer_id=$2 FOR SHARE`,
          [deviceId, device.rows[0].tenant_id],
        );
        if (found.rows.length !== 1 || !found.rows[0])
          throw new ApiError(409, 'mdm_verification_required', 'Conflict');
        mdm = found.rows[0];
      }
      if (payload.ownership === 'PERSONAL_BYOD') {
        const managed = await db.query(
          `SELECT 1 FROM mdm_inventory_device WHERE geops_device_id=$1
           AND provider='manageengine' AND status='managed' AND NOT removed
           UNION ALL SELECT 1 FROM mdm_binding WHERE geops_device_id=$1
           AND provider='manageengine' AND state='ACTIVE'`,
          [deviceId],
        );
        if (managed.rowCount) throw new ApiError(409, 'byod_mdm_conflict', 'Conflict');
      }
      const now = new Date();
      const values = [
        deviceId,
        payload.ownership,
        payload.ownership === 'CORPORATE_MANAGED'
          ? 'VERIFIED'
          : payload.ownership === 'PERSONAL_BYOD'
            ? 'NOT_APPLICABLE'
            : 'UNKNOWN',
        payload.ownership === 'CORPORATE_MANAGED'
          ? 'MANAGEENGINE'
          : payload.ownership === 'PERSONAL_BYOD'
            ? 'ADMIN_EVIDENCE'
            : 'NONE',
        authorized ? (payload.evidence_ref?.trim() ?? null) : null,
        authorized ? now : null,
        until,
        authorized,
        authorized ? (payload.authorization_basis?.trim() ?? null) : null,
        notice,
        version + 1,
        adminId,
        now,
        payload.reason,
      ];
      await db.query(
        `INSERT INTO gps_device_ownership(device_id,ownership,mdm_state,verification_source,
         evidence_ref,verified_at,valid_until,tracking_authorized,authorization_basis,
         privacy_notice_at,version,updated_by,updated_at,change_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(device_id) DO UPDATE SET ownership=$2,mdm_state=$3,
           verification_source=$4,evidence_ref=$5,verified_at=$6,valid_until=$7,
           tracking_authorized=$8,authorization_basis=$9,privacy_notice_at=$10,
           version=$11,updated_by=$12,updated_at=$13,change_reason=$14`,
        values,
      );
      if (payload.ownership === 'CORPORATE_MANAGED' && mdm) {
        await this.policies.activateMdmContinuous(
          db,
          deviceId,
          {
            region: mdm.region,
            customerId: mdm.customer_id,
            mdmDeviceId: mdm.mdm_device_id,
          },
          adminId,
        );
      } else {
        await this.policies.revokeMdmContinuous(db, deviceId, adminId);
      }
      // A new assignment version makes the authorization change visible to
      // Android's monotonic local policy engine, even if the policy is unchanged.
      await this.policies.rebuildDevice(db, deviceId, now);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'gps.tracking_authorization.set',
        outcome: 'success',
        correlationId: requestId,
        metadata: { ownership: payload.ownership, version: version + 1 },
      });
      await db.query('COMMIT');
      return {
        device_id: deviceId,
        ownership: payload.ownership,
        tracking_authorized: authorized,
        authorization_version: version + 1,
      };
    } catch (error) {
      await db.query('ROLLBACK');
      await this.rejected(adminId, requestId, 'gps.tracking_authorization.set', error);
      throw error;
    } finally {
      db.release();
    }
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
  app.put<{ Params: { id: string } }>(
    '/v1/admin/gps-devices/:id/tracking-authorization',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      const body = input(request.body, [
        'ownership',
        'valid_until',
        'authorization_basis',
        'privacy_notice_at',
        'evidence_ref',
        'reason',
      ]);
      if (!['CORPORATE_MANAGED', 'PERSONAL_BYOD', 'UNVERIFIED'].includes(String(body.ownership)))
        throw new ApiError(422, 'invalid_ownership', 'Invalid request');
      for (const field of [
        'valid_until',
        'authorization_basis',
        'privacy_notice_at',
        'evidence_ref',
      ])
        if (body[field] !== undefined && typeof body[field] !== 'string')
          throw new ApiError(422, 'invalid_tracking_authorization', 'Invalid request');
      if (
        body.ownership === 'UNVERIFIED' &&
        ['valid_until', 'authorization_basis', 'privacy_notice_at', 'evidence_ref'].some(
          (field) => body[field] !== undefined,
        )
      )
        throw new ApiError(422, 'invalid_tracking_authorization', 'Invalid request');
      const match = /^"(0|[1-9][0-9]*)"$/.exec(String(request.headers['if-match'] ?? ''));
      if (!match) throw new ApiError(428, 'ownership_version_required', 'If-Match required');
      return service.setTrackingAuthorization(
        admin.id,
        request.id,
        request.params.id,
        Number(match[1]),
        {
          ownership: body.ownership as TrackingOwnership,
          ...(body.valid_until !== undefined ? { valid_until: String(body.valid_until) } : {}),
          ...(body.authorization_basis !== undefined
            ? { authorization_basis: String(body.authorization_basis) }
            : {}),
          ...(body.privacy_notice_at !== undefined
            ? { privacy_notice_at: String(body.privacy_notice_at) }
            : {}),
          ...(body.evidence_ref !== undefined ? { evidence_ref: String(body.evidence_ref) } : {}),
          reason: reason(body.reason),
        },
      );
    },
  );
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
