// The name geops_dev exists only inside an explicitly disposable local/CI PostGIS container.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { beginMaintenance, finishMaintenance } from '../src/db/maintenance-gate.ts';
import { recoverMaintenance } from '../src/db/maintenance-recovery.ts';
import { checkReadiness } from '../src/db/migration-manager.ts';
import { gateAllowsTraffic, readGate, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
if (
  process.env.GEOPS_DISPOSABLE_MAINTENANCE_REHEARSAL !== 'YES' ||
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !url ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  new URL(url).pathname !== '/geops_dev'
)
  throw new Error('Explicit local disposable geops_dev rehearsal required');

const root = await mkdtemp(join(tmpdir(), 'geops-maintenance-cli-'));
const gatePath = join(root, 'security-gate.json');
const migratePath = fileURLToPath(new URL('../dist/db/migrate.js', import.meta.url));
const gateCliPath = fileURLToPath(new URL('../dist/db/security-gate-cli.js', import.meta.url));
const pool = () => new pg.Pool({ connectionString: url, max: 1 });
let db = pool();
try {
  const before = await db.query(
    `SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`,
  );
  assert.equal(before.rows[0].migrations, 14);
  assert.ok(
    before.rows[0].admins > 0 && before.rows[0].sessions > 0 && before.rows[0].device_sessions > 0,
  );
  assert.ok(before.rows[0].permissions > 0 && before.rows[0].epoch);
  const epoch = before.rows[0].epoch;
  await writeGate(gatePath, { version: 1, phase: 'open', epoch });
  assert.equal(await gateAllowsTraffic(db, gatePath), true);

  const runMigrate = (confirmedEpoch) =>
    spawnSync(process.execPath, [migratePath], {
      env: {
        ...process.env,
        DATABASE_URL: url,
        GEOPS_DATA_MODE: 'synthetic',
        GEOPS_MIGRATION_TARGET: 'geops_dev',
        GEOPS_CONFIRM_MIGRATION_TARGET: 'geops_dev',
        GEOPS_ALLOW_NONDISPOSABLE_MIGRATION: 'YES',
        GEOPS_SECURITY_GATE_PATH: gatePath,
        GEOPS_CONFIRM_MAINTENANCE_EPOCH: confirmedEpoch,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  await db.end();
  assert.equal(runMigrate(epoch).status, 1, 'open gate refuses persistent migration');
  db = pool();
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    14,
  );
  const isolation = await db.query(
    'SELECT e.epoch::text AS epoch,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS others FROM security_epoch e WHERE singleton=true',
  );
  assert.equal(isolation.rows[0].epoch, epoch);
  assert.equal(isolation.rows[0].others, 0, 'migration rehearsal database isolated');
  await beginMaintenance(db, gatePath, 'geops_dev', epoch);
  assert.equal(await gateAllowsTraffic(db, gatePath), false);
  await assert.rejects(
    finishMaintenance(db, gatePath, 'geops_dev', epoch),
    'failed or unrun 0015 cannot reopen through normal finish',
  );
  await db.end();
  assert.equal(runMigrate('00000000-0000-4000-8000-000000000000').status, 1);
  assert.equal(runMigrate(epoch).status, 0, 'compiled migrator upgrades only under maintenance');
  db = pool();
  const after = await db.query(
    `SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`,
  );
  assert.deepEqual(after.rows[0], { ...before.rows[0], migrations: 21 });
  assert.equal(await checkReadiness(db), true);
  await db.end();
  const legacyFinish = spawnSync(process.execPath, [gateCliPath, 'maintenance-finish'], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      GEOPS_DATA_MODE: 'synthetic',
      GEOPS_SECURITY_GATE_PATH: gatePath,
      GEOPS_CONFIRM_MAINTENANCE_TARGET: 'geops_dev',
      GEOPS_CONFIRM_MAINTENANCE_EPOCH: epoch,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(legacyFinish.status, 1, 'old finish CLI cannot reopen persistent schema');
  db = pool();
  const custody = new SupervisedRecoveryService(db, Buffer.alloc(32, 86));
  for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
    await custody.registerSyntheticCustodian(email, 'synthetic-password-12345678');
  assert.equal(
    await recoverMaintenance(db, gatePath, {
      target: 'geops_dev',
      epoch,
      requestId: randomUUID(),
      reason: 'Approved disposable persistent-name rehearsal',
      adminEmail: 'existing@example.invalid',
      adminPassword: 'synthetic-password-12345678',
      custodians: [
        { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
        { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
      ],
      compatibleReleaseConfirmed: true,
    }),
    21,
  );
  const opened = await readGate(gatePath);
  assert.equal(opened.phase, 'open');
  assert.ok(opened.nonce, 'open gate remains bound to upgraded database marker');
  assert.equal(await gateAllowsTraffic(db, gatePath), true);
  await db.query('UPDATE geops_maintenance_marker SET nonce=$1 WHERE singleton=true', [
    '00000000-0000-4000-8000-000000000001',
  ]);
  assert.equal(
    await gateAllowsTraffic(db, gatePath),
    false,
    'older backup marker cannot serve traffic',
  );
  await db.query('UPDATE geops_maintenance_marker SET nonce=$1 WHERE singleton=true', [
    opened.nonce,
  ]);
  assert.equal(await gateAllowsTraffic(db, gatePath), true);
  console.log('Disposable geops_dev compiled maintenance CLI rehearsal: PASS');
} finally {
  await db.end().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
