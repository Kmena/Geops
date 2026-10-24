// Requires a disposable geops_verify_* database prepared with prepare-21.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { beginMaintenance } from '../src/db/maintenance-gate.ts';
import { recoverMaintenance } from '../src/db/maintenance-recovery.ts';
import { checkReadiness } from '../src/db/migration-manager.ts';
import { gateAllowsTraffic, readGate, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
if (
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1))
)
  throw new Error('Disposable synthetic PostgreSQL required');

const target = new URL(url).pathname.slice(1);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const directory = await mkdtemp(join(tmpdir(), 'geops-recovery-22-'));
const gatePath = join(directory, 'security-gate.json');
try {
  const before = (
    await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM geops_device) AS devices,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`)
  ).rows[0];
  assert.equal(before.migrations, 21);
  assert.ok(before.admins > 0 && before.sessions > 0 && before.devices > 0);
  assert.equal(await checkReadiness(pool), false, 'B22 API cannot start against A21 ledger');
  const custody = new SupervisedRecoveryService(pool, Buffer.alloc(32, 91));
  for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
    await custody.registerSyntheticCustodian(email, 'synthetic-password-12345678');
  await writeGate(gatePath, { version: 1, phase: 'open', epoch: before.epoch });
  await beginMaintenance(pool, gatePath, target, before.epoch);
  const authorization = () => ({
    target,
    epoch: before.epoch,
    requestId: randomUUID(),
    reason: 'Reviewed synthetic A21 to B22 recovery',
    adminEmail: 'existing@example.invalid',
    adminPassword: 'synthetic-password-12345678',
    custodians: [
      { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
      { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
    ],
    compatibleReleaseConfirmed: true,
  });
  await assert.rejects(
    recoverMaintenance(pool, gatePath, authorization(), async (stage, migration) => {
      if (stage === 'before_commit' && migration === '0022_mdm_web_oauth.sql')
        throw new Error('Injected 0022 precommit failure');
    }),
    /Injected 0022 precommit failure/,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    21,
  );
  assert.equal(
    (await pool.query("SELECT to_regclass('mdm_oauth_pending') AS rel")).rows[0].rel,
    null,
  );
  assert.equal((await readGate(gatePath)).phase, 'maintenance');
  await assert.rejects(
    recoverMaintenance(pool, gatePath, authorization(), async (stage, migration) => {
      if (stage === 'migrated' && migration === '0022_mdm_web_oauth.sql')
        throw new Error('Injected 0022 postcommit interruption');
    }),
    /Injected 0022 postcommit interruption/,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    22,
  );
  assert.equal((await readGate(gatePath)).phase, 'maintenance');
  assert.equal(await recoverMaintenance(pool, gatePath, authorization()), 22);
  assert.equal(await gateAllowsTraffic(pool, gatePath), true);
  assert.equal(await checkReadiness(pool), true);
  const after = (
    await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM geops_device) AS devices,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`)
  ).rows[0];
  assert.deepEqual(after, { ...before, migrations: 22 });
  assert.ok((await pool.query("SELECT to_regclass('mdm_oauth_pending') AS rel")).rows[0].rel);
  assert.ok(
    (await pool.query("SELECT to_regclass('mdm_oauth_one_pending_tenant') AS rel")).rows[0].rel,
  );
  await assert.rejects(
    recoverMaintenance(pool, gatePath, authorization()),
    'open gate rejects replay',
  );
  console.log('Disposable A21 to B22 supervised recovery: PASS');
} finally {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
