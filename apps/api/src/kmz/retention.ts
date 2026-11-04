import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAudit } from '../audit/index.js';
import { guardClient } from '../db/client-guard.js';
import { ApiError } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RetentionResult = {
  dry_run: boolean;
  eligible: number;
  purged: number;
  skipped_busy: number;
  skipped_changed: number;
};

// Manually invoked only. No timer, route, or application startup hook calls this service.
export class KmzRetentionService {
  constructor(private readonly pool: Pool) {}

  async run(
    actorId: string,
    options: { dryRun: boolean; limit?: number; now?: Date; requestId?: string },
  ): Promise<RetentionResult> {
    if (!UUID.test(actorId)) throw new ApiError(422, 'invalid_actor', 'Invalid request');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(422, 'invalid_limit', 'Invalid request');
    const now = options.now ?? new Date();
    if (Number.isNaN(now.getTime())) throw new ApiError(422, 'invalid_time', 'Invalid request');
    const requestId = options.requestId ?? randomUUID();
    const permitted = await this.pool.query(
      "SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id AND p.permission='catalog.import.confirm' AND p.revoked_at IS NULL JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.revoked_at IS NULL JOIN geops_operating_tenant t ON t.singleton=true AND t.tenant_id=a.tenant_id WHERE u.id=$1 AND u.state='ACTIVE'",
      [actorId],
    );
    if (!permitted.rowCount) {
      await appendAudit(this.pool, {
        actorType: 'SYSTEM',
        action: 'kmz.retention.denied',
        outcome: 'rejected',
        correlationId: requestId,
      });
      throw new ApiError(403, 'catalog_forbidden', 'Forbidden');
    }
    const candidates = await this.pool.query<{ id: string }>(
      "SELECT id FROM kmz_import_session WHERE purged_at IS NULL AND created_at <= $1::timestamptz - interval '30 days' AND (state IN ('READY','FAILED') OR (state='PROCESSING' AND coalesce(processing_started_at,created_at) <= $1::timestamptz - interval '5 minutes')) ORDER BY created_at,id LIMIT $2",
      [now, limit],
    );
    const result: RetentionResult = {
      dry_run: options.dryRun,
      eligible: candidates.rowCount ?? 0,
      purged: 0,
      skipped_busy: 0,
      skipped_changed: 0,
    };
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId,
      action: 'kmz.retention.started',
      outcome: 'success',
      correlationId: requestId,
      metadata: { dry_run: options.dryRun, eligible: result.eligible },
    });
    if (options.dryRun) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.retention.completed',
        outcome: 'success',
        correlationId: requestId,
        metadata: { dry_run: true, eligible: result.eligible, purged: 0 },
      });
      return result;
    }
    try {
      for (const candidate of candidates.rows) {
        const db = await this.pool.connect();
        const release = guardClient(db);
        try {
          await db.query('BEGIN');
          const lock = await db.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtext('kmz.analysis'),hashtext($1)) AS acquired",
            [candidate.id],
          );
          if (!lock.rows[0]?.acquired) {
            result.skipped_busy++;
            await db.query('ROLLBACK');
            continue;
          }
          const session = await db.query<{ id: string }>(
            "SELECT id FROM kmz_import_session WHERE id=$1 AND purged_at IS NULL AND created_at <= $2::timestamptz - interval '30 days' AND (state IN ('READY','FAILED') OR (state='PROCESSING' AND coalesce(processing_started_at,created_at) <= $2::timestamptz - interval '5 minutes')) FOR UPDATE",
            [candidate.id, now],
          );
          if (!session.rowCount) {
            result.skipped_changed++;
            await db.query('ROLLBACK');
            continue;
          }
          const approved = await db.query<{ id: string }>(
            "SELECT id FROM kmz_import_commit WHERE import_id=$1 AND state='APPLIED'",
            [candidate.id],
          );
          if (approved.rowCount) {
            await db.query(
              "INSERT INTO kmz_import_review_archive(id,import_id,record_id,entry_kind,payload,actor_id,occurred_at) SELECT gen_random_uuid(),import_id,record_id,'DECISION',to_jsonb(v),updated_by,updated_at FROM kmz_review_record v WHERE import_id=$1",
              [candidate.id],
            );
            await db.query(
              "INSERT INTO kmz_import_review_archive(id,import_id,record_id,entry_kind,payload,actor_id,occurred_at) SELECT id,import_id,record_id,'EVENT',to_jsonb(e),actor_id,created_at FROM kmz_review_event e WHERE import_id=$1",
              [candidate.id],
            );
          }
          await db.query('DELETE FROM kmz_review_event WHERE import_id=$1', [candidate.id]);
          await db.query('DELETE FROM kmz_review_record WHERE import_id=$1', [candidate.id]);
          await db.query('DELETE FROM kmz_review_session WHERE import_id=$1', [candidate.id]);
          await db.query('DELETE FROM kmz_analysis_run WHERE import_id=$1', [candidate.id]);
          await db.query('DELETE FROM kmz_import_record WHERE import_id=$1', [candidate.id]);
          await db.query('DELETE FROM kmz_import_file WHERE import_id=$1', [candidate.id]);
          // The applied ledger and archived decisions explain the approval; the full
          // validation plan also contains unapproved staging rows and must expire.
          await db.query(
            "UPDATE kmz_import_commit SET plan='[]'::jsonb,warnings='[]'::jsonb,blocking_issues='[]'::jsonb WHERE import_id=$1 AND state='APPLIED'",
            [candidate.id],
          );
          await db.query("DELETE FROM kmz_import_commit WHERE import_id=$1 AND state<>'APPLIED'", [
            candidate.id,
          ]);
          await db.query('UPDATE kmz_import_session SET purged_at=now() WHERE id=$1', [
            candidate.id,
          ]);
          await appendAudit(db, {
            actorType: 'ADMIN',
            actorId,
            action: 'kmz.retention.purged',
            outcome: 'success',
            correlationId: requestId,
            metadata: { import_id: candidate.id, approved: !!approved.rowCount },
          });
          await db.query('COMMIT');
          result.purged++;
        } catch (error) {
          await db.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          release();
        }
      }
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.retention.completed',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          dry_run: false,
          eligible: result.eligible,
          purged: result.purged,
          skipped_busy: result.skipped_busy,
        },
      });
      return result;
    } catch (error) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.retention.failed',
        outcome: 'failure',
        correlationId: requestId,
        metadata: { purged: result.purged },
      }).catch(() => {});
      throw error;
    }
  }
}
