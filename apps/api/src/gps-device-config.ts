import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { appendAudit } from './audit/index.js';
import { exactBody } from './device-identity/raw-body.js';
import type { DevicePrincipal, DeviceSessionService } from './device-identity/session.js';
import { ApiError } from './errors.js';

interface Assignment {
  policy_id: string;
  revision: number;
  published_name: string;
  days_iso: number[];
  start_local: string;
  end_local: string;
  time_zone: string;
  capture_interval_s: number;
  sync_interval_s: number;
  heartbeat_missing_after_s: number;
  health_interval_s: number;
  valid_from: Date;
  valid_until: Date;
  assignment_until: Date;
}

interface WindowRow {
  id: string;
  start_at: Date;
  end_at: Date;
}

const iso = (date: Date): string => date.toISOString();

/** Authenticated delivery only. Installation is provisioned outside this GET. */
export class GpsDeviceConfigService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(principal: DevicePrincipal, requestId: string): Promise<Record<string, unknown>> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const identity = await db.query<{
        installation_id: string;
        binding_id: string;
        tenant_id: string;
      }>(
        `SELECT i.installation_id,b.id AS binding_id,b.customer_id AS tenant_id
         FROM geops_device d
         JOIN gps_device_installation i ON i.device_id=d.id AND i.retired_at IS NULL
         JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state='ACTIVE'
           AND i.activation_binding_id=b.id AND i.activation_tenant_id=b.customer_id
         WHERE d.id=$1 AND d.status='ACTIVE' FOR SHARE OF d,i,b`,
        [principal.deviceId],
      );
      const holder = identity.rows[0];
      if (identity.rows.length !== 1 || !holder)
        throw new ApiError(403, 'gps_installation_inactive', 'Forbidden', true);
      const state = await db.query<{ assignment_version: string }>(
        'SELECT assignment_version FROM gps_device_assignment_state WHERE device_id=$1 FOR SHARE',
        [principal.deviceId],
      );
      const version = Number(state.rows[0]?.assignment_version ?? 0);
      if (!Number.isSafeInteger(version))
        throw new ApiError(503, 'gps_version_unavailable', 'Service unavailable', true);
      const now = this.now();
      const active = await db.query<Assignment>(
        `SELECT e.policy_id,e.revision,r.published_name,r.days_iso,
           to_char(r.start_local,'HH24:MI') AS start_local,
           to_char(r.end_local,'HH24:MI') AS end_local,
           r.time_zone,r.capture_interval_s,r.sync_interval_s,
           r.heartbeat_missing_after_s,r.health_interval_s,r.valid_from,r.valid_until,
           upper(e.effective_range) AS assignment_until
         FROM gps_effective_assignment e
         JOIN gps_policy p ON p.id=e.policy_id AND p.state='ACTIVE'
         JOIN gps_policy_revision r ON r.policy_id=e.policy_id AND r.revision=e.revision
         WHERE e.device_id=$1 AND e.assignment_version=$2 AND e.superseded_at IS NULL
           AND e.effective_range @> $3::timestamptz
           AND r.valid_from<=$3 AND $3<r.valid_until
         FOR SHARE OF e,p,r`,
        [principal.deviceId, version, now],
      );
      if (active.rows.length > 1)
        throw new ApiError(503, 'gps_assignment_ambiguous', 'Service unavailable', true);
      const assignment = active.rows[0];
      const anchorId = randomUUID();
      const horizon = new Date(now.getTime() + 7 * 86_400_000);
      const windowRows = assignment
        ? await db.query<WindowRow>(
            `SELECT id,start_at,end_at FROM gps_scheduled_session
             WHERE device_id=$1 AND policy_id=$2 AND revision=$3 AND assignment_version=$4
               AND state='SCHEDULED' AND end_at>$5 AND start_at<$6
             ORDER BY start_at,id LIMIT 65`,
            [principal.deviceId, assignment.policy_id, assignment.revision, version, now, horizon],
          )
        : { rows: [] as WindowRow[] };
      if (windowRows.rows.length > 64)
        throw new ApiError(503, 'gps_window_limit', 'Service unavailable', true);
      const firstWindowEnd = windowRows.rows[0]?.end_at.getTime() ?? Number.POSITIVE_INFINITY;
      const offlineNotAfter = new Date(
        Math.min(
          now.getTime() + 12 * 3_600_000,
          assignment?.assignment_until.getTime() ?? Number.POSITIVE_INFINITY,
          assignment?.valid_until.getTime() ?? Number.POSITIVE_INFINITY,
          firstWindowEnd,
        ),
      );
      const common = {
        schema_version: 1,
        capture_anchor_id: anchorId,
        device_id: principal.deviceId,
        installation_id: holder.installation_id,
        assignment_version: version,
        active: Boolean(assignment),
        server_time: iso(now),
        verified_at: iso(now),
        offline_not_after: iso(offlineNotAfter),
        window_instances: windowRows.rows.map((window) => ({
          scheduled_session_id: window.id,
          start_at: iso(window.start_at),
          end_at: iso(window.end_at),
        })),
      };
      const exceptions = assignment
        ? await db.query<{
            local_date: string;
            mode: 'OFF' | 'REPLACE';
            start_local: string | null;
            end_local: string | null;
            reason: string;
          }>(
            `SELECT to_char(local_date,'YYYY-MM-DD') AS local_date,mode,
               CASE WHEN start_local IS NULL THEN NULL ELSE to_char(start_local,'HH24:MI') END AS start_local,
               CASE WHEN end_local IS NULL THEN NULL ELSE to_char(end_local,'HH24:MI') END AS end_local,
               reason FROM gps_policy_exception WHERE policy_id=$1 AND revision=$2 ORDER BY local_date`,
            [assignment.policy_id, assignment.revision],
          )
        : null;
      const body: Record<string, unknown> = assignment
        ? {
            ...common,
            policy_id: assignment.policy_id,
            policy_revision: assignment.revision,
            tzdb_version: process.versions.tz ?? `icu-${process.versions.icu}`,
            policy: {
              name: assignment.published_name,
              days_iso: assignment.days_iso,
              start_local: assignment.start_local,
              end_local: assignment.end_local,
              time_zone: assignment.time_zone,
              capture_interval_s: assignment.capture_interval_s,
              sync_interval_s: assignment.sync_interval_s,
              heartbeat_missing_after_s: assignment.heartbeat_missing_after_s,
              health_interval_s: assignment.health_interval_s,
              valid_from: iso(assignment.valid_from),
              valid_until: iso(assignment.valid_until),
              exceptions:
                exceptions?.rows.map((item) => ({
                  local_date: item.local_date,
                  mode: item.mode,
                  reason: item.reason,
                  ...(item.start_local ? { start_local: item.start_local } : {}),
                  ...(item.end_local ? { end_local: item.end_local } : {}),
                })) ?? [],
            },
          }
        : common;
      await db.query(
        `INSERT INTO gps_policy_delivery(capture_anchor_id,device_id,installation_id,
           assignment_version,server_time,offline_not_after,health_mdm_binding_id,health_tenant_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          anchorId,
          principal.deviceId,
          holder.installation_id,
          version,
          now,
          offlineNotAfter,
          holder.binding_id,
          holder.tenant_id,
        ],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: principal.deviceId,
        action: 'gps.config.deliver',
        outcome: 'success',
        correlationId: requestId,
        metadata: { active: Boolean(assignment), assignment_version: version },
      });
      await db.query('COMMIT');
      return body;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}

export function registerGpsDeviceConfigRoute(
  app: FastifyInstance,
  sessions: DeviceSessionService,
  config: GpsDeviceConfigService,
): void {
  app.get('/v1/device/config', async (request, reply) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    const body = await config.snapshot(principal, request.id);
    reply.header('Cache-Control', 'no-store');
    return body;
  });
}
