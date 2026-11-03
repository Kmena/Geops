// Upgrade catalog 0019 -> 0020 in a fresh disposable synthetic geops_verify_* database.
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
    for (const migration of migrations.slice(0, 19)) {
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
    sessionKey: Buffer.alloc(32, 101),
    csrfKey: Buffer.alloc(32, 102),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const actor = await auth.bootstrap('w1ar-upgrade@example.invalid', 'synthetic-password-12345678');
  const routeId = randomUUID();
  const routeVersionId = randomUUID();
  const establishmentId = randomUUID();
  const pinId = randomUUID();
  const stopId = randomUUID();
  await pool.query('INSERT INTO catalog_route(id,name,created_by) VALUES($1,$2,$3)', [
    routeId,
    'Historical draft',
    actor,
  ]);
  await pool.query(
    'INSERT INTO catalog_route_version(id,route_id,revision,created_by) VALUES($1,$2,1,$3)',
    [routeVersionId, routeId, actor],
  );
  await pool.query(
    'INSERT INTO catalog_establishment(id,name,archived_at,created_by) VALUES($1,$2,now(),$3)',
    [establishmentId, 'Historical archived branch', actor],
  );
  await pool.query(
    "INSERT INTO catalog_pin(id,establishment_id,geog,state,created_by) VALUES($1,$2,ST_GeogFromText('SRID=4326;POINT(-84 10)'),'ARCHIVED',$3)",
    [pinId, establishmentId, actor],
  );
  await pool.query(
    'INSERT INTO catalog_route_stop(id,route_version_id,label,establishment_id,pin_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [stopId, routeVersionId, 'Historical candidate', establishmentId, pinId, actor],
  );
  const versionBefore = (await pool.query('SELECT version FROM catalog_revision')).rows[0].version;
  await pool.query(
    'CREATE FUNCTION catalog_assert_active_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$',
  );
  await assert.rejects(applyMigrations(pool));
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    19,
  );
  assert.equal(
    (await pool.query("SELECT to_regclass('audit_event_catalog_denial_request') AS t")).rows[0].t,
    null,
  );
  assert.equal(
    (await pool.query('SELECT version FROM catalog_revision')).rows[0].version,
    versionBefore,
  );
  await pool.query('DROP FUNCTION catalog_assert_active_source()');
  assert.deepEqual(await applyMigrations(pool), ['0020_catalog_integrity.sql']);
  assert.equal(await checkReadiness(pool), true);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM catalog_route_stop WHERE id=$1 AND establishment_id=$2 AND pin_id=$3',
        [stopId, establishmentId, pinId],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    pool.query(
      'INSERT INTO catalog_route_stop(id,route_version_id,label,establishment_id,pin_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), routeVersionId, 'New invalid candidate', establishmentId, pinId, actor],
    ),
    (error) => error.code === '23514',
  );
  assert.deepEqual(await applyMigrations(pool), []);
  console.log(
    'W1-A-R2 0019 -> 0020 upgrade, rollback, historical references and idempotence: PASS',
  );
} finally {
  await pool.end();
}
