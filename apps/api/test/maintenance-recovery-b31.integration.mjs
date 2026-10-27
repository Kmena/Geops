// Run only against a fresh disposable geops_verify_* PostGIS database; verify B30→B31 recovery.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { beginMaintenance } from '../src/db/maintenance-gate.ts';
import { recoverMaintenance } from '../src/db/maintenance-recovery.ts';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';
import { gateAllowsTraffic, readGate, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
if (
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !url ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1))
)
  throw new Error('Disposable synthetic PostGIS database required');

const target = new URL(url).pathname.slice(1);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const root = await mkdtemp(join(tmpdir(), 'geops-b31-supervised-'));
const gate = join(root, 'security-gate.json');
try {
  assert.equal(
    (await pool.query("SELECT to_regclass('geops_schema_migrations') AS name")).rows[0].name,
    null,
    'fresh disposable database required',
  );
  const catalog = await loadMigrations();
  assert.equal(catalog.length, 31);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of catalog.slice(0, 30)) {
      await db.query(migration.sql);
      await db.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)', [
        migration.version,
        migration.checksum,
      ]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 81),
    csrfKey: Buffer.alloc(32, 82),
    allowedOrigins: ['https://example.invalid'],
  });
  await auth.bootstrap('existing@example.invalid', 'synthetic-password-12345678');
  await pool.query('INSERT INTO security_epoch(singleton,epoch) VALUES(true,$1)', [randomUUID()]);
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic B23')",
    [randomUUID()],
  );
  const baseline = (
    await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM geops_device) AS devices`)
  ).rows[0];
  assert.equal(baseline.migrations, 30);
  assert.ok(baseline.admins > 0 && baseline.devices > 0 && baseline.epoch);
  const custody = new SupervisedRecoveryService(pool, Buffer.alloc(32, 97));
  for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
    await custody.registerSyntheticCustodian(email, 'synthetic-password-12345678');
  await writeGate(gate, { version: 1, phase: 'open', epoch: baseline.epoch });
  await beginMaintenance(pool, gate, target, baseline.epoch);
  assert.equal(await gateAllowsTraffic(pool, gate), false);
  assert.deepEqual((await applyMigrations(pool)).length, 1);
  assert.equal((await readGate(gate)).phase, 'maintenance');
  assert.equal(await checkReadiness(pool), true);

  const request = () => ({
    target,
    epoch: baseline.epoch,
    requestId: randomUUID(),
    reason: 'Approved synthetic B30 to B31 forward recovery',
    adminEmail: 'existing@example.invalid',
    adminPassword: 'synthetic-password-12345678',
    custodians: [
      { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
      { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
    ],
    compatibleReleaseConfirmed: true,
  });
  const constraint = (
    await pool.query(
      "SELECT pg_get_indexdef('gps_continuity_alert_one_open'::regclass) AS definition",
    )
  ).rows[0].definition;
  await pool.query('DROP INDEX gps_continuity_alert_one_open');
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  assert.equal((await readGate(gate)).phase, 'maintenance');
  await pool.query(constraint);

  const authorized = request();
  assert.equal(await recoverMaintenance(pool, gate, authorized), 31);
  assert.equal(await gateAllowsTraffic(pool, gate), true);
  assert.equal((await readGate(gate)).phase, 'open');
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE correlation_id=$1 AND action='maintenance.recovery.validated' AND metadata_redacted->>'schema'='31'",
        [authorized.requestId],
      )
    ).rows[0].n,
    1,
  );
  const after = (
    await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM geops_device) AS devices`)
  ).rows[0];
  assert.deepEqual(after, { ...baseline, migrations: 31 });
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  console.log('Supervised B30→B31 recovery: PASS');
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
