// W6-R1: synthetic-only 0040 dump/restore/0042 rehearsal.
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';

const mode = process.argv[2];
const url = process.env.DATABASE_URL;
if (!['seed', 'verify'].includes(mode) || !url ||
    !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
    !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic')
  throw new Error('Disposable synthetic database and seed|verify mode required');

const deviceId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const installationId = '33333333-3333-4333-8333-333333333333';
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 42);
  if (mode === 'seed') {
    assert.equal((await pool.query("SELECT to_regclass('geops_schema_migrations') AS name")).rows[0].name, null);
    await pool.query('BEGIN');
    await pool.query('CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of migrations.slice(0, 40)) {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)',
        [migration.version, migration.checksum]);
    }
    await pool.query('COMMIT');
    await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic restore device')", [deviceId]);
    await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic-tenant',$3,'ACTIVE')",
      [bindingId, deviceId, `synthetic-${deviceId}`]);
    await pool.query('INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,now(),$3,$4)',
      [installationId, deviceId, bindingId, 'synthetic-tenant']);
    console.log('synthetic schema 0040 seeded: one device, binding, installation');
  } else {
    const ledger = (await pool.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')).rows;
    assert.deepEqual(ledger, migrations.slice(0, 40).map(({version,checksum}) => ({version,checksum})));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM geops_device WHERE id=$1', [deviceId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mdm_binding WHERE id=$1 AND geops_device_id=$2', [bindingId,deviceId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gps_device_installation WHERE installation_id=$1 AND device_id=$2', [installationId,deviceId])).rows[0].n, 1);
    assert.deepEqual(await applyMigrations(pool), migrations.slice(40).map((item) => item.version));
    assert.equal(await checkReadiness(pool), true);
    assert.deepEqual(await applyMigrations(pool), []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM geops_device WHERE id=$1', [deviceId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gps_device_installation WHERE installation_id=$1 AND device_id=$2', [installationId,deviceId])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT to_regclass('device_diagnostic_snapshot') AS name")).rows[0].name, 'device_diagnostic_snapshot');
    assert.equal((await pool.query("SELECT to_regclass('mdm_remediation_request') AS name")).rows[0].name, 'mdm_remediation_request');
    console.log('synthetic 0040 dump/restore and 0041-0042 migration PASS: ledger, device, binding, installation, readiness');
  }
} finally {
  await pool.end();
}
