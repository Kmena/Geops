// Upgrade integration schema 0018 -> catalog 0020 in a fresh disposable synthetic database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Fresh disposable synthetic geops_verify_* DB required');
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  assert.equal(
    (await pool.query("SELECT to_regclass('geops_schema_migrations') AS t")).rows[0].t,
    null,
  );
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 20);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'CREATE TABLE geops_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of migrations.slice(0, 18)) {
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
  const adminId = await auth.bootstrap('existing@example.invalid', 'synthetic-password-12345678');
  const deviceId = randomUUID();
  await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'DRAFT',$2)", [
    deviceId,
    'Existing synthetic device',
  ]);
  const before = await pool.query('SELECT count(*)::int AS n FROM admin_permission');
  await pool.query('CREATE TABLE catalog_revision (collision boolean)');
  await assert.rejects(applyMigrations(pool));
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    18,
  );
  assert.equal((await pool.query("SELECT to_regclass('catalog_source') AS t")).rows[0].t, null);
  assert.equal(
    (await pool.query('SELECT status FROM geops_device WHERE id=$1', [deviceId])).rows[0].status,
    'DRAFT',
  );
  await pool.query('DROP TABLE catalog_revision');
  assert.deepEqual(await applyMigrations(pool), [
    '0019_catalog_base.sql',
    '0020_catalog_integrity.sql',
  ]);
  assert.equal(await checkReadiness(pool), true);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM admin_permission')).rows[0].n,
    before.rows[0].n,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE permission LIKE 'catalog.%'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT status FROM geops_device WHERE id=$1', [deviceId])).rows[0].status,
    'DRAFT',
  );
  assert.equal(
    (await pool.query('SELECT state FROM admin_user WHERE id=$1', [adminId])).rows[0].state,
    'ACTIVE',
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_source')).rows[0].n, 0);
  assert.deepEqual(await applyMigrations(pool), []);
  console.log(
    'W1-A-R2 0018 -> 0020 upgrade, rollback, retained data, no grants, idempotence: PASS',
  );
} finally {
  await pool.end();
}
