import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';
import {
  isTechnicalStagingDatabase,
  isTechnicalStagingRuntime,
} from './visit-technical-staging.js';
import {
  evaluateDwell,
  uniquePhysicalSeconds,
  validateDwellParameters,
  type DwellInterval,
  type DwellSample,
} from './visit-dwell-engine.js';

type Row = Record<string, unknown>;
type Mutation = { actorId: string; requestId: string; key: string; method: string; path: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const missing = () => new ApiError(404, 'not_found', 'Not found');
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
};
const reason = (value: unknown) => {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 240)
    throw invalid();
  return value.trim();
};
const day = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !DATE.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw invalid();
  return value;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateIso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const number = (value: unknown) => Number(value);
const isSynthetic = () => process.env.GEOPS_DATA_MODE === 'synthetic';
const assertLabDatabase = async (db: PoolClient) => {
  if (!isSynthetic()) throw new ApiError(409, 'lab_algorithm_disabled', 'Conflict');
  const row = await db.query<{ name: string }>('SELECT current_database() AS name');
  if (!/^geops_verify_[0-9]+$/.test(row.rows[0]?.name ?? ''))
    throw new ApiError(409, 'lab_algorithm_disabled', 'Conflict');
};
const assertTechnicalDatabase = async (db: PoolClient) => {
  if (!isSynthetic()) throw new ApiError(409, 'lab_algorithm_disabled', 'Conflict');
  const row = await db.query<{ name: string }>('SELECT current_database() AS name');
  if (/^geops_verify_[0-9]+$/.test(row.rows[0]?.name ?? '')) return;
  if (isTechnicalStagingRuntime() && row.rows[0]?.name === 'geops_dev') return;
  throw new ApiError(409, 'lab_algorithm_disabled', 'Conflict');
};

export class VisitEvaluationService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async access(db: PoolClient, actor: string, permission: string): Promise<string> {
    const rows = await db.query<{ tenant_id: string }>(
      `SELECT t.tenant_id FROM geops_operating_tenant t
      JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
      JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
      JOIN admin_permission p ON p.admin_id=u.id AND p.permission=$2 AND p.revoked_at IS NULL
      WHERE t.singleton=true`,
      [actor, permission],
    );
    if (!rows.rows[0]) throw new ApiError(403, 'visit_result_forbidden', 'Forbidden');
    return rows.rows[0].tenant_id;
  }

  private async read<T>(
    actor: string,
    permission: string,
    run: (db: PoolClient, tenant: string) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      const tenant = await this.access(db, actor, permission);
      return await run(db, tenant);
    } finally {
      db.release();
    }
  }

  private async mutate<T>(
    ctx: Mutation,
    body: unknown,
    run: (db: PoolClient, tenant: string) => Promise<T>,
  ): Promise<T> {
    uuid(ctx.key);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const tenant = await this.access(db, ctx.actorId, 'visit.evaluation.recompute');
      const hash = createHash('sha256')
        .update(JSON.stringify({ method: ctx.method, path: ctx.path, body }))
        .digest();
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ctx.actorId}:${ctx.key}`]);
      const prior = await db.query<{ payload_digest: Buffer; response_body: T }>(
        'SELECT payload_digest,response_body FROM visit_schedule_idempotency WHERE actor_id=$1 AND request_key=$2',
        [ctx.actorId, ctx.key],
      );
      if (prior.rows[0]) {
        if (!prior.rows[0].payload_digest.equals(hash))
          throw new ApiError(409, 'idempotency_conflict', 'Conflict');
        await db.query('COMMIT');
        return prior.rows[0].response_body;
      }
      const result = await run(db, tenant);
      await db.query(
        `INSERT INTO visit_schedule_idempotency(actor_id,request_key,method,path,payload_digest,response_status,response_body)
        VALUES($1,$2,$3,$4,$5,202,$6)`,
        [ctx.actorId, ctx.key, ctx.method, ctx.path, hash, JSON.stringify(result)],
      );
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async queue(
    db: PoolClient,
    tenant: string,
    assignmentId: string,
    actor: string,
    why: string,
  ) {
    const linked = await db.query(
      `SELECT 1 FROM route_assignment a JOIN agent_device_link l
       ON l.tenant_id=a.tenant_id AND l.agent_id=a.agent_id AND l.state<>'REVOKED'
       AND l.valid_from<a.ends_at AND coalesce(l.valid_to,'infinity'::timestamptz)>a.starts_at
       WHERE a.tenant_id=$1 AND a.id=$2 LIMIT 1`,
      [tenant, assignmentId],
    );
    if (!linked.rowCount && isSynthetic() && !isTechnicalStagingRuntime()) {
      await assertLabDatabase(db);
      const assignment = await db.query(
        `SELECT 1 FROM route_assignment
         WHERE tenant_id=$1 AND id=$2 AND state='PLANNED'`,
        [tenant, assignmentId],
      );
      if (!assignment.rowCount) throw missing();
      await this.insertJob(db, tenant, assignmentId, actor, why, 1);
      return;
    }
    const selected = await db.query<{ revision: number; scope: string }>(
      `SELECT revision,scope FROM visit_algorithm_revision
       WHERE algorithm_id='dwell-pair-v1'
       AND ((scope='APPROVED' AND calibration_evidence_ref IS NOT NULL AND activated_at<=now())
         OR (scope='TECHNICAL_ONLY' AND $1))
       ORDER BY (scope='APPROVED') DESC,revision DESC LIMIT 1`,
      [isSynthetic()],
    );
    if (!selected.rows[0]) throw new ApiError(409, 'algorithm_not_approved', 'Conflict');
    if (selected.rows[0].scope !== 'APPROVED') await assertTechnicalDatabase(db);
    const revision = Number(selected.rows[0].revision);
    const assignment = await db.query(
      `SELECT 1 FROM route_assignment WHERE tenant_id=$1 AND id=$2 AND state='PLANNED'`,
      [tenant, assignmentId],
    );
    if (!assignment.rowCount) throw missing();
    await this.insertJob(db, tenant, assignmentId, actor, why, revision);
  }

  private async insertJob(
    db: PoolClient,
    tenant: string,
    assignmentId: string,
    actor: string,
    why: string,
    revision: number,
  ) {
    await db.query(
      `INSERT INTO visit_evaluation_job(tenant_id,assignment_id,algorithm_id,algorithm_revision,state,reason,requested_by)
      VALUES($1,$2,'dwell-pair-v1',$5,'PENDING',$3,$4)
      ON CONFLICT(tenant_id,assignment_id) DO UPDATE SET state='PENDING',reason=EXCLUDED.reason,
      requested_by=EXCLUDED.requested_by,algorithm_revision=EXCLUDED.algorithm_revision,
      requested_at=now(),next_attempt_at=now(),attempts=0,
      started_at=NULL,finished_at=NULL,last_error_code=NULL`,
      [tenant, assignmentId, why, actor, revision],
    );
  }

  async enqueueAssignment(ctx: Mutation, assignmentId: string, input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join(',') !== 'reason'
    )
      throw invalid();
    const why = reason((input as Row).reason),
      id = uuid(assignmentId);
    return this.mutate(ctx, input, async (db, tenant) => {
      await this.queue(db, tenant, id, ctx.actorId, why);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'visit.evaluation.enqueue',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, assignment_id: id },
      });
      return { assignment_id: id, state: 'PENDING' as const };
    });
  }

  async enqueueDay(ctx: Mutation, localDate: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
    const body = input as Row;
    if (Object.keys(body).some((key) => !['agent_id', 'reason'].includes(key))) throw invalid();
    const date = day(localDate),
      agentId = body.agent_id === undefined ? null : uuid(body.agent_id);
    const why = reason(body.reason);
    return this.mutate(ctx, input, async (db, tenant) => {
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM route_assignment WHERE tenant_id=$1 AND local_date=$2
        AND state='PLANNED' AND ($3::uuid IS NULL OR agent_id=$3) ORDER BY id LIMIT 101`,
        [tenant, date, agentId],
      );
      if (rows.rows.length > 100)
        throw new ApiError(422, 'evaluation_day_too_large', 'Invalid request');
      for (const row of rows.rows) await this.queue(db, tenant, row.id, ctx.actorId, why);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'visit.evaluation.day.enqueue',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, local_date: date, count: rows.rows.length },
      });
      return { local_date: date, queued: rows.rows.length, state: 'PENDING' as const };
    });
  }

  private async assignment(db: PoolClient, tenant: string, assignmentId: string) {
    const rows = await db.query<Row>(
      `SELECT id,agent_id,state,starts_at,ends_at,snapshot_hash
      FROM route_assignment WHERE tenant_id=$1 AND id=$2`,
      [tenant, assignmentId],
    );
    if (!rows.rows[0]) throw missing();
    return rows.rows[0];
  }

  private async samples(
    db: PoolClient,
    tenant: string,
    assignment: Row,
    visit: Row,
    operational: boolean,
  ): Promise<{ samples: DwellSample[]; barriers: string[]; watermark: string | null }> {
    const rows = await db.query<Row>(
      `SELECT p.device_id,p.event_id,p.session_id,l.id AS link_id,
      p.capture_anchor_id,p.boot_id,p.captured_at,p.received_at,p.payload_digest,p.accuracy_m,p.quality_state,
      ST_Distance(p.geom,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography) AS distance_m,
      ST_Distance(p.geom,LAG(p.geom) OVER(PARTITION BY p.device_id ORDER BY p.captured_at,p.event_id)) AS move_distance_m
      FROM position_event p JOIN ${operational ? 'agent_device_link' : 'visit_lab_agent_device_link'} l
        ON l.tenant_id=p.tenant_id AND l.device_id=p.device_id AND l.agent_id=$2
        ${operational ? "AND l.state<>'REVOKED'" : ''}
        AND p.captured_at>=l.valid_from
        AND p.captured_at<${operational ? "coalesce(l.valid_to,'infinity'::timestamptz)" : 'l.valid_to'}
      JOIN gps_effective_session e ON e.id=p.session_id AND e.device_id=p.device_id AND e.tenant_id=p.tenant_id
        AND e.assignment_version=p.assignment_version AND p.captured_at>=e.started_at
        AND (e.stopped_at IS NULL OR p.captured_at<e.stopped_at)
      JOIN gps_scheduled_session s ON s.id=e.scheduled_session_id AND s.device_id=p.device_id
        AND s.assignment_version=p.assignment_version AND p.captured_at>=s.start_at AND p.captured_at<s.end_at
      WHERE p.tenant_id=$1 AND p.captured_at>=$5 AND p.captured_at<$6
      ORDER BY p.captured_at,p.event_id LIMIT 5001`,
      [
        tenant,
        assignment.agent_id,
        visit.longitude,
        visit.latitude,
        assignment.starts_at,
        assignment.ends_at,
      ],
    );
    if (rows.rows.length > 5000)
      throw new ApiError(422, 'evaluation_window_too_large', 'Invalid request');
    const samples = rows.rows.map(
      (row): DwellSample => ({
        deviceId: String(row.device_id),
        eventId: String(row.event_id),
        sessionId: String(row.session_id),
        linkId: String(row.link_id),
        captureAnchorId: String(row.capture_anchor_id),
        bootId: String(row.boot_id),
        capturedAt: dateIso(row.captured_at),
        receivedAt: dateIso(row.received_at),
        payloadDigest: Buffer.isBuffer(row.payload_digest)
          ? row.payload_digest.toString('hex')
          : String(row.payload_digest),
        accuracyM: number(row.accuracy_m),
        distanceM: number(row.distance_m),
        moveDistanceM: row.move_distance_m === null ? null : number(row.move_distance_m),
        qualityState: String(row.quality_state),
      }),
    );
    const sessionIds = [...new Set(samples.map((sample) => sample.sessionId))];
    const barriers = sessionIds.length
      ? (
          await db.query<{ occurred_at: Date }>(
            `SELECT occurred_at FROM gps_session_event
      WHERE tenant_id=$1 AND session_id=ANY($2::uuid[]) AND occurred_at>=$3 AND occurred_at<$4
      AND type IN ('INTERRUPTED','STOPPED','RESUMED') ORDER BY occurred_at`,
            [tenant, sessionIds, assignment.starts_at, assignment.ends_at],
          )
        ).rows.map((row) => row.occurred_at.toISOString())
      : [];
    const watermark = samples.length
      ? (samples
          .map((sample) => sample.receivedAt)
          .sort()
          .at(-1) ?? null)
      : null;
    return { samples, barriers, watermark };
  }

  private async evaluateAssignment(
    db: PoolClient,
    tenant: string,
    assignmentId: string,
    algorithmId: string,
    algorithmRevision: number,
    actorId: string,
    triggerReason: string,
  ): Promise<{ created: number; unchanged: number }> {
    const assignment = await this.assignment(db, tenant, assignmentId);
    if (assignment.state !== 'PLANNED') throw new ApiError(409, 'cancelled_assignment', 'Conflict');
    const algorithm = await db.query<{
      scope: string;
      parameters: unknown;
      calibration_evidence_ref: string | null;
      activated_at: Date | null;
    }>(
      `SELECT scope,parameters,calibration_evidence_ref,activated_at FROM visit_algorithm_revision
      WHERE algorithm_id=$1 AND revision=$2`,
      [algorithmId, algorithmRevision],
    );
    if (!algorithm.rows[0]) throw missing();
    if (
      algorithm.rows[0].scope === 'APPROVED' &&
      (!algorithm.rows[0].calibration_evidence_ref ||
        !algorithm.rows[0].activated_at ||
        algorithm.rows[0].activated_at > this.now())
    )
      throw new ApiError(409, 'algorithm_not_approved', 'Conflict');
    const operational = algorithm.rows[0].scope !== 'LAB_ONLY';
    if (algorithm.rows[0].scope === 'LAB_ONLY') await assertLabDatabase(db);
    if (algorithm.rows[0].scope === 'TECHNICAL_ONLY') await assertTechnicalDatabase(db);
    const params = validateDwellParameters(algorithm.rows[0].parameters);
    if (algorithm.rows[0].scope === 'TECHNICAL_ONLY' && params.non_compliance_enabled !== false)
      throw new ApiError(409, 'algorithm_not_approved', 'Conflict');
    const visits = await db.query<Row>(
      `SELECT stop_id,geofence_revision,latitude,longitude,radius_m,min_dwell_effective_s
      FROM assignment_visit WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY stop_id`,
      [tenant, assignmentId],
    );
    const links = await db.query<Row>(
      `SELECT id,device_id,valid_from,valid_to FROM
      ${operational ? 'agent_device_link' : 'visit_lab_agent_device_link'}
      WHERE tenant_id=$1 AND agent_id=$2
      ${operational ? "AND state<>'REVOKED'" : ''}
      AND valid_from<$4
      AND ${operational ? "coalesce(valid_to,'infinity'::timestamptz)" : 'valid_to'}>$3
      ORDER BY valid_from,id`,
      [tenant, assignment.agent_id, assignment.starts_at, assignment.ends_at],
    );
    let created = 0,
      unchanged = 0;
    const evaluationNow = this.now().toISOString();
    const phase =
      evaluationNow < dateIso(assignment.starts_at)
        ? 'BEFORE'
        : evaluationNow < dateIso(assignment.ends_at)
          ? 'ACTIVE'
          : 'AFTER';
    for (const visit of visits.rows) {
      const evidence = links.rows.length
        ? await this.samples(db, tenant, assignment, visit, operational)
        : { samples: [] as DwellSample[], barriers: [] as string[], watermark: null };
      const result = links.rows.length
        ? evaluateDwell({
            samples: evidence.samples,
            barriers: evidence.barriers,
            radiusM: number(visit.radius_m),
            requiredS: number(visit.min_dwell_effective_s),
            startsAt: dateIso(assignment.starts_at),
            endsAt: dateIso(assignment.ends_at),
            now: evaluationNow,
            parameters: params,
          })
        : null;
      const sourceDigest = digest({
        assignment_hash: assignment.snapshot_hash,
        stop_id: visit.stop_id,
        geofence_revision: visit.geofence_revision,
        algorithm_id: algorithmId,
        algorithm_revision: algorithmRevision,
        phase,
        parameters: params,
        links: links.rows.map((row) => [
          row.id,
          row.device_id,
          dateIso(row.valid_from),
          dateIso(row.valid_to),
        ]),
        samples: evidence.samples.map((sample) => [
          sample.deviceId,
          sample.eventId,
          sample.capturedAt,
          sample.payloadDigest,
          sample.sessionId,
          sample.captureAnchorId,
          sample.bootId,
          sample.accuracyM,
          sample.distanceM,
          sample.moveDistanceM,
          sample.qualityState,
          sample.linkId,
        ]),
        barriers: evidence.barriers,
      });
      const prior = await db.query<{ id: string; evaluation_no: number; source_digest: string }>(
        `SELECT id,evaluation_no,source_digest
        FROM visit_evaluation WHERE tenant_id=$1 AND assignment_id=$2 AND stop_id=$3 ORDER BY evaluation_no DESC LIMIT 1`,
        [tenant, assignmentId, visit.stop_id],
      );
      if (prior.rows[0]?.source_digest === sourceDigest) {
        unchanged++;
        continue;
      }
      const evaluationId = randomUUID(),
        evaluationNo = (prior.rows[0]?.evaluation_no ?? 0) + 1;
      await db.query(
        `INSERT INTO visit_evaluation(id,tenant_id,assignment_id,stop_id,evaluation_no,source_digest,
        algorithm_id,algorithm_revision,parameters,status,required_s,credited_s,percent,first_qualified_at,
        last_qualified_at,completed_at,sample_count,uncertain_count,gap_count,source_watermark,supersedes_id,
        outside_credited_s,unknown_s,coverage_percent,potential_inside_upper_s)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          evaluationId,
          tenant,
          assignmentId,
          visit.stop_id,
          evaluationNo,
          sourceDigest,
          algorithmId,
          algorithmRevision,
          JSON.stringify(params),
          result?.status ?? 'UNATTRIBUTABLE',
          number(visit.min_dwell_effective_s),
          result?.creditedS ?? 0,
          result?.percent ?? 0,
          result?.firstQualifiedAt ?? null,
          result?.lastQualifiedAt ?? null,
          result?.completedAt ?? null,
          result?.sampleCount ?? 0,
          result?.uncertainCount ?? 0,
          result?.gapCount ?? 0,
          evidence.watermark,
          prior.rows[0]?.id ?? null,
          result?.outsideCreditedS ?? null,
          result?.unknownS ?? null,
          result?.coveragePercent ?? null,
          result?.potentialInsideUpperS ?? null,
        ],
      );
      for (const [index, interval] of (result?.intervals ?? []).entries())
        await db.query(
          `INSERT INTO visit_evaluation_interval(evaluation_id,interval_no,device_id,session_id,link_id,operational_link_id,
          event_id_a,event_id_b,from_at,to_at,observed_s,credited_s)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            evaluationId,
            index + 1,
            interval.deviceId,
            interval.sessionId,
            operational ? null : interval.linkId,
            operational ? interval.linkId : null,
            interval.eventIdA,
            interval.eventIdB,
            interval.fromAt,
            interval.toAt,
            interval.observedS,
            interval.creditedS,
          ],
        );
      for (const [index, interval] of (result?.outsideIntervals ?? []).entries())
        await db.query(
          `INSERT INTO visit_evaluation_outside_interval
           (evaluation_id,interval_no,event_id_a,event_id_b,from_at,to_at,seconds)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            evaluationId,
            index + 1,
            interval.eventIdA,
            interval.eventIdB,
            interval.fromAt,
            interval.toAt,
            interval.seconds,
          ],
        );
      await db.query(
        `INSERT INTO visit_evaluation_current(tenant_id,assignment_id,stop_id,evaluation_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,assignment_id,stop_id)
        DO UPDATE SET evaluation_id=EXCLUDED.evaluation_id,updated_at=now()`,
        [tenant, assignmentId, visit.stop_id, evaluationId],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'visit.evaluation.recomputed',
        outcome: 'success',
        correlationId: randomUUID(),
        metadata: {
          tenant_id: tenant,
          assignment_id: assignmentId,
          stop_id: String(visit.stop_id),
          evaluation_no: evaluationNo,
          status: result?.status ?? 'UNATTRIBUTABLE',
          reason: triggerReason,
        },
      });
      created++;
    }
    return { created, unchanged };
  }

  async processNext(): Promise<{
    assignment_id: string;
    created: number;
    unchanged: number;
  } | null> {
    const db = await this.pool.connect();
    let selected: {
      tenant_id: string;
      assignment_id: string;
      algorithm_id: string;
      algorithm_revision: number;
      requested_by: string;
      reason: string;
    } | null = null;
    try {
      await db.query('BEGIN');
      const rows = await db.query<{
        tenant_id: string;
        assignment_id: string;
        algorithm_id: string;
        algorithm_revision: number;
        requested_by: string;
        reason: string;
      }>(
        `SELECT tenant_id,assignment_id,algorithm_id,algorithm_revision,requested_by,reason FROM visit_evaluation_job
        WHERE state='PENDING' AND next_attempt_at<=now()
        ORDER BY requested_at,assignment_id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!rows.rows[0]) {
        await db.query('COMMIT');
        return null;
      }
      selected = rows.rows[0];
      const positionCount = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM route_assignment a
        JOIN ${Number(selected.algorithm_revision) === 1 ? 'visit_lab_agent_device_link' : 'agent_device_link'} l
          ON l.tenant_id=a.tenant_id AND l.agent_id=a.agent_id
          AND l.valid_from<a.ends_at
          AND coalesce(l.valid_to,'infinity'::timestamptz)>a.starts_at
          ${Number(selected.algorithm_revision) === 1 ? '' : "AND l.state<>'REVOKED'"}
        JOIN position_event p ON p.tenant_id=a.tenant_id AND p.device_id=l.device_id
          AND p.captured_at>=greatest(a.starts_at,l.valid_from)
          AND p.captured_at<least(a.ends_at,coalesce(l.valid_to,'infinity'::timestamptz))
        WHERE a.tenant_id=$1 AND a.id=$2`,
        [selected.tenant_id, selected.assignment_id],
      );
      await db.query(
        `UPDATE visit_evaluation_job SET state='RUNNING',started_at=now(),attempts=attempts+1
        WHERE tenant_id=$1 AND assignment_id=$2`,
        [selected.tenant_id, selected.assignment_id],
      );
      const result = await this.evaluateAssignment(
        db,
        selected.tenant_id,
        selected.assignment_id,
        selected.algorithm_id,
        Number(selected.algorithm_revision),
        selected.requested_by,
        selected.reason,
      );
      await db.query(
        `UPDATE visit_evaluation_job SET state='DONE',finished_at=now(),last_error_code=NULL,
        position_count=$3
        WHERE tenant_id=$1 AND assignment_id=$2`,
        [selected.tenant_id, selected.assignment_id, positionCount.rows[0]?.n ?? '0'],
      );
      await db.query('COMMIT');
      return { assignment_id: selected.assignment_id, ...result };
    } catch (error) {
      await db.query('ROLLBACK');
      if (selected)
        await db.query(
          `UPDATE visit_evaluation_job SET
          state=CASE WHEN attempts<2 THEN 'PENDING' ELSE 'FAILED' END,
          finished_at=now(),attempts=attempts+1,
          next_attempt_at=now()+make_interval(secs=>least(300,10*power(2,attempts)::int)),
          last_error_code=$3 WHERE tenant_id=$1 AND assignment_id=$2 AND state='PENDING'`,
          [
            selected.tenant_id,
            selected.assignment_id,
            error instanceof ApiError ? error.code : 'evaluation_failed',
          ],
        );
      throw error;
    } finally {
      db.release();
    }
  }

  async drain(maxJobs = 100) {
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) throw invalid();
    const results = [];
    for (let i = 0; i < maxJobs; i++) {
      const next = await this.processNext();
      if (!next) break;
      results.push(next);
    }
    return results;
  }

  // Bounded polling for synthetic evidence. It does not affect the GPS ingest transaction or ACK.
  async reconcileSynthetic(maxAssignments = 100): Promise<number> {
    if (!Number.isInteger(maxAssignments) || maxAssignments < 1 || maxAssignments > 100)
      throw invalid();
    const db = await this.pool.connect();
    try {
      await assertLabDatabase(db);
      await db.query('BEGIN');
      const rows = await db.query<{
        tenant_id: string;
        assignment_id: string;
        requested_by: string;
        evidence_count: string;
      }>(
        `SELECT a.tenant_id,a.id AS assignment_id,a.created_by AS requested_by,
        count(p.event_id)::text AS evidence_count
        FROM route_assignment a JOIN visit_lab_agent_device_link l
          ON l.tenant_id=a.tenant_id AND l.agent_id=a.agent_id
          AND l.valid_from<a.ends_at AND l.valid_to>a.starts_at
        LEFT JOIN position_event p ON p.tenant_id=a.tenant_id AND p.device_id=l.device_id
          AND p.captured_at>=greatest(a.starts_at,l.valid_from)
          AND p.captured_at<least(a.ends_at,l.valid_to)
        LEFT JOIN visit_evaluation_job j ON j.tenant_id=a.tenant_id AND j.assignment_id=a.id
        WHERE a.state='PLANNED' AND (j.state IS NULL OR (j.state='DONE' AND j.algorithm_revision=1))
        GROUP BY a.tenant_id,a.id,a.created_by,j.state,j.position_count
        HAVING j.state IS NULL OR count(p.event_id)>j.position_count
        ORDER BY a.id LIMIT $1`,
        [maxAssignments],
      );
      let queued = 0;
      for (const row of rows.rows) {
        const result = await db.query(
          `INSERT INTO visit_evaluation_job(tenant_id,assignment_id,algorithm_id,algorithm_revision,state,reason,requested_by)
          VALUES($1,$2,'dwell-pair-v1',1,'PENDING','Synthetic evidence reconciliation',$3)
          ON CONFLICT(tenant_id,assignment_id) DO UPDATE SET state='PENDING',
          reason=EXCLUDED.reason,requested_by=EXCLUDED.requested_by,requested_at=now(),
          next_attempt_at=now(),attempts=0,started_at=NULL,finished_at=NULL,last_error_code=NULL
          WHERE visit_evaluation_job.state='DONE' AND visit_evaluation_job.position_count<$4`,
          [row.tenant_id, row.assignment_id, row.requested_by, row.evidence_count],
        );
        if (result.rowCount) {
          queued++;
          await appendAudit(db, {
            actorType: 'SYSTEM',
            action: 'visit.evaluation.synthetic.reconcile',
            outcome: 'success',
            correlationId: randomUUID(),
            metadata: { tenant_id: row.tenant_id, assignment_id: row.assignment_id },
          });
        }
      }
      await db.query('COMMIT');
      return queued;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  // Bounded asynchronous reconciliation over accepted GPS rows. No GPS ACK path
  // calls this method. Captured timestamps, not receipt timestamps, select links.
  async reconcileOperational(maxAssignments = 100): Promise<number> {
    if (!Number.isInteger(maxAssignments) || maxAssignments < 1 || maxAssignments > 100)
      throw invalid();
    const db = await this.pool.connect();
    try {
      const selected = await db.query<{ revision: number; scope: string }>(
        `SELECT revision,scope FROM visit_algorithm_revision
         WHERE algorithm_id='dwell-pair-v1'
         AND ((scope='APPROVED' AND calibration_evidence_ref IS NOT NULL AND activated_at<=now())
           OR (scope='TECHNICAL_ONLY' AND $1))
         ORDER BY (scope='APPROVED') DESC,revision DESC LIMIT 1`,
        [isSynthetic()],
      );
      if (!selected.rows[0]) return 0;
      if (selected.rows[0].scope !== 'APPROVED') await assertTechnicalDatabase(db);
      const revision = Number(selected.rows[0].revision);
      await db.query('BEGIN');
      const rows = await db.query<{
        tenant_id: string;
        assignment_id: string;
        requested_by: string;
        evidence_count: string;
      }>(
        `SELECT a.tenant_id,a.id AS assignment_id,a.created_by AS requested_by,
        count(p.event_id)::text AS evidence_count
        FROM route_assignment a LEFT JOIN agent_device_link l
          ON l.tenant_id=a.tenant_id AND l.agent_id=a.agent_id AND l.state<>'REVOKED'
          AND l.valid_from<a.ends_at
          AND coalesce(l.valid_to,'infinity'::timestamptz)>a.starts_at
        LEFT JOIN position_event p ON p.tenant_id=a.tenant_id AND p.device_id=l.device_id
          AND p.captured_at>=greatest(a.starts_at,l.valid_from)
          AND p.captured_at<least(a.ends_at,coalesce(l.valid_to,'infinity'::timestamptz))
        LEFT JOIN visit_evaluation_job j ON j.tenant_id=a.tenant_id AND j.assignment_id=a.id
        WHERE a.state='PLANNED' AND a.ends_at<=$3
          AND (j.state IS NULL OR j.state='DONE')
        GROUP BY a.tenant_id,a.id,a.created_by,j.state,j.position_count,j.algorithm_revision,j.finished_at,a.ends_at
        HAVING j.state IS NULL OR j.algorithm_revision<>$2 OR count(p.event_id)>j.position_count
          OR j.finished_at<a.ends_at
        ORDER BY a.id LIMIT $1`,
        [maxAssignments, revision, this.now()],
      );
      let queued = 0;
      for (const row of rows.rows) {
        const result = await db.query(
          `INSERT INTO visit_evaluation_job(tenant_id,assignment_id,algorithm_id,algorithm_revision,state,reason,requested_by)
          VALUES($1,$2,'dwell-pair-v1',$5,'PENDING','Accepted GPS evidence reconciliation',$3)
          ON CONFLICT(tenant_id,assignment_id) DO UPDATE SET state='PENDING',
          algorithm_revision=EXCLUDED.algorithm_revision,reason=EXCLUDED.reason,
          requested_by=EXCLUDED.requested_by,
          requested_at=now(),next_attempt_at=now(),attempts=0,
          started_at=NULL,finished_at=NULL,last_error_code=NULL
          WHERE visit_evaluation_job.state='DONE' AND
            (visit_evaluation_job.algorithm_revision<>$5 OR visit_evaluation_job.position_count<$4
             OR visit_evaluation_job.finished_at<
               (SELECT ends_at FROM route_assignment WHERE tenant_id=$1 AND id=$2))`,
          [row.tenant_id, row.assignment_id, row.requested_by, row.evidence_count, revision],
        );
        if (result.rowCount) {
          queued++;
          await appendAudit(db, {
            actorType: 'SYSTEM',
            action: 'visit.evaluation.operational.reconcile',
            outcome: 'success',
            correlationId: randomUUID(),
            metadata: { tenant_id: row.tenant_id, assignment_id: row.assignment_id },
          });
        }
      }
      await db.query('COMMIT');
      return queued;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async assignmentResults(actor: string, assignmentId: string) {
    const id = uuid(assignmentId);
    return this.read(actor, 'visit.result.read', async (db, tenant) => {
      await this.assignment(db, tenant, id);
      const rows = await db.query<Row>(
        `SELECT v.stop_id,v.client_code,v.site_code,v.geofence_revision,
        v.min_dwell_effective_s AS required_s,e.id AS evaluation_id,e.evaluation_no,e.status,e.credited_s,e.percent,
        e.outside_credited_s,e.unknown_s,e.coverage_percent,e.potential_inside_upper_s,
        e.first_qualified_at,e.last_qualified_at,e.completed_at,e.algorithm_id,e.algorithm_revision,e.evaluated_at,
        ar.scope AS algorithm_scope
        FROM assignment_visit v LEFT JOIN visit_evaluation_current c ON c.tenant_id=v.tenant_id
        AND c.assignment_id=v.assignment_id AND c.stop_id=v.stop_id
        LEFT JOIN visit_evaluation e ON e.id=c.evaluation_id
        LEFT JOIN visit_algorithm_revision ar ON ar.algorithm_id=e.algorithm_id
          AND ar.revision=e.algorithm_revision
        WHERE v.tenant_id=$1 AND v.assignment_id=$2 ORDER BY v.suggested_order NULLS LAST,v.stop_id`,
        [tenant, id],
      );
      const intervals = await db.query<{
        from_at: Date;
        to_at: Date;
        credited_s: number;
        device_id: string;
        event_id_a: string;
        event_id_b: string;
      }>(
        `SELECT i.from_at,i.to_at,i.credited_s,i.device_id,i.event_id_a,i.event_id_b
        FROM visit_evaluation_interval i JOIN visit_evaluation_current c ON c.evaluation_id=i.evaluation_id
        WHERE c.tenant_id=$1 AND c.assignment_id=$2`,
        [tenant, id],
      );
      const physical = uniquePhysicalSeconds(
        intervals.rows.map(
          (row): DwellInterval => ({
            deviceId: row.device_id,
            sessionId: '',
            linkId: '',
            eventIdA: row.event_id_a,
            eventIdB: row.event_id_b,
            fromAt: row.from_at.toISOString(),
            toAt: row.to_at.toISOString(),
            observedS: 0,
            creditedS: Number(row.credited_s),
            creditedFromAt: new Date(
              row.to_at.getTime() - Number(row.credited_s) * 1000,
            ).toISOString(),
          }),
        ),
      );
      const job = await db.query<{
        state: string;
        requested_at: Date;
        finished_at: Date | null;
        last_error_code: string | null;
      }>(
        'SELECT state,requested_at,finished_at,last_error_code FROM visit_evaluation_job WHERE tenant_id=$1 AND assignment_id=$2',
        [tenant, id],
      );
      return {
        assignment_id: id,
        job: job.rows[0] ?? null,
        visits: rows.rows,
        physical_credited_s: physical,
        visit_credited_sum_s: rows.rows.reduce((sum, row) => sum + number(row.credited_s ?? 0), 0),
        agent_device_integration: rows.rows.some((row) => row.algorithm_scope === 'APPROVED')
          ? 'APPROVED'
          : rows.rows.some((row) => row.algorithm_scope === 'TECHNICAL_ONLY')
            ? 'TECHNICAL_ONLY'
            : 'PENDING',
      };
    });
  }

  async technicalPreview(
    actor: string,
    requestId: string,
    assignmentId: string,
    stopId: string,
    accessReason: string,
  ) {
    const id = uuid(assignmentId),
      stop = uuid(stopId),
      why = reason(accessReason);
    return this.read(actor, 'visit.result.read', async (db, tenant) => {
      if (!(await isTechnicalStagingDatabase(db)))
        throw new ApiError(409, 'technical_preview_unavailable', 'Conflict');
      const permissions = await db.query(
        `SELECT permission FROM admin_permission WHERE admin_id=$1
         AND permission IN ('gps.location.read','visit.device.read') AND revoked_at IS NULL`,
        [actor],
      );
      if (permissions.rows.length !== 2)
        throw new ApiError(403, 'visit_map_forbidden', 'Forbidden');
      const assignment = await this.assignment(db, tenant, id);
      if (assignment.state !== 'PLANNED')
        throw new ApiError(409, 'cancelled_assignment', 'Conflict');
      const visit = await db.query<Row>(
        `SELECT stop_id,geofence_revision,latitude,longitude,radius_m,min_dwell_effective_s
         FROM assignment_visit WHERE tenant_id=$1 AND assignment_id=$2 AND stop_id=$3`,
        [tenant, id, stop],
      );
      if (!visit.rows[0]) throw missing();
      const algorithm = await db.query<{ scope: string; parameters: unknown }>(
        `SELECT scope,parameters FROM visit_algorithm_revision
         WHERE algorithm_id='dwell-pair-v1' AND revision=3`,
      );
      if (algorithm.rows[0]?.scope !== 'TECHNICAL_ONLY')
        throw new ApiError(409, 'technical_preview_unavailable', 'Conflict');
      const params = validateDwellParameters(algorithm.rows[0].parameters);
      if (params.non_compliance_enabled !== false)
        throw new ApiError(409, 'technical_preview_unavailable', 'Conflict');
      const links = await db.query(
        `SELECT 1 FROM agent_device_link WHERE tenant_id=$1 AND agent_id=$2
         AND state<>'REVOKED' AND valid_from<$4
         AND coalesce(valid_to,'infinity'::timestamptz)>$3 LIMIT 1`,
        [tenant, assignment.agent_id, assignment.starts_at, assignment.ends_at],
      );
      const evidence = links.rowCount
        ? await this.samples(db, tenant, assignment, visit.rows[0], true)
        : { samples: [] as DwellSample[], barriers: [] as string[], watermark: null };
      const calculated = links.rowCount
        ? evaluateDwell({
            samples: evidence.samples,
            barriers: evidence.barriers,
            radiusM: number(visit.rows[0].radius_m),
            requiredS: number(visit.rows[0].min_dwell_effective_s),
            startsAt: dateIso(assignment.starts_at),
            endsAt: dateIso(assignment.ends_at),
            now: this.now().toISOString(),
            parameters: params,
          })
        : null;
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: actor,
        action: 'visit.evaluation.technical_preview',
        outcome: 'success',
        correlationId: requestId,
        metadata: { tenant_id: tenant, assignment_id: id, stop_id: stop, access_reason: why },
      });
      return {
        assignment_id: id,
        stop_id: stop,
        algorithm_id: 'dwell-pair-v1',
        algorithm_revision: 3,
        algorithm_scope: 'TECHNICAL_ONLY' as const,
        persisted: false as const,
        non_compliance_enabled: false as const,
        status: calculated?.status ?? 'UNATTRIBUTABLE',
        required_s: number(visit.rows[0].min_dwell_effective_s),
        credited_s: calculated?.creditedS ?? 0,
        outside_credited_s: calculated?.outsideCreditedS ?? null,
        unknown_s: calculated?.unknownS ?? null,
        coverage_percent: calculated?.coveragePercent ?? null,
        potential_inside_upper_s: calculated?.potentialInsideUpperS ?? null,
        sample_count: calculated?.sampleCount ?? 0,
        first_qualified_at: calculated?.firstQualifiedAt ?? null,
        last_qualified_at: calculated?.lastQualifiedAt ?? null,
        completed_at: calculated?.completedAt ?? null,
        source_watermark: evidence.watermark,
        credited_intervals:
          calculated?.intervals.map((interval) => ({
            from_at: interval.creditedFromAt,
            to_at: interval.toAt,
            credited_s: interval.creditedS,
          })) ?? [],
      };
    });
  }

  async history(actor: string, assignmentId: string, stopId: string) {
    const id = uuid(assignmentId),
      stop = uuid(stopId);
    return this.read(actor, 'visit.result.read', async (db, tenant) => {
      const exists = await db.query(
        'SELECT 1 FROM assignment_visit WHERE tenant_id=$1 AND assignment_id=$2 AND stop_id=$3',
        [tenant, id, stop],
      );
      if (!exists.rowCount) throw missing();
      const rows = await db.query<Row>(
        `SELECT e.id,e.evaluation_no,e.source_digest,e.algorithm_id,e.algorithm_revision,e.parameters,
        e.status,e.required_s,e.credited_s,e.percent,e.outside_credited_s,e.unknown_s,
        e.coverage_percent,e.potential_inside_upper_s,e.first_qualified_at,e.last_qualified_at,e.completed_at,
        e.sample_count,e.uncertain_count,e.gap_count,e.source_watermark,e.supersedes_id,e.evaluated_at,
        audit.metadata_redacted->>'reason' AS trigger_reason
        FROM visit_evaluation e LEFT JOIN LATERAL (
          SELECT metadata_redacted FROM audit_event
          WHERE occurred_at=e.evaluated_at AND action='visit.evaluation.recomputed'
            AND metadata_redacted->>'tenant_id'=e.tenant_id
            AND metadata_redacted->>'assignment_id'=e.assignment_id::text
            AND metadata_redacted->>'stop_id'=e.stop_id::text
            AND metadata_redacted->>'evaluation_no'=e.evaluation_no::text
          ORDER BY id LIMIT 1
        ) audit ON true
        WHERE e.tenant_id=$1 AND e.assignment_id=$2 AND e.stop_id=$3
        ORDER BY e.evaluation_no DESC LIMIT 100`,
        [tenant, id, stop],
      );
      return { items: rows.rows };
    });
  }

  async evidence(
    actor: string,
    requestId: string,
    assignmentId: string,
    stopId: string,
    evaluationId: string,
    accessReason: string,
  ) {
    const id = uuid(assignmentId),
      stop = uuid(stopId),
      evaluation = uuid(evaluationId),
      why = reason(accessReason);
    return this.read(actor, 'visit.evidence.read', async (db, tenant) => {
      const exists = await db.query(
        'SELECT 1 FROM visit_evaluation WHERE tenant_id=$1 AND assignment_id=$2 AND stop_id=$3 AND id=$4',
        [tenant, id, stop, evaluation],
      );
      if (!exists.rowCount) throw missing();
      const rows = await db.query<Row>(
        `SELECT i.interval_no,i.device_id,i.session_id,i.event_id_a,i.event_id_b,
        i.from_at,i.to_at,i.observed_s,i.credited_s,
        a.captured_at AS event_a_captured_at,a.received_at AS event_a_received_at,
        a.accuracy_m AS event_a_accuracy_m,a.quality_state AS event_a_quality_state,
        b.captured_at AS event_b_captured_at,b.received_at AS event_b_received_at,
        b.accuracy_m AS event_b_accuracy_m,b.quality_state AS event_b_quality_state,
        (a.event_id IS NOT NULL) AS event_a_available,
        (b.event_id IS NOT NULL) AS event_b_available
        FROM visit_evaluation_interval i
        LEFT JOIN position_event a ON a.device_id=i.device_id AND a.event_id=i.event_id_a AND a.tenant_id=$2
        LEFT JOIN position_event b ON b.device_id=i.device_id AND b.event_id=i.event_id_b AND b.tenant_id=$2
        WHERE i.evaluation_id=$1 ORDER BY i.interval_no LIMIT 5000`,
        [evaluation, tenant],
      );
      const outside = await db.query<Row>(
        `SELECT interval_no,event_id_a,event_id_b,from_at,to_at,seconds
         FROM visit_evaluation_outside_interval
         WHERE evaluation_id=$1 ORDER BY interval_no LIMIT 5000`,
        [evaluation],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: actor,
        action: 'visit.evidence.read',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          tenant_id: tenant,
          assignment_id: id,
          stop_id: stop,
          evaluation_id: evaluation,
          access_reason: why,
        },
      });
      return {
        evaluation_id: evaluation,
        items: rows.rows,
        outside_items: outside.rows,
        coordinates_included: false,
      };
    });
  }

  async visitMap(
    actor: string,
    requestId: string,
    assignmentId: string,
    stopId: string,
    accessReason: string,
  ) {
    const id = uuid(assignmentId),
      stop = uuid(stopId),
      why = reason(accessReason);
    return this.read(actor, 'visit.result.read', async (db, tenant) => {
      const permissions = await db.query(
        `SELECT permission FROM admin_permission WHERE admin_id=$1
         AND permission IN ('gps.location.read','visit.device.read') AND revoked_at IS NULL`,
        [actor],
      );
      if (permissions.rows.length !== 2)
        throw new ApiError(403, 'visit_map_forbidden', 'Forbidden');
      const snapshot = await db.query<Row>(
        `SELECT a.agent_id,a.starts_at,a.ends_at,v.latitude,v.longitude,v.radius_m,
         v.geofence_revision,v.site_id,
         ST_Y(cs.center::geometry) AS site_latitude,
         ST_X(cs.center::geometry) AS site_longitude,
         current_geofence.revision AS current_revision,
         ST_Y(current_geofence.center::geometry) AS current_latitude,
         ST_X(current_geofence.center::geometry) AS current_longitude,
         current_geofence.radius_m AS current_radius_m
         FROM route_assignment a JOIN assignment_visit v
           ON v.tenant_id=a.tenant_id AND v.assignment_id=a.id
         JOIN client_site cs ON cs.tenant_id=v.tenant_id AND cs.id=v.site_id
         LEFT JOIN LATERAL (
           SELECT revision,center,radius_m FROM client_geofence_revision g
           WHERE g.tenant_id=v.tenant_id AND g.site_id=v.site_id
           ORDER BY revision DESC LIMIT 1
         ) current_geofence ON true
         WHERE a.tenant_id=$1 AND a.id=$2 AND v.stop_id=$3`,
        [tenant, id, stop],
      );
      const visit = snapshot.rows[0];
      if (!visit) throw missing();
      const positions = await db.query<Row>(
        `SELECT p.event_id,p.device_id,p.session_id,p.captured_at,p.received_at,
         ST_Y(p.geom::geometry) AS latitude,ST_X(p.geom::geometry) AS longitude,
         p.accuracy_m,p.quality_state,
         ST_Distance(p.geom,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography) AS distance_m
         FROM position_event p JOIN agent_device_link l
           ON l.tenant_id=p.tenant_id AND l.device_id=p.device_id
           AND l.agent_id=$2 AND l.state<>'REVOKED'
           AND p.captured_at>=l.valid_from
           AND p.captured_at<coalesce(l.valid_to,'infinity'::timestamptz)
         JOIN gps_effective_session e ON e.id=p.session_id AND e.device_id=p.device_id
           AND e.tenant_id=p.tenant_id AND e.assignment_version=p.assignment_version
           AND p.captured_at>=e.started_at
           AND (e.stopped_at IS NULL OR p.captured_at<e.stopped_at)
         JOIN gps_scheduled_session s ON s.id=e.scheduled_session_id AND s.device_id=p.device_id
           AND s.assignment_version=p.assignment_version
           AND p.captured_at>=s.start_at AND p.captured_at<s.end_at
         WHERE p.tenant_id=$1 AND p.captured_at>=$5 AND p.captured_at<$6
         ORDER BY p.captured_at,p.event_id LIMIT 5001`,
        [tenant, visit.agent_id, visit.longitude, visit.latitude, visit.starts_at, visit.ends_at],
      );
      if (positions.rows.length > 5000)
        throw new ApiError(422, 'evaluation_window_too_large', 'Invalid request');
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: actor,
        action: 'visit.map.read',
        outcome: 'success',
        correlationId: requestId,
        metadata: { tenant_id: tenant, assignment_id: id, stop_id: stop, access_reason: why },
      });
      const radius = number(visit.radius_m);
      return {
        assignment_id: id,
        stop_id: stop,
        window: { starts_at: dateIso(visit.starts_at), ends_at: dateIso(visit.ends_at) },
        site: { latitude: number(visit.site_latitude), longitude: number(visit.site_longitude) },
        historical_geofence: {
          latitude: number(visit.latitude),
          longitude: number(visit.longitude),
          radius_m: radius,
          revision: number(visit.geofence_revision),
        },
        current_geofence:
          visit.current_revision === null
            ? null
            : {
                latitude: number(visit.current_latitude),
                longitude: number(visit.current_longitude),
                radius_m: number(visit.current_radius_m),
                revision: number(visit.current_revision),
              },
        positions: positions.rows.map((row) => {
          const distance = number(row.distance_m),
            accuracy = number(row.accuracy_m);
          return {
            event_id: row.event_id,
            device_id: row.device_id,
            session_id: row.session_id,
            captured_at: dateIso(row.captured_at),
            received_at: dateIso(row.received_at),
            latitude: number(row.latitude),
            longitude: number(row.longitude),
            accuracy_m: accuracy,
            distance_m: distance,
            spatial_state:
              row.quality_state !== 'DEVICE_REPORTED' || accuracy <= 0
                ? 'UNCERTAIN'
                : distance + accuracy <= radius
                  ? 'INSIDE'
                  : distance - accuracy > radius
                    ? 'OUTSIDE'
                    : 'UNCERTAIN',
          };
        }),
      };
    });
  }
}
