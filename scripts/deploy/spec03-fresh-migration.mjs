import assert from 'node:assert/strict';
import pg from 'pg';
import {
  applyMigrations,
  checkReadiness,
  loadMigrations,
} from '../../apps/api/src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS database required');
const pool = new pg.Pool({ connectionString: url });
try {
  const catalog = await loadMigrations();
  assert.equal(catalog.length, 33);
  assert.deepEqual(
    await applyMigrations(pool),
    catalog.map((item) => item.version),
  );
  assert.deepEqual(await applyMigrations(pool), []);
  assert.equal(await checkReadiness(pool), true);
  const actual = (
    await pool.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')
  ).rows;
  assert.deepEqual(
    actual,
    catalog.map((item) => ({ version: item.version, checksum: item.checksum })),
  );
  for (const table of [
    'client',
    'client_site',
    'route_template',
    'agent',
    'route_assignment',
    'agent_device_link',
    'visit_evaluation',
    'position_event',
    'gps_mdm_continuous_authorization',
    'visit_evaluation_outside_interval',
  ]) {
    assert.equal((await pool.query('SELECT to_regclass($1) AS name', [table])).rows[0].name, table);
  }
  console.log('SPEC-03 fresh 0001 -> 0033, schema, checksum and replay: PASS');
} finally {
  await pool.end();
}
