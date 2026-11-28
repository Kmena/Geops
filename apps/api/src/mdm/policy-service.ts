import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAudit } from '../audit/index.js';
import type { DiagnosticSnapshot } from '../device-diagnostics-contract.js';
import type { DeviceDiagnosticsService } from '../device-diagnostics-service.js';
import { ApiError } from '../errors.js';
import { transaction } from '../device-identity/repository.js';
import { compareMdm } from './policy-comparison.js';
import type { MdmProfileDetail } from './policy-read.js';
import type { MdmTenantRuntime } from './tenant-runtime.js';
import { MdmWorkspaceService } from './workspace-service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface LinkRow {
  mdm_device_id: string;
  region: string;
  customer_id: string;
  status: string;
  removed: boolean;
  last_seen_at: Date;
}

export class MdmPolicyService {
  readonly workspace: MdmWorkspaceService;
  constructor(
    private readonly pool: Pool,
    private readonly diagnostics: DeviceDiagnosticsService,
    private readonly tenant?: MdmTenantRuntime,
  ) {
    this.workspace = new MdmWorkspaceService(pool, diagnostics);
  }

  private async permission(adminId: string, capability = 'mdm.policies.view'): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id
       AND p.permission=$2 AND p.revoked_at IS NULL
       WHERE u.id=$1 AND u.state='ACTIVE'`,
      [adminId, capability],
    );
    if (!result.rowCount) throw new ApiError(403, 'mdm_policy_forbidden', 'Forbidden');
  }

  async capabilities(adminId: string, requestId: string) {
    await this.permission(adminId);
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'mdm.capabilities.read',
      outcome: 'success',
      correlationId: requestId,
    });
    return {
      provider: 'manageengine',
      tenant_evidence: 'UNKNOWN',
      write_enabled: false,
      capabilities: [
        {
          key: 'device_inventory',
          state: 'DOCUMENTED_NOT_VERIFIED',
          scope: 'MDMOnDemand.MDMInventory.READ',
        },
        {
          key: 'device_profiles',
          state: 'DOCUMENTED_NOT_VERIFIED',
          scope: 'MDMOnDemand.MDMInventory.READ',
        },
        {
          key: 'device_apps',
          state: 'DOCUMENTED_NOT_VERIFIED',
          scope: 'MDMOnDemand.MDMInventory.READ',
        },
        {
          key: 'profile_details',
          state: 'DOCUMENTED_NOT_VERIFIED',
          scope: 'MDMOnDemand.MDMDeviceMgmt.READ',
        },
        {
          key: 'profile_association',
          state: 'DOCUMENTED_NOT_VERIFIED',
          scope: 'MDMOnDemand.MDMDeviceMgmt.CREATE',
        },
        { key: 'per_app_runtime_permission', state: 'UNKNOWN', scope: null },
        { key: 'battery_exemption', state: 'UNKNOWN', scope: null },
        { key: 'managed_app_configuration_update', state: 'UNKNOWN', scope: null },
      ],
    };
  }

  async device(adminId: string, deviceId: string, requestId: string) {
    if (!uuid.test(deviceId)) throw new ApiError(422, 'invalid_device_id', 'Invalid request');
    await this.permission(adminId);
    // Reuse Wave 2's device/tenant grants; a vendor inventory link does not grant access.
    const localView = await this.diagnostics.latest(adminId, deviceId, requestId);
    const tenantId = localView.tenant_id;
    const links = await this.pool.query<LinkRow>(
      `SELECT mdm_device_id,region,customer_id,status,removed,last_seen_at
       FROM mdm_inventory_device WHERE provider='manageengine' AND geops_device_id=$1`,
      [deviceId],
    );
    const legacy = await this.pool.query<{ mdm_device_id: string }>(
      `SELECT mdm_device_id FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE' LIMIT 1`,
      [deviceId],
    );
    const link = links.rows[0];
    const linkState = link
      ? /^[0-9]{1,30}$/.test(link.mdm_device_id) && !link.removed && link.status === 'managed'
        ? ('VALID' as const)
        : ('INVALID' as const)
      : legacy.rows[0] && !/^[0-9]{1,30}$/.test(legacy.rows[0].mdm_device_id)
        ? ('INVALID' as const)
        : ('MISSING' as const);
    let vendor = null;
    let readState: 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE' = 'UNKNOWN';
    if (linkState === 'VALID' && link && this.tenant) {
      try {
        const status = await this.tenant.status();
        if (
          status.authorized &&
          status.region === link.region &&
          status.customer_id === link.customer_id
        ) {
          vendor = await this.tenant.devicePolicies(link.mdm_device_id);
          readState = vendor ? 'AVAILABLE' : 'UNAVAILABLE';
        }
      } catch {
        readState = 'UNAVAILABLE';
      }
    }
    const local =
      'payload' in localView
        ? { payload: localView.payload as DiagnosticSnapshot, received_at: localView.received_at }
        : null;
    const ownership = await this.pool.query<{ ownership: string; tracking_authorized: boolean }>(
      'SELECT ownership,tracking_authorized FROM gps_device_ownership WHERE device_id=$1',
      [deviceId],
    );
    const agent = await this.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM agent_device_link WHERE device_id=$1 AND tenant_id=$2
       AND state='ACTIVE' AND valid_from<=now() AND valid_to IS NULL LIMIT 1`,
      [deviceId, tenantId],
    );
    const desired = {
      ownership: ownership.rows[0]?.ownership ?? 'UNVERIFIED',
      tracking_authorized: ownership.rows[0]?.tracking_authorized ?? false,
      profile_id: null,
      app_version: null,
    };
    const result = {
      device_id: deviceId,
      tenant_id: tenantId,
      agent_id: agent.rows[0]?.agent_id ?? null,
      installation_id: 'installation_id' in localView ? localView.installation_id : null,
      mdm_device_id: linkState === 'VALID' ? (link?.mdm_device_id ?? null) : null,
      link_state: linkState,
      read_state: readState,
      inventory_last_seen_at: link?.last_seen_at.toISOString() ?? null,
      desired,
      assigned: vendor?.profiles ?? { state: 'UNAVAILABLE', items: [] },
      applied_reported:
        vendor?.profiles.items.filter((p) => p.distribution === 'APPLIED_REPORTED') ?? [],
      effective_android: local?.payload.permissions ?? null,
      app: vendor?.apps.items.find((a) => a.package_name === 'com.geops.corporate') ?? null,
      vendor_fetched_at: vendor?.fetched_at ?? null,
      findings: compareMdm(linkState, vendor, local, {}),
      correction_actions: [
        {
          kind: 'ASSOCIATE_PROFILE',
          classification: 'INVESTIGATION_REQUIRED',
          enabled: false,
          reason: 'Tenant capability and target profile have not been verified',
        },
        {
          kind: 'ANDROID_RUNTIME_PERMISSION',
          classification: 'USER_ACTION_REQUIRED',
          enabled: false,
          reason: 'Per-app MDM API capability is unverified',
        },
      ],
    };
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'mdm.policy.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { link_state: linkState, read_state: readState },
    });
    return result;
  }

  async preview(adminId: string, deviceId: string, profileId: string, requestId: string) {
    await this.permission(adminId, 'mdm.permissions.remediate');
    if (!/^[0-9]{1,30}$/.test(profileId))
      throw new ApiError(422, 'invalid_profile_id', 'Invalid request');
    const current = await this.device(adminId, deviceId, requestId);
    const blocked = (reason: string) => ({
      device_id: deviceId,
      action: 'ASSOCIATE_PROFILE' as const,
      profile_id: profileId,
      eligible: false,
      classification: 'INVESTIGATION_REQUIRED' as const,
      reason,
      impact_device_count: null,
      preview_digest: null,
      write_enabled: false,
      tenant_id: current.tenant_id,
      mdm_device_id: null,
    });
    if (
      current.link_state !== 'VALID' ||
      current.read_state !== 'AVAILABLE' ||
      !current.mdm_device_id ||
      current.assigned.state !== 'AVAILABLE' ||
      !this.tenant
    )
      return blocked('MDM_DEVICE_OR_PROFILE_READ_UNVERIFIED');
    let profile: MdmProfileDetail | null;
    try {
      profile = await this.tenant.profileDetail(profileId);
    } catch {
      return blocked('MDM_PROFILE_DETAIL_UNAVAILABLE');
    }
    if (
      profile?.platform !== 'ANDROID' ||
      !profile.published ||
      profile.trashed ||
      profile.version === null
    )
      return blocked('MDM_PROFILE_NOT_PUBLISHED_ANDROID');
    if (current.assigned.items.some((item) => item.profile_id === profileId))
      return blocked('MDM_PROFILE_ALREADY_ASSIGNED');
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          deviceId,
          mdmId: current.mdm_device_id,
          profileId,
          profileVersion: profile.version,
          tenantId: current.tenant_id,
          assigned: current.assigned.items.map((p) => p.profile_id).sort(),
        }),
      )
      .digest('hex');
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'mdm.remediation.preview',
      outcome: 'success',
      correlationId: requestId,
      metadata: { action: 'ASSOCIATE_PROFILE', impact_device_count: 1 },
    });
    return {
      device_id: deviceId,
      action: 'ASSOCIATE_PROFILE' as const,
      profile_id: profileId,
      eligible: true,
      classification: 'CONSOLE_ACTION_REQUIRED' as const,
      reason:
        'Vendor writes remain disabled until tenant, scope and lab authorization are verified',
      impact_device_count: 1,
      preview_digest: digest,
      write_enabled: false,
      profile_version: profile.version,
      tenant_id: current.tenant_id,
      mdm_device_id: current.mdm_device_id,
    };
  }

  async requestRemediation(
    adminId: string,
    deviceId: string,
    profileId: string,
    previewDigest: string,
    idempotencyKey: string,
    reason: string,
    requestId: string,
  ) {
    await this.permission(adminId, 'mdm.permissions.remediate');
    if (
      !/^[0-9a-f]{64}$/.test(previewDigest) ||
      !/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey) ||
      reason.trim().length < 8 ||
      reason.length > 240
    )
      throw new ApiError(422, 'invalid_remediation_request', 'Invalid request');
    // A retry must still satisfy current device ownership and tenant grants.
    await this.diagnostics.latest(adminId, deviceId, requestId);
    const prior = await this.pool.query<{ id: string; preview_digest: string; state: string }>(
      'SELECT id,preview_digest,state FROM mdm_remediation_request WHERE requested_by=$1 AND idempotency_key=$2',
      [adminId, idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].preview_digest !== previewDigest)
        throw new ApiError(409, 'remediation_idempotency_conflict', 'Conflict');
      return { request_id: prior.rows[0].id, state: prior.rows[0].state, duplicate: true };
    }
    const preview = await this.preview(adminId, deviceId, profileId, requestId);
    if (!preview.eligible || preview.preview_digest !== previewDigest || !preview.mdm_device_id)
      throw new ApiError(409, 'remediation_preview_changed', 'Conflict');
    const id = randomUUID();
    const result = await transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${adminId}:${idempotencyKey}`,
      ]);
      const again = await db.query<{ id: string; preview_digest: string; state: string }>(
        'SELECT id,preview_digest,state FROM mdm_remediation_request WHERE requested_by=$1 AND idempotency_key=$2',
        [adminId, idempotencyKey],
      );
      if (again.rows[0]) {
        if (again.rows[0].preview_digest !== previewDigest)
          throw new ApiError(409, 'remediation_idempotency_conflict', 'Conflict');
        return { request_id: again.rows[0].id, state: again.rows[0].state, duplicate: true };
      }
      await db.query(
        `INSERT INTO mdm_remediation_request
         (id,tenant_id,device_id,mdm_device_id,action,profile_id,state,preview_digest,
          idempotency_key,impact_device_count,reason,requested_by,expires_at)
         VALUES($1,$2,$3,$4,'ASSOCIATE_PROFILE',$5,'AWAITING_APPROVAL',$6,$7,1,$8,$9,now()+interval '5 minutes')`,
        [
          id,
          preview.tenant_id,
          deviceId,
          preview.mdm_device_id,
          profileId,
          previewDigest,
          idempotencyKey,
          reason.trim(),
          adminId,
        ],
      );
      await db.query(
        `INSERT INTO mdm_remediation_event(id,request_id,state,actor_id)
         VALUES($1,$2,'AWAITING_APPROVAL',$3)`,
        [randomUUID(), id, adminId],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'mdm.remediation.request',
        outcome: 'success',
        correlationId: requestId,
        metadata: { state: 'AWAITING_APPROVAL', action: 'ASSOCIATE_PROFILE' },
      });
      return { request_id: id, state: 'AWAITING_APPROVAL', duplicate: false };
    });
    return result;
  }

  async remediationHistory(adminId: string, deviceId: string, requestId: string) {
    await this.permission(adminId, 'mdm.audit.view');
    const local = await this.diagnostics.latest(adminId, deviceId, requestId);
    const rows = await this.pool.query(
      `SELECT id,action,profile_id,state,impact_device_count,requested_at,updated_at,expires_at,error_code
       FROM mdm_remediation_request WHERE tenant_id=$1 AND device_id=$2
       ORDER BY requested_at DESC,id DESC LIMIT 50`,
      [local.tenant_id, deviceId],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'mdm.remediation.history',
      outcome: 'success',
      correlationId: requestId,
    });
    return { items: rows.rows };
  }

  async submit(adminId: string, remediationId: string, requestId: string) {
    await this.permission(adminId, 'mdm.permissions.remediate');
    if (!uuid.test(remediationId)) throw new ApiError(422, 'invalid_request_id', 'Invalid request');
    const row = await this.pool.query<{ device_id: string }>(
      'SELECT device_id FROM mdm_remediation_request WHERE id=$1',
      [remediationId],
    );
    if (!row.rows[0]) throw new ApiError(404, 'remediation_not_found', 'Not found');
    const deviceId = row.rows[0].device_id;
    await this.diagnostics.latest(adminId, deviceId, requestId);
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'mdm.remediation.submit',
      outcome: 'rejected',
      correlationId: requestId,
      metadata: { code: 'mdm_write_disabled' },
    });
    throw new ApiError(503, 'mdm_write_disabled', 'MDM write unavailable');
  }
}
