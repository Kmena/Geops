import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { diagnosticDigest, type DiagnosticSnapshot } from './device-diagnostics-contract.js';
import { evaluateDiagnostic } from './device-diagnostics-rules.js';
import type { DevicePrincipal } from './device-identity/session.js';
import { transaction } from './device-identity/repository.js';
import { ApiError } from './errors.js';
import { resolveGpsDeviceScope } from './gps-device-scope.js';
import { diagnosticMetrics, incrementDiagnosticMetric } from './logging.js';

interface StoredSnapshot {
  id: string;
  device_id: string;
  installation_id: string;
  tenant_id: string;
  observed_at: Date;
  received_at: Date;
  payload_digest: string;
  payload: DiagnosticSnapshot;
  last_communication_at: Date | null;
  desired_ownership: 'CORPORATE_MANAGED' | 'PERSONAL_BYOD' | 'UNVERIFIED' | null;
  tracking_authorized: boolean | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DeviceDiagnosticsService {
  private readonly communication = `GREATEST(s.received_at,
    (SELECT max(h.received_at) FROM gps_device_health_event h WHERE h.device_id=s.device_id AND h.tenant_id=s.tenant_id),
    (SELECT max(p.received_at) FROM position_event p WHERE p.device_id=s.device_id AND p.tenant_id=s.tenant_id),
    (SELECT max(e.received_at) FROM gps_session_event e WHERE e.device_id=s.device_id AND e.tenant_id=s.tenant_id)) AS last_communication_at`;
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(principal: DevicePrincipal, snapshot: DiagnosticSnapshot, correlationId: string) {
    const now = this.now();
    const observed = Date.parse(snapshot.observed_at);
    if (observed > now.getTime() + 5 * 60_000 || observed < now.getTime() - 30 * 86_400_000)
      throw new ApiError(422, 'diagnostic_time_out_of_range', 'Invalid request', true);
    return transaction(this.pool, async (db) => {
      const scope = await resolveGpsDeviceScope(db, principal.deviceId, snapshot.installation_id);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scope.installationId]);
      const digest = diagnosticDigest(snapshot);
      const previous = await db.query<{ id: string; payload_digest: string }>(
        `SELECT id,payload_digest FROM device_diagnostic_snapshot
         WHERE installation_id=$1 AND boot_id=$2 AND sequence=$3 FOR SHARE`,
        [scope.installationId, snapshot.boot_id, snapshot.sequence],
      );
      if (previous.rows[0]) return this.duplicate(previous.rows[0], digest);
      const quota = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM device_diagnostic_snapshot
         WHERE installation_id=$1 AND received_at>$2`,
        [scope.installationId, new Date(now.getTime() - 15 * 60_000)],
      );
      if (Number(quota.rows[0]?.count ?? 0) >= 30)
        throw new ApiError(429, 'diagnostic_rate_limited', 'Too many requests', true);
      const id = randomUUID();
      const findings = evaluateDiagnostic(snapshot, now, now);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO device_diagnostic_snapshot
         (id,device_id,installation_id,tenant_id,boot_id,sequence,schema_version,observed_at,
          received_at,app_version,manufacturer,model,android_release,android_api,payload_digest,payload,findings)
         VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (installation_id,boot_id,sequence) DO NOTHING RETURNING id`,
        [
          id,
          principal.deviceId,
          scope.installationId,
          scope.tenantId,
          snapshot.boot_id,
          snapshot.sequence,
          snapshot.observed_at,
          now,
          snapshot.app_version,
          snapshot.manufacturer,
          snapshot.model,
          snapshot.android_release,
          snapshot.android_api,
          digest,
          JSON.stringify(snapshot),
          JSON.stringify(findings),
        ],
      );
      if (!inserted.rowCount) {
        const concurrent = await db.query<{ id: string; payload_digest: string }>(
          `SELECT id,payload_digest FROM device_diagnostic_snapshot
           WHERE installation_id=$1 AND boot_id=$2 AND sequence=$3`,
          [scope.installationId, snapshot.boot_id, snapshot.sequence],
        );
        const row = concurrent.rows[0];
        if (!row) throw new Error('diagnostic_conflict_not_visible');
        return this.duplicate(row, digest);
      }
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: principal.deviceId,
        action: 'device.diagnostic.ingest',
        outcome: 'success',
        correlationId,
        metadata: { schema_version: 1 },
      });
      incrementDiagnosticMetric('received');
      return { snapshot_id: id, accepted_at: now.toISOString(), duplicate: false };
    });
  }

  private duplicate(row: { id: string; payload_digest: string }, digest: string) {
    if (row.payload_digest !== digest)
      throw new ApiError(409, 'diagnostic_sequence_conflict', 'Conflict', true);
    incrementDiagnosticMetric('duplicate');
    return { snapshot_id: row.id, accepted_at: null, duplicate: true };
  }

  private async adminTenant(adminId: string, deviceId: string, requestId: string): Promise<string> {
    if (!uuid.test(deviceId)) throw new ApiError(422, 'invalid_device_id', 'Invalid request');
    const rows = await this.pool.query<{ tenant_id: string }>(
      `SELECT DISTINCT owner.tenant_id FROM (
         SELECT customer_id AS tenant_id FROM mdm_binding WHERE geops_device_id=$2 AND state='ACTIVE'
         UNION SELECT tenant_id FROM geops_device_tenant WHERE device_id=$2
       ) owner
       JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
       JOIN admin_permission p ON p.admin_id=u.id AND p.permission='mdm.diagnostics.view' AND p.revoked_at IS NULL
       JOIN gps_data_tenant_access d ON d.admin_id=u.id AND d.tenant_id=owner.tenant_id AND d.revoked_at IS NULL
       JOIN gps_health_tenant_access h ON h.admin_id=u.id AND h.tenant_id=owner.tenant_id AND h.revoked_at IS NULL`,
      [adminId, deviceId],
    );
    if (rows.rows.length !== 1 || !rows.rows[0]) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'mdm.diagnostic.read',
        outcome: 'rejected',
        correlationId: requestId,
      });
      throw new ApiError(403, 'diagnostic_forbidden', 'Forbidden', true);
    }
    return rows.rows[0].tenant_id;
  }

  private view(row: StoredSnapshot) {
    return {
      snapshot_id: row.id,
      device_id: row.device_id,
      installation_id: row.installation_id,
      tenant_id: row.tenant_id,
      observed_at: row.observed_at.toISOString(),
      received_at: row.received_at.toISOString(),
      last_communication_at: row.last_communication_at?.toISOString() ?? null,
      payload: row.payload,
      findings: evaluateDiagnostic(
        row.payload,
        row.received_at,
        this.now(),
        row.last_communication_at,
        {
          ...(row.desired_ownership ? { ownership: row.desired_ownership } : {}),
          ...(row.tracking_authorized !== null
            ? { trackingAuthorized: row.tracking_authorized }
            : {}),
        },
      ),
      source: { permissions: 'ANDROID', execution: 'ANDROID', gps: 'GPS_V2_LOCAL' },
      applied_manageengine: 'UNKNOWN',
    };
  }

  async latest(adminId: string, deviceId: string, requestId: string) {
    const tenant = await this.adminTenant(adminId, deviceId, requestId);
    const result = await this.pool.query<StoredSnapshot>(
      `SELECT s.*,o.ownership AS desired_ownership,o.tracking_authorized, ${this.communication}
       FROM device_diagnostic_snapshot s LEFT JOIN gps_device_ownership o ON o.device_id=s.device_id
       WHERE s.tenant_id=$1 AND s.device_id=$2
       ORDER BY observed_at DESC,sequence DESC,received_at DESC,id DESC LIMIT 1`,
      [tenant, deviceId],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'mdm.diagnostic.read',
      outcome: 'success',
      correlationId: requestId,
    });
    return result.rows[0]
      ? this.view(result.rows[0])
      : {
          device_id: deviceId,
          tenant_id: tenant,
          snapshot_id: null,
          findings: evaluateDiagnostic(null, null, this.now()),
          applied_manageengine: 'UNKNOWN',
        };
  }

  async history(adminId: string, deviceId: string, requestId: string, limit: number) {
    const tenant = await this.adminTenant(adminId, deviceId, requestId);
    const result = await this.pool.query<StoredSnapshot>(
      `SELECT s.*,o.ownership AS desired_ownership,o.tracking_authorized, ${this.communication}
       FROM device_diagnostic_snapshot s LEFT JOIN gps_device_ownership o ON o.device_id=s.device_id
       WHERE s.tenant_id=$1 AND s.device_id=$2
       ORDER BY observed_at DESC,sequence DESC,received_at DESC,id DESC LIMIT $3`,
      [tenant, deviceId, limit],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'mdm.diagnostic.history',
      outcome: 'success',
      correlationId: requestId,
    });
    return { items: result.rows.map((row) => this.view(row)) };
  }

  async self(principal: DevicePrincipal) {
    return transaction(this.pool, async (db: PoolClient) => {
      const scope = await resolveGpsDeviceScope(db, principal.deviceId);
      const row = await db.query<StoredSnapshot>(
        `SELECT s.*,o.ownership AS desired_ownership,o.tracking_authorized, ${this.communication}
         FROM device_diagnostic_snapshot s LEFT JOIN gps_device_ownership o ON o.device_id=s.device_id
         WHERE s.device_id=$1 AND s.installation_id=$2 AND s.tenant_id=$3
         ORDER BY observed_at DESC,sequence DESC,received_at DESC,id DESC LIMIT 1`,
        [principal.deviceId, scope.installationId, scope.tenantId],
      );
      return row.rows[0]
        ? this.view(row.rows[0])
        : { snapshot_id: null, findings: evaluateDiagnostic(null, null, this.now()) };
    });
  }

  async fleet(adminId: string, requestId: string, mode: 'summary' | 'problems' | 'stale') {
    const permission = await this.pool.query(
      `SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id
       AND p.permission='mdm.diagnostics.view' AND p.revoked_at IS NULL
       WHERE u.id=$1 AND u.state='ACTIVE'`,
      [adminId],
    );
    if (!permission.rowCount) throw new ApiError(403, 'diagnostic_forbidden', 'Forbidden', true);
    const rows = await this.pool.query<StoredSnapshot>(
      `WITH allowed AS (
         SELECT d.tenant_id FROM admin_user u
         JOIN admin_permission p ON p.admin_id=u.id AND p.permission='mdm.diagnostics.view' AND p.revoked_at IS NULL
         JOIN gps_data_tenant_access d ON d.admin_id=u.id AND d.revoked_at IS NULL
         JOIN gps_health_tenant_access h ON h.admin_id=u.id AND h.tenant_id=d.tenant_id AND h.revoked_at IS NULL
         WHERE u.id=$1 AND u.state='ACTIVE'
       ) SELECT DISTINCT ON (s.tenant_id,s.device_id) s.*,o.ownership AS desired_ownership,
         o.tracking_authorized, ${this.communication}
       FROM device_diagnostic_snapshot s JOIN allowed a ON a.tenant_id=s.tenant_id
       LEFT JOIN gps_device_ownership o ON o.device_id=s.device_id
       ORDER BY s.tenant_id,s.device_id,s.observed_at DESC,s.sequence DESC,s.received_at DESC,s.id DESC LIMIT 500`,
      [adminId],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'mdm.diagnostic.fleet',
      outcome: 'success',
      correlationId: requestId,
    });
    const views = rows.rows.map((row) => this.view(row));
    if (mode === 'summary')
      return {
        as_of: this.now().toISOString(),
        denominator: views.length,
        truncated: views.length === 500,
        problem_devices: views.filter((v) =>
          v.findings.some(
            (f) => f.classification === 'CONFIRMED' || f.classification === 'POSSIBLE',
          ),
        ).length,
        stale_devices: views.filter((v) =>
          v.findings.some((f) => f.classification === 'STALE' || f.classification === 'OFFLINE'),
        ).length,
        permissions_missing: views.filter((v) =>
          v.findings.some((f) => f.code.includes('PERMISSION_MISSING')),
        ).length,
        capture_problems: views.filter((v) =>
          v.findings.some((f) => f.code === 'GPS_CAPTURE_STALE'),
        ).length,
        transmission_problems: views.filter((v) =>
          v.findings.some((f) => f.code === 'GPS_TRANSMISSION_STALE'),
        ).length,
        process_counters: diagnosticMetrics(),
      };
    return {
      as_of: this.now().toISOString(),
      truncated: views.length === 500,
      items: views
        .filter((v) =>
          v.findings.some((f) =>
            mode === 'stale'
              ? f.classification === 'STALE' || f.classification === 'OFFLINE'
              : f.classification === 'CONFIRMED' || f.classification === 'POSSIBLE',
          ),
        )
        .map((v) => ({
          device_id: v.device_id,
          tenant_id: v.tenant_id,
          observed_at: v.observed_at,
          received_at: v.received_at,
          findings: v.findings,
        })),
    };
  }
}
