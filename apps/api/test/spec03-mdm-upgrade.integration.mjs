// Requires an empty disposable geops_verify_* PostGIS database and synthetic fixtures.
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
  throw new Error('Disposable synthetic PostGIS database required');

const pool = new pg.Pool({ connectionString: url });
try {
  const catalog = await loadMigrations();
  assert.equal(catalog.length, 27);
  assert.equal(catalog[22].version, '0023_mdm_oauth_client.sql');
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
    for (const migration of catalog.slice(0, 23)) {
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
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['https://example.invalid'],
  });
  const adminId = await auth.bootstrap(
    'spec03-upgrade@example.invalid',
    'synthetic-password-12345678',
  );
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [adminId, randomUUID()],
  );
  const mdmId = randomUUID();
  await pool.query(
    "INSERT INTO mdm_integration(id,provider,region,customer_id,status) VALUES($1,'manageengine','com','12345','DISCONNECTED')",
    [mdmId],
  );
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'mdm.oauth.configure',$1,'Synthetic upgrade check')",
    [adminId],
  );
  const before = (
    await pool.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')
  ).rows;

  assert.deepEqual(
    await applyMigrations(pool),
    catalog.slice(23).map((migration) => migration.version),
  );
  assert.deepEqual(await applyMigrations(pool), []);
  assert.equal(await checkReadiness(pool), true);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT version,checksum FROM geops_schema_migrations ORDER BY version LIMIT 23',
      )
    ).rows,
    before,
  );
  assert.equal(
    (await pool.query('SELECT status FROM mdm_integration WHERE id=$1', [mdmId])).rows[0].status,
    'DISCONNECTED',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE admin_id=$1 AND permission='mdm.oauth.configure'",
        [adminId],
      )
    ).rows[0].n,
    1,
  );
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'visit.result.read',$1,'Synthetic upgrade check')",
    [adminId],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE admin_id=$1 AND permission='visit.result.read'",
        [adminId],
      )
    ).rows[0].n,
    1,
  );
  console.log('MDM 23 -> SPEC-03 27 upgrade, data, checksums and replay: PASS');
} finally {
  await pool.end();
}
