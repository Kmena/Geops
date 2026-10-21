import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';

export type ContinuityReason = 'CAPTURE_STALE' | 'COMMUNICATION_MISSING';
export type ContinuitySeverity = 'WARNING' | 'CRITICAL';

interface WindowRow {
  id: string;
  device_id: string;
  tenant_id: string;
  mdm_binding_id: string;
  installation_id: string;
  assignment_version: string;
  start_at: Date;
  end_at: Date;
  changed_at: Date;
  warning_after_s: number;
  critical_after_s: number;
  start_grace_s: number;
  policy_grace_s: number;
}

interface EvidenceRow {
  last_position_captured_at: Date | null;
  last_position_received_at: Date | null;
  last_health_observed_at: Date | null;
  last_health_received_at: Date | null;
  observed_tracking_state: 'RUNNING' | 'STOPPED' | null;
  last_session_received_at: Date | null;
  last_config_fetched_at: Date | null;
  last_batch_persisted_at: Date | null;
}

interface OpenAlert {
  id: string;
  tenant_id: string;
  device_id: string;
  mdm_binding_id: string;
  installation_id: string;
  scheduled_session_id: string;
  reason_code: ContinuityReason;
  severity: ContinuitySeverity;
  end_at: Date;
  device_status: string;
  binding_state: string;
}

interface AlertPageRow {
  id: string;
  device_id: string;
  scheduled_session_id: string;
  reason_code: ContinuityReason;
  severity: ContinuitySeverity;
  source: 'SERVER_INFERENCE';
  opened_at: Date;
  updated_at: Date;
  evaluated_at: Date | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  evidence_at: Date | null;
  age_s: number;
  threshold_s: number;
  last_position_captured_at: Date | null;
  last_position_received_at: Date | null;
  last_health_observed_at: Date | null;
  last_health_received_at: Date | null;
  observed_tracking_state: 'RUNNING' | 'STOPPED' | null;
}

export interface ContinuityDecision {
  reason_code: ContinuityReason;
  severity: ContinuitySeverity;
  evidence_at: Date | null;
  age_s: number;
  threshold_s: number;
}

export interface ContinuityRun {
  skipped: boolean;
  evaluated: number;
  opened: number;
  changed: number;
  resolved: number;
}

export interface ContinuityThresholds {
  warning_after_s: number;
  critical_after_s: number;
  start_grace_s: number;
  policy_grace_s: number;
}

export interface ContinuityAlertFilters {
  device_id?: string;
  status?: 'OPEN' | 'RESOLVED' | 'ALL';
  severity?: ContinuitySeverity;
  reason_code?: ContinuityReason;
  opened_from?: string;
  opened_before?: string;
  limit?: number;
  cursor?: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const stamp = (value: Date | null) => value?.toISOString() ?? null;

const seconds = (later: Date, earlier: Date) =>
  Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 1000));

function latest(...dates: (Date | null)[]): Date | null {
  const present = dates.filter((value): value is Date => value !== null);
  return present.length ? new Date(Math.max(...present.map((value) => value.getTime()))) : null;
}

/** Pure inference. A recent upload is communication, not proof of a recent capture. */
export function inferContinuity(
  now: Date,
  window: Pick<
    WindowRow,
    | 'start_at'
    | 'end_at'
    | 'changed_at'
    | 'warning_after_s'
    | 'critical_after_s'
    | 'start_grace_s'
    | 'policy_grace_s'
  >,
  evidence: EvidenceRow,
): ContinuityDecision | null {
  const time = now.getTime();
  if (time < window.start_at.getTime() || time >= window.end_at.getTime()) return null;
  const graceEnd = Math.max(
    window.start_at.getTime() + window.start_grace_s * 1000,
    window.changed_at.getTime() > window.start_at.getTime()
      ? window.changed_at.getTime() + window.policy_grace_s * 1000
      : window.start_at.getTime(),
  );
  if (time < graceEnd) return null;

  const communication = latest(
    evidence.last_position_received_at,
    evidence.last_health_received_at,
    evidence.last_session_received_at,
    evidence.last_config_fetched_at,
  );
  const communicationBase = latest(window.start_at, communication);
  const captureBase = latest(window.start_at, evidence.last_position_captured_at);
  if (!communicationBase || !captureBase) return null;
  const communicationAge = seconds(now, communicationBase);
  const captureAge = seconds(now, captureBase);
  const reason: ContinuityReason | null =
    communicationAge >= window.warning_after_s
      ? 'COMMUNICATION_MISSING'
      : captureAge >= window.warning_after_s
        ? 'CAPTURE_STALE'
        : null;
  if (!reason) return null;
  const age = reason === 'COMMUNICATION_MISSING' ? communicationAge : captureAge;
  return {
    reason_code: reason,
    severity: age >= window.critical_after_s ? 'CRITICAL' : 'WARNING',
    evidence_at:
      reason === 'COMMUNICATION_MISSING' ? communication : evidence.last_position_captured_at,
    age_s: age,
    threshold_s: age >= window.critical_after_s ? window.critical_after_s : window.warning_after_s,
  };
}

/** Runs independently of admin reads. Shares the scheduler lock for policy transitions. */
export class GpsContinuityMonitor {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly cursorKey: Buffer = randomBytes(32),
  ) {}

  async auditRejectedRead(adminId: string, requestId: string, code: string): Promise<void> {
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'gps.continuity.alert.read',
      outcome: 'rejected',
      correlationId: requestId,
      metadata: { code },
    });
  }

  async tick(): Promise<ContinuityRun> {
    const db = await this.pool.connect();
    const result: ContinuityRun = {
      skipped: false,
      evaluated: 0,
      opened: 0,
      changed: 0,
      resolved: 0,
    };
    try {
      await db.query('BEGIN');
      const lock = await db.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext('geops-gps-scheduler-v1')) AS acquired",
      );
      if (!lock.rows[0]?.acquired) {
        await db.query('ROLLBACK');
        return { ...result, skipped: true };
      }
      const at = this.now();
      await db.query(
        "DELETE FROM gps_continuity_read_quota WHERE minute_bucket < $1::timestamptz - INTERVAL '24 hours'",
        [at],
      );
      const windows = await db.query<WindowRow>(
        `SELECT s.id,s.device_id,b.customer_id AS tenant_id,b.id AS mdm_binding_id,
           i.installation_id,
           s.assignment_version,s.start_at,s.end_at,ds.changed_at,
           COALESCE(t.warning_after_s,300) AS warning_after_s,
           COALESCE(t.critical_after_s,600) AS critical_after_s,
           COALESCE(t.start_grace_s,300) AS start_grace_s,
           COALESCE(t.policy_grace_s,300) AS policy_grace_s
         FROM gps_scheduled_session s
         JOIN geops_device d ON d.id=s.device_id AND d.status='ACTIVE'
         JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state='ACTIVE'
         JOIN gps_device_installation i ON i.device_id=d.id AND i.retired_at IS NULL
         JOIN gps_device_assignment_state ds ON ds.device_id=d.id
         JOIN gps_effective_assignment a ON a.device_id=d.id AND a.superseded_at IS NULL
           AND a.policy_id=s.policy_id AND a.revision=s.revision
           AND a.assignment_version=s.assignment_version AND a.effective_range @> $1::timestamptz
         JOIN gps_policy p ON p.id=s.policy_id AND p.state='ACTIVE'
         LEFT JOIN gps_continuity_threshold t ON t.tenant_id=b.customer_id
         WHERE s.state='SCHEDULED' AND s.start_at<=$1 AND $1<s.end_at
         ORDER BY b.customer_id,s.device_id,s.start_at DESC`,
        [at],
      );
      const identity = (row: {
        scheduled_session_id?: string;
        id?: string;
        tenant_id: string;
        mdm_binding_id: string;
        installation_id: string;
      }) =>
        `${row.scheduled_session_id ?? row.id}|${row.tenant_id}|${row.mdm_binding_id}|${row.installation_id}`;
      const current = new Set(windows.rows.map(identity));
      const open = await db.query<OpenAlert>(
        `SELECT a.id,a.tenant_id,a.device_id,a.mdm_binding_id,a.installation_id,a.scheduled_session_id,
           a.reason_code,a.severity,
           s.end_at,d.status AS device_status,b.state AS binding_state
         FROM gps_continuity_alert a
         JOIN gps_scheduled_session s ON s.id=a.scheduled_session_id
         JOIN geops_device d ON d.id=a.device_id
         JOIN mdm_binding b ON b.id=a.mdm_binding_id
         WHERE a.resolved_at IS NULL FOR UPDATE OF a`,
      );
      const active = new Map(open.rows.map((row) => [identity(row), row]));
      for (const alert of open.rows) {
        if (current.has(identity(alert))) continue;
        const replacedInstallation = windows.rows.some(
          (window) =>
            window.device_id === alert.device_id &&
            window.tenant_id === alert.tenant_id &&
            window.mdm_binding_id === alert.mdm_binding_id &&
            window.installation_id !== alert.installation_id,
        );
        const resolution =
          alert.end_at.getTime() <= at.getTime()
            ? 'WINDOW_ENDED'
            : alert.device_status !== 'ACTIVE' || alert.binding_state !== 'ACTIVE'
              ? 'DEVICE_INACTIVE'
              : replacedInstallation
                ? 'INSTALLATION_CHANGED'
                : 'POLICY_CHANGED';
        await this.resolve(db, alert, resolution, at);
        result.resolved++;
      }
      for (const window of windows.rows) {
        result.evaluated++;
        const evidence = await this.evidence(db, window, at);
        const decision = inferContinuity(at, window, evidence);
        const prior = active.get(identity(window));
        if (!decision) {
          if (prior) {
            await this.resolve(db, prior, 'EVIDENCE_RECOVERED', at);
            result.resolved++;
          }
          continue;
        }
        if (prior && prior.reason_code !== decision.reason_code) {
          await this.resolve(db, prior, 'EVIDENCE_RECOVERED', at);
          result.resolved++;
        }
        const same = prior?.reason_code === decision.reason_code ? prior : null;
        if (same) {
          await db.query(
            `UPDATE gps_continuity_alert SET severity=$2,updated_at=$3,evaluated_at=$3,evidence_at=$4,
               age_s=$5,threshold_s=$6,last_position_captured_at=$7,
               last_position_received_at=$8,last_health_observed_at=$9,
               last_health_received_at=$10,last_batch_persisted_at=$11,
               observed_tracking_state=$12 WHERE id=$1`,
            [
              same.id,
              decision.severity,
              at,
              decision.evidence_at,
              decision.age_s,
              decision.threshold_s,
              evidence.last_position_captured_at,
              evidence.last_position_received_at,
              evidence.last_health_observed_at,
              evidence.last_health_received_at,
              evidence.last_batch_persisted_at,
              evidence.observed_tracking_state,
            ],
          );
          if (same.severity !== decision.severity) {
            await appendAudit(db, {
              actorType: 'SYSTEM',
              deviceId: window.device_id,
              action: 'gps.continuity.alert.severity',
              outcome: 'success',
              correlationId: randomUUID(),
              previousState: same.severity,
              nextState: decision.severity,
              metadata: { reason_code: decision.reason_code, tenant_id: window.tenant_id },
            });
            result.changed++;
          }
          continue;
        }
        await db.query(
          `INSERT INTO gps_continuity_alert(id,tenant_id,device_id,mdm_binding_id,installation_id,
             scheduled_session_id,assignment_version,reason_code,severity,opened_at,updated_at,evaluated_at,
             evidence_at,age_s,threshold_s,last_position_captured_at,last_position_received_at,
             last_health_observed_at,last_health_received_at,last_batch_persisted_at,
             observed_tracking_state)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            randomUUID(),
            window.tenant_id,
            window.device_id,
            window.mdm_binding_id,
            window.installation_id,
            window.id,
            window.assignment_version,
            decision.reason_code,
            decision.severity,
            at,
            decision.evidence_at,
            decision.age_s,
            decision.threshold_s,
            evidence.last_position_captured_at,
            evidence.last_position_received_at,
            evidence.last_health_observed_at,
            evidence.last_health_received_at,
            evidence.last_batch_persisted_at,
            evidence.observed_tracking_state,
          ],
        );
        await appendAudit(db, {
          actorType: 'SYSTEM',
          deviceId: window.device_id,
          action: 'gps.continuity.alert.open',
          outcome: 'success',
          correlationId: randomUUID(),
          nextState: decision.severity,
          metadata: { reason_code: decision.reason_code, tenant_id: window.tenant_id },
        });
        result.opened++;
      }
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }

  private async resolve(
    db: PoolClient,
    alert: OpenAlert,
    reason:
      | 'EVIDENCE_RECOVERED'
      | 'WINDOW_ENDED'
      | 'POLICY_CHANGED'
      | 'DEVICE_INACTIVE'
      | 'INSTALLATION_CHANGED',
    at: Date,
  ): Promise<void> {
    await db.query(
      'UPDATE gps_continuity_alert SET resolved_at=$2,updated_at=$2,resolution_reason=$3 WHERE id=$1',
      [alert.id, at, reason],
    );
    await appendAudit(db, {
      actorType: 'SYSTEM',
      deviceId: alert.device_id,
      action: 'gps.continuity.alert.resolve',
      outcome: 'success',
      correlationId: randomUUID(),
      previousState: alert.severity,
      nextState: 'RESOLVED',
      metadata: {
        reason_code: alert.reason_code,
        resolution_reason: reason,
        tenant_id: alert.tenant_id,
      },
    });
  }

  private async evidence(db: PoolClient, window: WindowRow, at: Date): Promise<EvidenceRow> {
    const result = await db.query<EvidenceRow>(
      `SELECT
         (SELECT max(p.captured_at) FROM position_event p
          JOIN gps_effective_session e ON e.id=p.session_id AND e.device_id=p.device_id
          WHERE e.scheduled_session_id=$1 AND p.tenant_id=$2
            AND p.mdm_binding_id=$6 AND p.installation_id=$7
            AND p.captured_at >= $3 AND p.captured_at <= $4 AND p.received_at <= $4)
           AS last_position_captured_at,
         (SELECT max(p.received_at) FROM position_event p
          JOIN gps_effective_session e ON e.id=p.session_id AND e.device_id=p.device_id
          WHERE e.scheduled_session_id=$1 AND p.tenant_id=$2
            AND p.mdm_binding_id=$6 AND p.installation_id=$7
            AND p.captured_at >= $3 AND p.captured_at <= $4 AND p.received_at <= $4)
           AS last_position_received_at,
         (SELECT max(h.observed_at) FROM gps_device_health_event h
          WHERE h.scheduled_session_id=$1 AND h.tenant_id=$2
            AND h.mdm_binding_id=$6 AND h.installation_id=$7
            AND h.observed_at >= $3 AND h.observed_at <= $4 AND h.received_at <= $4)
           AS last_health_observed_at,
         (SELECT max(h.received_at) FROM gps_device_health_event h
          WHERE h.scheduled_session_id=$1 AND h.tenant_id=$2
            AND h.mdm_binding_id=$6 AND h.installation_id=$7
            AND h.observed_at >= $3 AND h.observed_at <= $4 AND h.received_at <= $4)
           AS last_health_received_at,
         (SELECT h.tracking_state FROM gps_device_health_event h
          WHERE h.scheduled_session_id=$1 AND h.tenant_id=$2
            AND h.mdm_binding_id=$6 AND h.installation_id=$7
            AND h.observed_at >= $3 AND h.observed_at <= $4 AND h.received_at <= $4
          ORDER BY h.observed_at DESC,h.event_id DESC LIMIT 1) AS observed_tracking_state,
         (SELECT max(e.received_at) FROM gps_session_event e
          WHERE e.scheduled_session_id=$1 AND e.tenant_id=$2
            AND e.mdm_binding_id=$6 AND e.installation_id=$7
            AND e.occurred_at >= $3 AND e.occurred_at <= $4 AND e.received_at <= $4)
           AS last_session_received_at,
         (SELECT max(d.fetched_at) FROM gps_policy_delivery d
          WHERE d.device_id=$5 AND d.installation_id=$7
            AND d.health_mdm_binding_id=$6
            AND d.fetched_at >= $3 AND d.fetched_at <= $4)
           AS last_config_fetched_at,
         NULL::timestamptz AS last_batch_persisted_at`,
      [
        window.id,
        window.tenant_id,
        window.start_at,
        at,
        window.device_id,
        window.mdm_binding_id,
        window.installation_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Continuity evidence query returned no row');
    return row;
  }

  /** Versioned read. The cursor is an expiring, filter-bound position, never an authorization. */
  async listPageForAdmin(
    adminId: string,
    requestId: string,
    accessReason: string,
    filters: ContinuityAlertFilters,
  ) {
    const reason = accessReason.trim();
    const status = filters.status ?? 'OPEN';
    const limit = filters.limit ?? 25;
    const from = filters.opened_from;
    const before = filters.opened_before;
    if (
      reason.length < 8 ||
      reason.length > 240 ||
      (filters.device_id !== undefined && !uuid.test(filters.device_id)) ||
      !['OPEN', 'RESOLVED', 'ALL'].includes(status) ||
      (filters.severity !== undefined && !['WARNING', 'CRITICAL'].includes(filters.severity)) ||
      (filters.reason_code !== undefined &&
        !['CAPTURE_STALE', 'COMMUNICATION_MISSING'].includes(filters.reason_code)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (from === undefined) !== (before === undefined) ||
      (status !== 'OPEN' && (from === undefined || before === undefined)) ||
      (from !== undefined &&
        (!utc.test(from) ||
          !utc.test(before ?? '') ||
          !Number.isFinite(Date.parse(from)) ||
          !Number.isFinite(Date.parse(before ?? '')) ||
          Date.parse(from) >= Date.parse(before ?? '') ||
          Date.parse(before ?? '') - Date.parse(from) > 90 * 86_400_000))
    ) {
      await this.auditRejectedRead(adminId, requestId, 'invalid_request');
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    }

    const scope = JSON.stringify({
      adminId,
      device_id: filters.device_id ?? null,
      status,
      severity: filters.severity ?? null,
      reason_code: filters.reason_code ?? null,
      opened_from: from ?? null,
      opened_before: before ?? null,
      limit,
    });
    let cursorAt: string | null = null;
    let cursorId: string | null = null;
    if (filters.cursor !== undefined) {
      try {
        if (
          filters.cursor.length > 1024 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(filters.cursor)
        )
          throw new Error();
        const [payload, signature] = filters.cursor.split('.');
        if (!payload || !signature) throw new Error();
        const expected = createHmac('sha256', this.cursorKey).update(payload).digest();
        const given = Buffer.from(signature, 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
          throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded !== 'object') throw new Error();
        const value = decoded as Record<string, unknown>;
        if (
          value.scope !== scope ||
          typeof value.expires !== 'number' ||
          value.expires < this.now().getTime() ||
          typeof value.at !== 'string' ||
          !utc.test(value.at) ||
          typeof value.id !== 'string' ||
          !uuid.test(value.id)
        )
          throw new Error();
        cursorAt = value.at;
        cursorId = value.id;
      } catch {
        await this.auditRejectedRead(adminId, requestId, 'invalid_cursor');
        throw new ApiError(422, 'invalid_cursor', 'Invalid request');
      }
    }
    const allowed = await this.pool.query<{ has_capabilities: boolean; has_tenant: boolean }>(
      `SELECT
         (SELECT count(DISTINCT p.permission)=2 FROM admin_permission p
          JOIN admin_user u ON u.id=p.admin_id AND u.state='ACTIVE'
          WHERE p.admin_id=$1 AND p.revoked_at IS NULL AND
            p.permission IN ('gps.session.read','gps.location.read')) AS has_capabilities,
         EXISTS(SELECT 1 FROM gps_data_tenant_access d
           JOIN gps_health_tenant_access h ON h.admin_id=d.admin_id
             AND h.tenant_id=d.tenant_id AND h.revoked_at IS NULL
           WHERE d.admin_id=$1 AND d.revoked_at IS NULL) AS has_tenant`,
      [adminId],
    );
    if (!allowed.rows[0]?.has_capabilities || !allowed.rows[0]?.has_tenant) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'gps.continuity.alert.read',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { code: 'forbidden', access_reason: reason },
      });
      throw new ApiError(403, 'gps_forbidden', 'Forbidden');
    }
    const quota = await this.pool.query(
      `INSERT INTO gps_continuity_read_quota(admin_id,minute_bucket,request_count)
       VALUES($1,date_trunc('minute',now()),1)
       ON CONFLICT (admin_id,minute_bucket) DO UPDATE
       SET request_count=gps_continuity_read_quota.request_count+1
       WHERE gps_continuity_read_quota.request_count<60 RETURNING request_count`,
      [adminId],
    );
    if (!quota.rowCount) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'gps.continuity.alert.read',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { code: 'rate_limited', access_reason: reason },
      });
      throw new ApiError(429, 'rate_limited', 'Try again later');
    }
    if (filters.device_id) {
      const visible = await this.pool.query(
        `SELECT 1 FROM mdm_binding b
         JOIN gps_data_tenant_access d ON d.admin_id=$2 AND d.tenant_id=b.customer_id AND d.revoked_at IS NULL
         JOIN gps_health_tenant_access h ON h.admin_id=$2 AND h.tenant_id=b.customer_id AND h.revoked_at IS NULL
         WHERE b.geops_device_id=$1 LIMIT 1`,
        [filters.device_id, adminId],
      );
      if (!visible.rowCount) {
        await appendAudit(this.pool, {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'gps.continuity.alert.read',
          outcome: 'rejected',
          correlationId: requestId,
          metadata: { code: 'not_found', access_reason: reason },
        });
        throw new ApiError(404, 'not_found', 'Not found');
      }
    }
    const result = await this.pool.query<AlertPageRow>(
      `SELECT a.id,a.device_id,a.scheduled_session_id,a.reason_code,a.severity,a.source,
         a.opened_at,a.updated_at,a.evaluated_at,a.resolved_at,a.resolution_reason,
         a.evidence_at,a.age_s,a.threshold_s,a.last_position_captured_at,
         a.last_position_received_at,a.last_health_observed_at,a.last_health_received_at,
         a.observed_tracking_state
       FROM gps_continuity_alert a
       JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
       WHERE EXISTS (SELECT 1 FROM admin_permission p WHERE p.admin_id=u.id
           AND p.permission='gps.session.read' AND p.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM admin_permission p WHERE p.admin_id=u.id
           AND p.permission='gps.location.read' AND p.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM gps_data_tenant_access d WHERE d.admin_id=u.id
           AND d.tenant_id=a.tenant_id AND d.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM gps_health_tenant_access h WHERE h.admin_id=u.id
           AND h.tenant_id=a.tenant_id AND h.revoked_at IS NULL)
         AND ($2::uuid IS NULL OR a.device_id=$2)
         AND ($3::text='ALL' OR ($3='OPEN' AND a.resolved_at IS NULL)
           OR ($3='RESOLVED' AND a.resolved_at IS NOT NULL))
         AND ($4::text IS NULL OR a.severity=$4)
         AND ($5::text IS NULL OR a.reason_code=$5)
         AND ($6::timestamptz IS NULL OR a.opened_at >= $6)
         AND ($7::timestamptz IS NULL OR a.opened_at < $7)
         AND ($8::timestamptz IS NULL OR (a.opened_at,a.id) < ($8::timestamptz,$9::uuid))
       ORDER BY a.opened_at DESC,a.id DESC LIMIT $10`,
      [
        adminId,
        filters.device_id ?? null,
        status,
        filters.severity ?? null,
        filters.reason_code ?? null,
        from ?? null,
        before ?? null,
        cursorAt,
        cursorId,
        limit + 1,
      ],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor =
      hasMore && last
        ? (() => {
            const payload = Buffer.from(
              JSON.stringify({
                scope,
                at: last.opened_at.toISOString(),
                id: last.id,
                expires: this.now().getTime() + 15 * 60_000,
              }),
            ).toString('base64url');
            const signature = createHmac('sha256', this.cursorKey)
              .update(payload)
              .digest('base64url');
            return `${payload}.${signature}`;
          })()
        : null;
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'gps.continuity.alert.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: {
        count: rows.length,
        status,
        access_reason: reason,
        device_filter: filters.device_id ?? 'all',
        page: filters.cursor ? 'next' : 'first',
      },
    });
    return {
      schema_version: 1 as const,
      items: rows.map((row) => ({
        alert_id: row.id,
        device_id: row.device_id,
        scheduled_session_id: row.scheduled_session_id,
        status: row.resolved_at ? ('RESOLVED' as const) : ('OPEN' as const),
        reason_code: row.reason_code,
        severity: row.severity,
        source: row.source,
        observed: {
          tracking_state: row.observed_tracking_state,
          last_position_captured_at: stamp(row.last_position_captured_at),
          last_position_received_at: stamp(row.last_position_received_at),
          last_health_observed_at: stamp(row.last_health_observed_at),
          last_health_received_at: stamp(row.last_health_received_at),
        },
        inference: {
          evidence_at: stamp(row.evidence_at),
          age_s: row.age_s,
          threshold_s: row.threshold_s,
          evaluated_at: stamp(row.evaluated_at),
        },
        opened_at: stamp(row.opened_at),
        updated_at: stamp(row.updated_at),
        resolved_at: stamp(row.resolved_at),
        resolution_reason: row.resolution_reason,
      })),
      next_cursor: nextCursor,
    };
  }

  /** Legacy internal authorized read retained for R4-A callers. */
  async listForAdmin(adminId: string, requestId: string, accessReason: string, limit = 100) {
    if (
      accessReason.trim().length < 8 ||
      accessReason.length > 240 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    }
    const permissions = await this.pool.query<{ permission: string }>(
      `SELECT p.permission FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id
       WHERE u.id=$1 AND u.state='ACTIVE' AND p.revoked_at IS NULL
         AND p.permission IN ('gps.session.read','gps.location.read')`,
      [adminId],
    );
    if (permissions.rows.length !== 2) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'gps.continuity.alert.read',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { code: 'capability', access_reason: accessReason.trim() },
      });
      throw new ApiError(403, 'gps_forbidden', 'Forbidden');
    }
    const rows = await this.pool.query(
      `SELECT a.id,a.tenant_id,a.device_id,a.scheduled_session_id,a.reason_code,
         a.severity,a.source,a.opened_at,a.updated_at,a.resolved_at,
         a.evidence_at,a.age_s,a.threshold_s,a.last_position_captured_at,
         a.last_position_received_at,a.last_health_observed_at,a.last_health_received_at,
         a.last_batch_persisted_at,a.observed_tracking_state
       FROM gps_continuity_alert a
       WHERE a.resolved_at IS NULL
         AND EXISTS (SELECT 1 FROM admin_user u WHERE u.id=$1 AND u.state='ACTIVE')
         AND EXISTS (SELECT 1 FROM admin_permission p WHERE p.admin_id=$1
           AND p.permission='gps.session.read' AND p.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM admin_permission p WHERE p.admin_id=$1
           AND p.permission='gps.location.read' AND p.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM gps_data_tenant_access d
           WHERE d.admin_id=$1 AND d.tenant_id=a.tenant_id AND d.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM gps_health_tenant_access h
           WHERE h.admin_id=$1 AND h.tenant_id=a.tenant_id AND h.revoked_at IS NULL)
       ORDER BY a.updated_at DESC,a.id DESC LIMIT $2`,
      [adminId, limit],
    );
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'gps.continuity.alert.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: rows.rows.length, access_reason: accessReason.trim() },
    });
    return rows.rows;
  }

  /** Backend-only configuration operation. HTTP/CSRF contract is intentionally deferred. */
  async configureForAdmin(
    adminId: string,
    requestId: string,
    tenantId: string,
    accessReason: string,
    expectedVersion: number,
    input: ContinuityThresholds,
  ): Promise<number> {
    if (
      !tenantId ||
      tenantId.length > 256 ||
      accessReason.trim().length < 8 ||
      accessReason.length > 240 ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      !Number.isInteger(input.warning_after_s) ||
      input.warning_after_s < 60 ||
      input.warning_after_s > 86400 ||
      !Number.isInteger(input.critical_after_s) ||
      input.critical_after_s < 120 ||
      input.critical_after_s > 172800 ||
      input.warning_after_s >= input.critical_after_s ||
      !Number.isInteger(input.start_grace_s) ||
      input.start_grace_s < 0 ||
      input.start_grace_s > 3600 ||
      !Number.isInteger(input.policy_grace_s) ||
      input.policy_grace_s < 0 ||
      input.policy_grace_s > 3600
    )
      throw new ApiError(422, 'invalid_request', 'Invalid request');

    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const authorized = await db.query(
        `SELECT 1 FROM admin_user u
         JOIN admin_permission p ON p.admin_id=u.id AND p.permission='gps.policy.write'
           AND p.revoked_at IS NULL
         JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=$2
           AND a.revoked_at IS NULL
         JOIN gps_health_tenant_access h ON h.admin_id=u.id AND h.tenant_id=$2
           AND h.revoked_at IS NULL
         WHERE u.id=$1 AND u.state='ACTIVE'
         FOR SHARE OF u,p,a,h`,
        [adminId, tenantId],
      );
      if (!authorized.rowCount) {
        await db.query('ROLLBACK');
        await appendAudit(this.pool, {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'gps.continuity.threshold.configure',
          outcome: 'rejected',
          correlationId: requestId,
          metadata: { tenant_id: tenantId, access_reason: accessReason.trim(), code: 'forbidden' },
        });
        throw new ApiError(403, 'gps_forbidden', 'Forbidden');
      }
      const values = [
        tenantId,
        input.warning_after_s,
        input.critical_after_s,
        input.start_grace_s,
        input.policy_grace_s,
      ];
      const changed =
        expectedVersion === 0
          ? await db.query<{ version: string }>(
              `INSERT INTO gps_continuity_threshold(tenant_id,warning_after_s,
             critical_after_s,start_grace_s,policy_grace_s)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING version`,
              values,
            )
          : await db.query<{ version: string }>(
              `UPDATE gps_continuity_threshold SET warning_after_s=$2,
             critical_after_s=$3,start_grace_s=$4,policy_grace_s=$5,
             version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND version=$6 RETURNING version`,
              [...values, expectedVersion],
            );
      if (!changed.rowCount) {
        await db.query('ROLLBACK');
        await appendAudit(this.pool, {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'gps.continuity.threshold.configure',
          outcome: 'rejected',
          correlationId: requestId,
          metadata: {
            tenant_id: tenantId,
            access_reason: accessReason.trim(),
            code: 'version_conflict',
          },
        });
        throw new ApiError(409, 'version_conflict', 'Conflict');
      }
      const version = Number(changed.rows[0]?.version);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'gps.continuity.threshold.configure',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          tenant_id: tenantId,
          access_reason: accessReason.trim(),
          previous_version: expectedVersion,
          next_version: version,
        },
      });
      await db.query('COMMIT');
      return version;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
