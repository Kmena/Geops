import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import type { GpsEventService } from './gps-event-service.js';
import type { GpsHealthService } from './gps-health-service.js';
import type { GpsPolicyService } from './gps-policy-service.js';
import { windowsForRange, type GpsPolicySpec } from './gps-policy-windows.js';

const DAY = 86_400_000;
interface Projection {
  device_id: string;
  policy_id: string;
  revision: number;
  assignment_version: string;
  lower_at: Date;
  upper_at: Date;
  days_iso: number[];
  start_local: string;
  end_local: string;
  time_zone: string;
  valid_from: Date;
  valid_until: Date;
  exceptions: GpsPolicySpec['exceptions'];
}
export interface GpsSchedulerResult {
  skipped: boolean;
  versions_advanced: number;
  windows_created: number;
  windows_missed: number;
  sessions_unknown_end: number;
  positions_purged: number;
  health_purged: number;
}

/** A single database advisory lock serializes ticks across API processes. */
export class GpsScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly policies: GpsPolicyService,
    private readonly events: GpsEventService,
    private readonly health: GpsHealthService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<GpsSchedulerResult> {
    const db = await this.pool.connect();
    let lock: { rows: { acquired: boolean }[] };
    try {
      lock = await db.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('geops-gps-scheduler-v1')) AS acquired",
      );
    } catch (error) {
      db.release(true);
      throw error;
    }
    if (!lock.rows[0]?.acquired) {
      db.release();
      return {
        skipped: true,
        versions_advanced: 0,
        windows_created: 0,
        windows_missed: 0,
        sessions_unknown_end: 0,
        positions_purged: 0,
        health_purged: 0,
      };
    }
    try {
      const at = this.now();
      await db.query('BEGIN');
      const versions = await this.advanceVersions(db, at);
      const created = await this.fillHorizon(db, at);
      const missed = await db.query(
        `UPDATE gps_scheduled_session s SET state='MISSED'
         WHERE s.state='SCHEDULED' AND s.end_at<=$1 AND NOT EXISTS
           (SELECT 1 FROM gps_effective_session e WHERE e.scheduled_session_id=s.id)`,
        [at],
      );
      const unknown = await db.query(
        `UPDATE gps_effective_session e SET state='UNKNOWN_END',end_reason='UNKNOWN',
           evidence_state='START_REPORTED_END_UNKNOWN'
         FROM gps_scheduled_session s WHERE s.id=e.scheduled_session_id
           AND s.end_at<=$1 AND e.state IN ('OPEN','INTERRUPTED')`,
        [at],
      );
      await appendAudit(db, {
        actorType: 'SYSTEM',
        action: 'gps.scheduler.reconcile',
        outcome: 'success',
        correlationId: randomUUID(),
        metadata: {
          versions_advanced: versions,
          windows_created: created,
          windows_missed: missed.rowCount ?? 0,
          sessions_unknown_end: unknown.rowCount ?? 0,
        },
      });
      await db.query('COMMIT');
      const positions = await this.events.purgeExpired();
      const health = await this.health.purgeExpired();
      const result: GpsSchedulerResult = {
        skipped: false,
        versions_advanced: versions,
        windows_created: created,
        windows_missed: missed.rowCount ?? 0,
        sessions_unknown_end: unknown.rowCount ?? 0,
        positions_purged: positions.positions,
        health_purged: health,
      };
      await db.query(
        `INSERT INTO gps_scheduler_run(id,ran_at,versions_advanced,windows_created,
         windows_missed,sessions_unknown_end,positions_purged,health_purged)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          at,
          versions,
          created,
          result.windows_missed,
          result.sessions_unknown_end,
          result.positions_purged,
          result.health_purged,
        ],
      );
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      try {
        await db.query("SELECT pg_advisory_unlock(hashtext('geops-gps-scheduler-v1'))");
        db.release();
      } catch {
        // Closing the connection releases its session advisory lock.
        db.release(true);
      }
    }
  }

  private async advanceVersions(db: PoolClient, at: Date): Promise<number> {
    const devices = await db.query<{ device_id: string }>(
      `SELECT DISTINCT e.device_id FROM gps_effective_assignment e
       JOIN gps_device_assignment_state s ON s.device_id=e.device_id
       WHERE e.superseded_at IS NULL AND
         ((lower(e.effective_range)>s.changed_at AND lower(e.effective_range)<=$1) OR
          (upper(e.effective_range)>s.changed_at AND upper(e.effective_range)<=$1))
       ORDER BY e.device_id`,
      [at],
    );
    let advanced = 0;
    for (const row of devices.rows) {
      await db.query('SELECT id FROM geops_device WHERE id=$1 FOR UPDATE', [row.device_id]);
      const pending = await db.query(
        `SELECT 1 FROM gps_effective_assignment e
         JOIN gps_device_assignment_state s ON s.device_id=e.device_id
         WHERE e.device_id=$1 AND e.superseded_at IS NULL AND
           ((lower(e.effective_range)>s.changed_at AND lower(e.effective_range)<=$2) OR
            (upper(e.effective_range)>s.changed_at AND upper(e.effective_range)<=$2)) LIMIT 1`,
        [row.device_id, at],
      );
      if (!pending.rowCount) continue;
      await this.policies.rebuildDevice(db, row.device_id, at);
      advanced++;
    }
    return advanced;
  }

  private async fillHorizon(db: PoolClient, at: Date): Promise<number> {
    const rows = await db.query<Projection>(
      `SELECT e.device_id,e.policy_id,e.revision,e.assignment_version,
         lower(e.effective_range) AS lower_at,upper(e.effective_range) AS upper_at,
         r.days_iso,to_char(r.start_local,'HH24:MI') AS start_local,
         to_char(r.end_local,'HH24:MI') AS end_local,r.time_zone,r.valid_from,r.valid_until,
         COALESCE((SELECT json_agg(json_build_object('local_date',x.local_date,'mode',x.mode,
           'start_local',CASE WHEN x.start_local IS NULL THEN NULL ELSE to_char(x.start_local,'HH24:MI') END,
           'end_local',CASE WHEN x.end_local IS NULL THEN NULL ELSE to_char(x.end_local,'HH24:MI') END,
           'reason',x.reason)) FROM gps_policy_exception x
           WHERE x.policy_id=r.policy_id AND x.revision=r.revision),'[]'::json) AS exceptions
       FROM gps_effective_assignment e JOIN gps_policy_revision r
         ON r.policy_id=e.policy_id AND r.revision=e.revision
       JOIN gps_policy p ON p.id=e.policy_id AND p.state='ACTIVE'
       WHERE e.superseded_at IS NULL AND upper(e.effective_range)>$1
         AND lower(e.effective_range)<$2
       ORDER BY e.device_id,e.policy_id FOR SHARE OF e`,
      [at, new Date(at.getTime() + 7 * DAY)],
    );
    let created = 0;
    for (const row of rows.rows) {
      const from = new Date(Math.max(row.lower_at.getTime(), at.getTime() - 2 * DAY));
      const until = new Date(Math.min(row.upper_at.getTime(), at.getTime() + 7 * DAY));
      const spec: GpsPolicySpec = {
        name: 'Published',
        days_iso: row.days_iso,
        start_local: row.start_local,
        end_local: row.end_local,
        time_zone: row.time_zone,
        capture_interval_s: 60,
        sync_interval_s: 60,
        heartbeat_missing_after_s: 900,
        health_interval_s: 300,
        valid_from: row.valid_from.toISOString(),
        valid_until: row.valid_until.toISOString(),
        exceptions: (row.exceptions ?? []).map((ex) => ({
          local_date: ex.local_date,
          mode: ex.mode,
          reason: ex.reason,
          ...(ex.start_local ? { start_local: ex.start_local } : {}),
          ...(ex.end_local ? { end_local: ex.end_local } : {}),
        })),
      };
      for (const window of windowsForRange(spec, from, until)) {
        // An API restart during a shift must materialize the still-active window.
        // Never recreate an already-ended historical window.
        if (Date.parse(window.end_at) <= at.getTime()) continue;
        const existing = await db.query<{ id: string; end_at: Date }>(
          `SELECT id,end_at FROM gps_scheduled_session WHERE device_id=$1 AND policy_id=$2
           AND revision=$3 AND assignment_version=$4 AND local_date=$5 AND start_at=$6
           AND state='SCHEDULED' FOR UPDATE`,
          [
            row.device_id,
            row.policy_id,
            row.revision,
            row.assignment_version,
            window.local_date,
            window.start_at,
          ],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].end_at.getTime() < Date.parse(window.end_at)) {
            await db.query('UPDATE gps_scheduled_session SET end_at=$2 WHERE id=$1', [
              existing.rows[0].id,
              window.end_at,
            ]);
          }
          continue;
        }
        const inserted = await db.query(
          `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,
           assignment_version,local_date,start_at,end_at,state)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SCHEDULED') ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            row.device_id,
            row.policy_id,
            row.revision,
            row.assignment_version,
            window.local_date,
            window.start_at,
            window.end_at,
          ],
        );
        created += inserted.rowCount ?? 0;
      }
    }
    return created;
  }
}
