import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Pool } from 'pg';
import { VisitEvaluationScheduler } from '../src/visit-evaluation-scheduler.js';
import type { VisitEvaluationService } from '../src/visit-evaluation.js';
import { isTechnicalStagingRuntime } from '../src/visit-technical-staging.js';

const original = {
  mode: process.env.GEOPS_DATA_MODE,
  origin: process.env.GEOPS_ALLOWED_ORIGINS,
  cookie: process.env.GEOPS_ADMIN_COOKIE_NAME,
};
after(() => {
  process.env.GEOPS_DATA_MODE = original.mode;
  process.env.GEOPS_ALLOWED_ORIGINS = original.origin;
  process.env.GEOPS_ADMIN_COOKIE_NAME = original.cookie;
});

const stage = () => {
  process.env.GEOPS_DATA_MODE = 'synthetic';
  process.env.GEOPS_ALLOWED_ORIGINS = 'https://geops-staging.duckdns.org';
  process.env.GEOPS_ADMIN_COOKIE_NAME = '__Host-geops_stage_admin';
};

const makeScheduler = (database: string) => {
  const calls = { queued: 0, drained: 0 };
  const client = {
    release() {},
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 };
      if (sql.includes('pg_advisory_unlock')) return { rows: [], rowCount: 1 };
      if (sql.includes("scope='APPROVED'")) return { rows: [], rowCount: 0 };
      if (sql.includes('current_database()')) return { rows: [{ name: database }], rowCount: 1 };
      if (sql.includes("scope='TECHNICAL_ONLY'")) return { rows: [{ one: 1 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const evaluation = {
    async reconcileOperational() {
      calls.queued++;
      return 2;
    },
    async drain() {
      calls.drained++;
      return [{}];
    },
  } as unknown as VisitEvaluationService;
  return { scheduler: new VisitEvaluationScheduler(pool, evaluation), calls };
};

test('technical revision runs only for exact staging runtime and database', async () => {
  stage();
  assert.equal(isTechnicalStagingRuntime(), true);
  const allowed = makeScheduler('geops_dev');
  assert.deepEqual(await allowed.scheduler.tick(), { skipped: null, queued: 2, processed: 1 });
  assert.deepEqual(allowed.calls, { queued: 1, drained: 1 });

  const wrongDatabase = makeScheduler('geops_prod');
  assert.deepEqual(await wrongDatabase.scheduler.tick(), {
    skipped: 'ALGORITHM_NOT_APPROVED',
    queued: 0,
    processed: 0,
  });
  assert.deepEqual(wrongDatabase.calls, { queued: 0, drained: 0 });

  process.env.GEOPS_ALLOWED_ORIGINS = 'https://geops.example.com';
  assert.equal(isTechnicalStagingRuntime(), false);
  const wrongOrigin = makeScheduler('geops_dev');
  assert.deepEqual(await wrongOrigin.scheduler.tick(), {
    skipped: 'ALGORITHM_NOT_APPROVED',
    queued: 0,
    processed: 0,
  });
  assert.deepEqual(wrongOrigin.calls, { queued: 0, drained: 0 });
});
