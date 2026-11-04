import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic geops_verify_* database required');
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 40);
  assert.equal(migrations[34].version, '0035_legacy_device_decommission.sql');
  assert.deepEqual(
    migrations.slice(35).map((m) => m.version),
    [
      '0036_kmz_staging.sql',
      '0037_kmz_analysis.sql',
      '0038_kmz_review.sql',
      '0039_kmz_confirmation.sql',
      '0040_kmz_retention.sql',
    ],
  );
  assert.equal(
    (await pool.query("SELECT to_regclass('geops_schema_migrations') AS t")).rows[0].t,
    null,
  );
  await pool.query('BEGIN');
  await pool.query(
    'CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const migration of migrations.slice(0, 35)) {
    await pool.query(migration.sql);
    await pool.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)', [
      migration.version,
      migration.checksum,
    ]);
  }
  await pool.query('COMMIT');
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    35,
  );
  assert.equal(
    (await pool.query("SELECT to_regclass('client_site') AS t")).rows[0].t,
    'client_site',
  );
  await pool.query('CREATE TABLE catalog_revision (collision boolean)');
  await assert.rejects(applyMigrations(pool));
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    35,
  );
  assert.equal((await pool.query("SELECT to_regclass('kmz_import_session') AS t")).rows[0].t, null);
  await pool.query('DROP TABLE catalog_revision');
  assert.deepEqual(
    await applyMigrations(pool),
    migrations.slice(35).map((m) => m.version),
  );
  assert.equal(await checkReadiness(pool), true);
  assert.deepEqual(await applyMigrations(pool), []);
  const ledger = await pool.query(
    'SELECT version,checksum FROM geops_schema_migrations ORDER BY version',
  );
  assert.deepEqual(
    ledger.rows,
    migrations.map(({ version, checksum }) => ({ version, checksum })),
  );
  for (const relation of [
    'client',
    'client_site',
    'gps_data_tenant_access',
    'mdm_inventory_device',
    'kmz_import_session',
    'kmz_analysis_run',
    'kmz_review_record',
    'kmz_import_commit',
    'kmz_import_operation',
  ])
    assert.equal((await pool.query('SELECT to_regclass($1) AS t', [relation])).rows[0].t, relation);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('catalog_customer','catalog_establishment') AND relkind='r'",
      )
    ).rows[0].n,
    0,
  );
  console.log('B32 0035 -> SPEC-03 0040, rollback, retry, checksums, GPS/MDM compatibility: PASS');
} finally {
  await pool.end();
}
