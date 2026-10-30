import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { VisitEvaluationService } from '../src/visit-evaluation.js';

test('automatic reconciliation queues a pre-revision-3 route without changing its source', async () => {
  const connectionString = process.env.GEOPS_AUTO_EVAL_LAB_URL;
  if (!connectionString) throw new Error('GEOPS_AUTO_EVAL_LAB_URL required');
  const url = new URL(connectionString);
  if (url.hostname !== '127.0.0.1' || url.port !== '55444' || url.pathname !== '/geops_dev')
    throw new Error('Disposable local lab database required');
  process.env.GEOPS_DATA_MODE = 'synthetic';
  process.env.GEOPS_ALLOWED_ORIGINS = 'https://geops-staging.duckdns.org';
  process.env.GEOPS_ADMIN_COOKIE_NAME = '__Host-geops_stage_admin';
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`
      CREATE TABLE visit_algorithm_revision (
        algorithm_id text NOT NULL, revision integer NOT NULL, scope text NOT NULL,
        calibration_evidence_ref text, activated_at timestamptz
      );
      CREATE TABLE route_assignment (
        tenant_id text NOT NULL, id uuid NOT NULL, agent_id uuid NOT NULL,
        created_by uuid NOT NULL, state text NOT NULL, starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE agent_device_link (
        tenant_id text NOT NULL, agent_id uuid NOT NULL, device_id uuid NOT NULL,
        state text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz
      );
      CREATE TABLE position_event (
        tenant_id text NOT NULL, device_id uuid NOT NULL, event_id uuid NOT NULL,
        captured_at timestamptz NOT NULL
      );
      CREATE TABLE visit_evaluation_job (
        tenant_id text NOT NULL, assignment_id uuid NOT NULL, algorithm_id text NOT NULL,
        algorithm_revision integer NOT NULL, state text NOT NULL, reason text NOT NULL,
        requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
        next_attempt_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
        started_at timestamptz, finished_at timestamptz, last_error_code text,
        position_count bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id,assignment_id)
      );
      CREATE TABLE audit_event (
        id uuid PRIMARY KEY, actor_type text NOT NULL, actor_id uuid, device_id uuid,
        action text NOT NULL, outcome text NOT NULL, correlation_id uuid NOT NULL,
        previous_state text, next_state text, metadata_redacted jsonb NOT NULL
      );
      INSERT INTO visit_algorithm_revision(algorithm_id,revision,scope)
      VALUES('dwell-pair-v1',3,'TECHNICAL_ONLY');
      INSERT INTO route_assignment
        (tenant_id,id,agent_id,created_by,state,starts_at,ends_at,created_at)
      VALUES
        ('stage','11111111-1111-4111-8111-111111111111',
         '22222222-2222-4222-8222-222222222222',
         '33333333-3333-4333-8333-333333333333','PLANNED',
         '2026-10-29T00:00:00Z','2026-10-29T04:00:00Z','2026-10-28T12:00:00Z');
      INSERT INTO agent_device_link(tenant_id,agent_id,device_id,state,valid_from,valid_to)
      VALUES('stage','22222222-2222-4222-8222-222222222222',
        '44444444-4444-4444-8444-444444444444','ACTIVE',
        '2026-10-28T23:00:00Z','2026-10-29T05:00:00Z');
      INSERT INTO position_event(tenant_id,device_id,event_id,captured_at)
      VALUES('stage','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','2026-10-29T00:10:00Z');
    `);
    const service = new VisitEvaluationService(pool, () => new Date('2026-10-30T03:00:00Z'));
    assert.equal(await service.reconcileOperational(100), 1);
    const queued = await pool.query<{ algorithm_revision: number; state: string }>(
      'SELECT algorithm_revision,state FROM visit_evaluation_job',
    );
    assert.deepEqual(queued.rows, [{ algorithm_revision: 3, state: 'PENDING' }]);
    assert.equal(await service.reconcileOperational(100), 0);
    const source = await pool.query<{ state: string; created_at: Date }>(
      'SELECT state,created_at FROM route_assignment',
    );
    assert.equal(source.rows[0]?.state, 'PLANNED');
    assert.equal(source.rows[0]?.created_at.toISOString(), '2026-10-28T12:00:00.000Z');
  } finally {
    await pool.end();
  }
});
