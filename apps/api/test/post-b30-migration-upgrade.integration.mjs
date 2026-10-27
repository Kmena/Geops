// Fresh disposable PostGIS only. Tests an actual schema 30 -> 31 upgrade with an active B30 link.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { applyMigrations, loadMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS required');
const pool = new pg.Pool({ connectionString: url, max: 2 });
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
try {
  const migrations = await loadMigrations();
  check(
    migrations.length === 31 && migrations[30].version.startsWith('0031_'),
    'exactly 31 ordered migrations',
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'CREATE TABLE geops_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of migrations.slice(0, 30)) {
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
  check(
    (await pool.query('SELECT count(*) FROM geops_schema_migrations')).rows[0].count === '30',
    'B30 ledger seeded with unchanged checksums',
  );
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const owner = await auth.bootstrap('owner@example.invalid', 'synthetic-password-12345678');
  const tenant = 'synthetic';
  const agent = randomUUID(),
    device = randomUUID(),
    link = randomUUID();
  await pool.query(
    'INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES($1,$2,$3)',
    [tenant, owner, randomUUID()],
  );
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','B30 historical device')",
    [device],
  );
  await pool.query(
    "INSERT INTO geops_device_tenant(device_id,tenant_id,established_by,source) VALUES($1,$2,$3,'GEOPS_ENROLLMENT')",
    [device, tenant, owner],
  );
  await pool.query(
    "INSERT INTO agent(id,tenant_id,code,name,created_by,updated_by) VALUES($1,$2,'LEGACY','Legacy agent',$3,$3)",
    [agent, tenant, owner],
  );
  await pool.query(
    "INSERT INTO agent_device_link(id,tenant_id,agent_id,device_id,valid_from,state,created_by,create_reason) VALUES($1,$2,$3,$4,now()-interval '1 day','ACTIVE',$5,'Synthetic B30 active link')",
    [link, tenant, agent, device, owner],
  );
  const applied = await applyMigrations(pool);
  check(
    applied.length === 1 && applied[0] === migrations[30].version,
    'only additive migration applied',
  );
  const identity = (
    await pool.query('SELECT agent_id,device_id,source FROM agent_operational_identity')
  ).rows;
  check(
    identity.length === 1 &&
      identity[0].agent_id === agent &&
      identity[0].device_id === device &&
      identity[0].source === 'B30_ACTIVE_LINK',
    'existing active link backfilled',
  );
  check(
    (await pool.query('SELECT id FROM agent_device_link WHERE id=$1', [link])).rowCount === 1,
    'historical B30 link preserved',
  );
  check((await applyMigrations(pool)).length === 0, 'upgrade retry is idempotent');
  const ledger = (
    await pool.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')
  ).rows;
  check(
    ledger.length === 31 &&
      ledger.every(
        (row, index) =>
          row.version === migrations[index].version && row.checksum === migrations[index].checksum,
      ),
    'all 31 checksums match source',
  );
  console.log(`post-B30 migration upgrade: ${checks} checks passed`);
} finally {
  await pool.end();
}
