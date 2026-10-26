// Requires an empty, disposable geops_verify_* PostGIS database with synthetic data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { applyMigrations, checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (!url || !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic')
  throw new Error('Disposable synthetic PostGIS database required');
const pool = new pg.Pool({ connectionString: url });
try {
  const catalog = await loadMigrations();
  assert.equal(catalog.length, 23);
  assert.equal((await pool.query("SELECT to_regclass('geops_schema_migrations') AS name")).rows[0].name, null);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of catalog.slice(0, 22)) {
      await db.query(migration.sql);
      await db.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)',
        [migration.version, migration.checksum]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11), csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['https://example.invalid'],
  });
  const adminId = await auth.bootstrap('oauth-upgrade@example.invalid', 'synthetic-password-12345678');
  await pool.query("INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [adminId, randomUUID()]);
  await pool.query("INSERT INTO mdm_integration(id,provider,region,customer_id,status) VALUES($1,'manageengine','com','12345','DISCONNECTED')",
    [randomUUID()]);
  assert.deepEqual(await applyMigrations(pool), ['0023_mdm_oauth_client.sql']);
  assert.equal(await checkReadiness(pool), true);
  assert.equal((await pool.query("SELECT status FROM mdm_integration WHERE customer_id='12345'")).rows[0].status, 'DISCONNECTED');
  assert.equal((await pool.query("SELECT 1 FROM admin_user WHERE id=$1", [adminId])).rowCount, 1);
  assert.equal((await pool.query("SELECT to_regclass('mdm_oauth_client_config') AS name")).rows[0].name, 'mdm_oauth_client_config');
  console.log('B22 22 -> 23 OAuth client migration: PASS');
} finally {
  await pool.end();
}
