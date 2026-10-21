// One-shot 0015 -> 0016 upgrade rehearsal in a new disposable PostGIS database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable DB required');
const pool = new pg.Pool({ connectionString: url });
try {
  const identity = await pool.query(`SELECT current_database() AS name,
    to_regclass('geops_schema_migrations') AS version_table`);
  assert.match(identity.rows[0].name, /^geops_verify_[0-9]+$/);
  assert.equal(identity.rows[0].version_table, null, 'test needs an empty disposable database');
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 16);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,
      checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of migrations.slice(0, 15)) {
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
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const admin = await auth.bootstrap(
    'migration-r4a@example.invalid',
    'synthetic-password-12345678',
  );
  const device = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic migration continuity')",
    [device],
  );
  assert.deepEqual(await applyMigrations(pool), ['0016_gps_continuity_alerts.sql']);
  assert.equal(await checkReadiness(pool), true);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM admin_user WHERE id=$1', [admin])).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_device WHERE id=$1', [device])).rows[0]
      .n,
    1,
  );
  assert.deepEqual(await applyMigrations(pool), []);
  console.log('gps-continuity migration PASS: 0015 -> 0016, data preserved, idempotent');
} finally {
  await pool.end();
}
