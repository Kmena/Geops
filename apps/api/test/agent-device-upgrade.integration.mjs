// Requires an empty disposable geops_verify_* PostGIS database and synthetic mode.
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';

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
  assert.equal(catalog[26].version, '0027_visit_dwell_engine.sql');
  assert.equal(catalog[27].version, '0028_agent_device_links.sql');
  assert.equal(catalog[28].version, '0029_geops_gps_identity.sql');
  assert.equal(catalog[29].version, '0030_gps_continuity_geops_owner.sql');
  assert.equal(catalog[30].version, '0031_agent_responsibility_geocoding.sql');
  assert.equal(catalog[31].version, '0032_mdm_continuous_capture.sql');
  assert.equal(catalog[32].version, '0033_visit_coverage_calibration.sql');
  assert.equal(
    (await pool.query("SELECT to_regclass('geops_schema_migrations') AS name")).rows[0].name,
    null,
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of catalog.slice(0, 27)) {
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
  const before = (
    await pool.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')
  ).rows;
  assert.deepEqual(await applyMigrations(pool), [
    '0028_agent_device_links.sql',
    '0029_geops_gps_identity.sql',
    '0030_gps_continuity_geops_owner.sql',
    '0031_agent_responsibility_geocoding.sql',
    '0032_mdm_continuous_capture.sql',
    '0033_visit_coverage_calibration.sql',
  ]);
  assert.deepEqual(await applyMigrations(pool), []);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT version,checksum FROM geops_schema_migrations ORDER BY version LIMIT 27',
      )
    ).rows,
    before,
  );
  assert.equal(await checkReadiness(pool), true);
  assert.equal(
    (await pool.query("SELECT to_regclass('agent_device_link') AS name")).rows[0].name,
    'agent_device_link',
  );
  console.log('SPEC-03 release 0027 -> 0033, checksum and replay: PASS');
} finally {
  await pool.end();
}
