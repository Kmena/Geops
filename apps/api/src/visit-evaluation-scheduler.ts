import type { Pool } from 'pg';
import type { VisitEvaluationService } from './visit-evaluation.js';
import { isTechnicalStagingDatabase } from './visit-technical-staging.js';

export interface VisitEvaluationTick {
  skipped: 'LOCKED' | 'ALGORITHM_NOT_APPROVED' | null;
  queued: number;
  processed: number;
}

/** Serializes reconciliation across API instances; jobs remain in PostgreSQL across restarts. */
export class VisitEvaluationScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly evaluation: VisitEvaluationService,
  ) {}

  async tick(): Promise<VisitEvaluationTick> {
    const db = await this.pool.connect();
    let acquired = false;
    try {
      const lock = await db.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('geops-visit-evaluation-v1')) AS acquired",
      );
      acquired = lock.rows[0]?.acquired === true;
      if (!acquired) return { skipped: 'LOCKED', queued: 0, processed: 0 };
      const algorithm = await db.query(
        "SELECT 1 FROM visit_algorithm_revision WHERE algorithm_id='dwell-pair-v1' AND scope='APPROVED' AND calibration_evidence_ref IS NOT NULL AND activated_at<=now() LIMIT 1",
      );
      const technicalStaging =
        !algorithm.rowCount &&
        (await isTechnicalStagingDatabase(db)) &&
        (
          await db.query(
            "SELECT 1 FROM visit_algorithm_revision WHERE algorithm_id='dwell-pair-v1' AND revision=3 AND scope='TECHNICAL_ONLY' LIMIT 1",
          )
        ).rowCount === 1;
      if (!algorithm.rowCount && !technicalStaging)
        return { skipped: 'ALGORITHM_NOT_APPROVED', queued: 0, processed: 0 };
      const queued = await this.evaluation.reconcileOperational(100);
      const processed = (await this.evaluation.drain(100)).length;
      return { skipped: null, queued, processed };
    } finally {
      if (acquired) {
        try {
          await db.query("SELECT pg_advisory_unlock(hashtext('geops-visit-evaluation-v1'))");
          db.release();
        } catch {
          db.release(true);
        }
      } else db.release();
    }
  }
}
