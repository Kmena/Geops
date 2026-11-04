import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { beginMaintenance } from '../src/db/maintenance-gate.ts';
import { RECOVERY_TARGET_SCHEMA, recoverMaintenance } from '../src/db/maintenance-recovery.ts';
import { checkReadiness, loadMigrations } from '../src/db/migration-manager.ts';
import { readGate, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
const initialVersion = process.argv[2] === undefined ? 35 : Number(process.argv[2]);
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  ![31, 35].includes(initialVersion)
)
  throw new Error('Disposable local synthetic database required');
const target = new URL(url).pathname.slice(1);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const root = await mkdtemp(join(tmpdir(), 'geops-spec03-recovery-'));
const gate = join(root, 'security-gate.json');
try {
  assert.equal(RECOVERY_TARGET_SCHEMA, 40);
  assert.equal(
    (await pool.query("SELECT to_regclass('geops_schema_migrations') AS name")).rows[0].name,
    null,
  );
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 40);
  await pool.query('BEGIN');
  await pool.query(
    'CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const migration of migrations.slice(0, initialVersion)) {
    await pool.query(migration.sql);
    await pool.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)', [
      migration.version,
      migration.checksum,
    ]);
  }
  await pool.query('COMMIT');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 81),
    csrfKey: Buffer.alloc(32, 82),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const actor = await auth.bootstrap(
    'recovery-spec03@example.invalid',
    'synthetic-password-12345678',
  );
  const epoch = randomUUID();
  await pool.query('INSERT INTO security_epoch(singleton,epoch) VALUES(true,$1)', [epoch]);
  await pool.query(
    'INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES($1,$2,$3)',
    ['synthetic', actor, randomUUID()],
  );
  const clientId = randomUUID();
  const siteId = randomUUID();
  await pool.query(
    "INSERT INTO client(id,tenant_id,code,name,address,created_by,updated_by) VALUES($1,'synthetic','RCLIENT','Recovery client','Recovery address',$2,$2)",
    [clientId, actor],
  );
  await pool.query(
    "INSERT INTO client_site(id,tenant_id,client_id,code,name,address,center,created_by,updated_by) VALUES($1,'synthetic',$2,'RSITE','Recovery site','Recovery address',ST_SetSRID(ST_MakePoint(-84.1,9.9),4326)::geography,$3,$3)",
    [siteId, clientId, actor],
  );
  const custody = new SupervisedRecoveryService(pool, Buffer.alloc(32, 97));
  for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
    await custody.registerSyntheticCustodian(email, 'synthetic-password-12345678');
  await writeGate(gate, { version: 1, phase: 'open', epoch });
  await beginMaintenance(pool, gate, target, epoch);
  const request = () => ({
    target,
    epoch,
    requestId: randomUUID(),
    reason: 'Approved synthetic SPEC-03 recovery rehearsal',
    adminEmail: 'recovery-spec03@example.invalid',
    adminPassword: 'synthetic-password-12345678',
    custodians: [
      { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
      { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
    ],
    compatibleReleaseConfirmed: true,
  });
  const latestVersion = migrations[initialVersion - 1].version;
  const oldChecksum = (
    await pool.query('SELECT checksum FROM geops_schema_migrations WHERE version=$1', [
      latestVersion,
    ])
  ).rows[0].checksum;
  await pool.query('UPDATE geops_schema_migrations SET checksum=$1 WHERE version=$2', [
    'invalid',
    latestVersion,
  ]);
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  assert.equal((await readGate(gate)).phase, 'maintenance');
  await pool.query('UPDATE geops_schema_migrations SET checksum=$1 WHERE version=$2', [
    oldChecksum,
    latestVersion,
  ]);
  await assert.rejects(
    recoverMaintenance(pool, gate, request(), async (stage, migration) => {
      if (stage === 'before_commit' && migration === '0036_kmz_staging.sql')
        throw new Error('induced failure before commit');
    }),
    /induced failure before commit/,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    35,
  );
  assert.equal((await readGate(gate)).phase, 'maintenance');
  await pool.query('CREATE TABLE catalog_revision (collision boolean)');
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  assert.equal((await readGate(gate)).phase, 'maintenance');
  await pool.query('DROP TABLE catalog_revision');
  const approved = request();
  assert.equal(await recoverMaintenance(pool, gate, approved), 35);
  assert.equal((await readGate(gate)).phase, 'open');
  assert.equal(await checkReadiness(pool), true);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    40,
  );
  assert.deepEqual(
    (await pool.query('SELECT id,name,code,address FROM client WHERE id=$1', [clientId])).rows,
    [{ id: clientId, name: 'Recovery client', code: 'RCLIENT', address: 'Recovery address' }],
  );
  assert.equal(
    (await pool.query('SELECT client_id FROM client_site WHERE id=$1', [siteId])).rows[0].client_id,
    clientId,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE correlation_id=$1 AND action='maintenance.recovery.validated' AND metadata_redacted->>'schema'='40'",
        [approved.requestId],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  await beginMaintenance(pool, gate, target, epoch);
  await pool.query(
    "INSERT INTO geops_schema_migrations(version,checksum) VALUES('0041_unexpected.sql','invalid')",
  );
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  assert.equal((await readGate(gate)).phase, 'maintenance');
  await pool.query("DELETE FROM geops_schema_migrations WHERE version='0041_unexpected.sql'");
  const sourceView = (
    await pool.query("SELECT pg_get_viewdef('catalog_source'::regclass,true) AS definition")
  ).rows[0].definition;
  await pool.query('DROP VIEW catalog_source');
  await assert.rejects(recoverMaintenance(pool, gate, request()));
  assert.equal((await readGate(gate)).phase, 'maintenance');
  await pool.query(`CREATE VIEW catalog_source AS ${sourceView}`);
  assert.equal(await recoverMaintenance(pool, gate, request()), 40);
  assert.equal((await readGate(gate)).phase, 'open');
  console.log(
    `SPEC-03 recovery ${String(initialVersion).padStart(4, '0')}→0040, checksum, rollback, unknown ledger, structural guard: PASS`,
  );
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
