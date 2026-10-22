// Run only against a prepared 0014 database in a disposable local PostGIS instance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { beginMaintenance } from '../src/db/maintenance-gate.ts';
import { recoverMaintenance } from '../src/db/maintenance-recovery.ts';
import { gateAllowsTraffic, readGate, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
if (
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1))
)
  throw new Error('Local disposable synthetic 0014 database required');
const target = new URL(url).pathname.slice(1);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const root = await mkdtemp(join(tmpdir(), 'geops-recovery-'));
const path = join(root, 'security-gate.json');
let checks = 0;
const same = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label);
  checks++;
};
const denied = async (promise, label, expectedMessage) => {
  await assert.rejects(promise, expectedMessage ? { message: expectedMessage } : undefined, label);
  checks++;
};
try {
  const initial = (
    await pool.query(`SELECT
    (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
    (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS admin_sessions,
    (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
    (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
    (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`)
  ).rows[0];
  same(initial.migrations, 14, 'prepared at 0014');
  const recovery = new SupervisedRecoveryService(pool, Buffer.alloc(32, 42));
  for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
    await recovery.registerSyntheticCustodian(email, 'synthetic-password-12345678');
  await writeGate(path, { version: 1, phase: 'open', epoch: initial.epoch });
  await beginMaintenance(pool, path, target, initial.epoch);
  same(await gateAllowsTraffic(pool, path), false, 'closed during maintenance');
  const maintenanceGate = await readGate(path);
  const input = () => ({
    target,
    epoch: initial.epoch,
    requestId: randomUUID(),
    reason: 'Approved synthetic recovery exercise',
    adminEmail: 'existing@example.invalid',
    adminPassword: 'synthetic-password-12345678',
    custodians: [
      { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
      { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
    ],
    compatibleReleaseConfirmed: true,
  });
  const badEpoch = { ...input(), epoch: randomUUID() };
  await denied(recoverMaintenance(pool, path, badEpoch), 'wrong epoch');
  await denied(
    recoverMaintenance(pool, path, { ...input(), target: 'geops_verify_99999999' }),
    'wrong database target',
  );
  const badCustody = { ...input(), custodians: [input().custodians[0], input().custodians[0]] };
  await denied(recoverMaintenance(pool, path, badCustody), 'same custodian twice');
  const badPassword = { ...input(), adminPassword: 'wrong password' };
  await denied(recoverMaintenance(pool, path, badPassword), 'invalid admin password');
  await rm(path);
  await denied(recoverMaintenance(pool, path, input()), 'lost security volume fails closed');
  await writeGate(path, maintenanceGate);
  await writeGate(path, { ...maintenanceGate, nonce: randomUUID() });
  await denied(recoverMaintenance(pool, path, input()), 'wrong nonce');
  await writeGate(path, maintenanceGate);
  await pool.query('UPDATE security_epoch SET quarantine_id=$1 WHERE singleton=true', [
    randomUUID(),
  ]);
  await denied(recoverMaintenance(pool, path, input()), 'quarantined database');
  await pool.query('UPDATE security_epoch SET quarantine_id=NULL WHERE singleton=true');
  const checksum = (
    await pool.query(
      "SELECT checksum FROM geops_schema_migrations WHERE version='0014_gps_installation_binding.sql'",
    )
  ).rows[0].checksum;
  await pool.query(
    "UPDATE geops_schema_migrations SET checksum='invalid' WHERE version='0014_gps_installation_binding.sql'",
  );
  await denied(recoverMaintenance(pool, path, input()), 'checksum mismatch');
  await pool.query(
    "UPDATE geops_schema_migrations SET checksum=$1 WHERE version='0014_gps_installation_binding.sql'",
    [checksum],
  );
  await pool.query(
    "INSERT INTO geops_schema_migrations(version,checksum) VALUES('9999_unknown.sql','invalid')",
  );
  await denied(recoverMaintenance(pool, path, input()), 'unknown migration');
  await pool.query("DELETE FROM geops_schema_migrations WHERE version='9999_unknown.sql'");
  await pool.query('CREATE TABLE gps_continuity_alert (collision boolean)');
  await denied(recoverMaintenance(pool, path, input()), 'future 0016 object without ledger');
  await pool.query('DROP TABLE gps_continuity_alert');
  const other = new pg.Pool({ connectionString: url, max: 1 });
  const incompatibleSession = await other.connect();
  try {
    await denied(
      recoverMaintenance(pool, path, input()),
      'other database session blocks maintenance',
    );
  } finally {
    incompatibleSession.release();
    await other.end();
  }
  const failBefore = input();
  await denied(
    recoverMaintenance(pool, path, failBefore, async (stage) => {
      if (stage === 'authorized') throw new Error('Injected interruption before 0015');
    }),
    'interruption before migration',
    'Injected interruption before 0015',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    14,
    'still 0014',
  );
  await denied(recoverMaintenance(pool, path, failBefore), 'request replay rejected');
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'before_commit' && migration?.startsWith('0015_'))
        throw new Error('Injected failure during 0015');
    }),
    '0015 rollback before commit',
    'Injected failure during 0015',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    14,
    '0015 rollback leaves 14 complete migrations',
  );
  same(await gateAllowsTraffic(pool, path), false, '0015 failure leaves gate closed');
  const originalOid = (await pool.query('SELECT database_oid FROM geops_maintenance_marker'))
    .rows[0].database_oid;
  await pool.query('UPDATE geops_maintenance_marker SET database_oid=0 WHERE singleton=true');
  await denied(recoverMaintenance(pool, path, input()), 'restored database identity mismatch');
  await pool.query('UPDATE geops_maintenance_marker SET database_oid=$1 WHERE singleton=true', [
    originalOid,
  ]);
  await pool.query('CREATE TABLE geops_operating_tenant (collision boolean)');
  await denied(recoverMaintenance(pool, path, input()), 'partial or untracked 0015 objects denied');
  await pool.query('DROP TABLE geops_operating_tenant');
  const failAfterCommit = input();
  await denied(
    recoverMaintenance(pool, path, failAfterCommit, async (stage, migration) => {
      if (stage === 'migrated' && migration?.startsWith('0015_'))
        throw new Error('Injected interruption after 0015 COMMIT');
    }),
    'interruption after migration commit',
    'Injected interruption after 0015 COMMIT',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    15,
    '0015 committed once',
  );
  same(await gateAllowsTraffic(pool, path), false, 'gate remains closed after commit');
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'before_commit' && migration?.startsWith('0016_'))
        throw new Error('Injected failure during 0016');
    }),
    '0016 rollback before commit',
    'Injected failure during 0016',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    15,
    '0016 rollback leaves 15 complete migrations',
  );
  same(
    (await pool.query("SELECT to_regclass('gps_continuity_alert') AS relation")).rows[0].relation,
    null,
    '0016 rollback removes uncommitted alert table',
  );
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'migrated' && migration?.startsWith('0016_'))
        throw new Error('Injected interruption after 0016 COMMIT');
    }),
    'interruption after 0016 commit',
    'Injected interruption after 0016 COMMIT',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    16,
    '0016 committed once',
  );
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'before_commit' && migration?.startsWith('0017_'))
        throw new Error('Injected failure during 0017');
    }),
    '0017 rollback before commit',
    'Injected failure during 0017',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    16,
    '0017 rollback leaves 16 complete migrations',
  );
  same(
    (await pool.query("SELECT to_regclass('gps_continuity_read_quota') AS relation")).rows[0]
      .relation,
    null,
    '0017 rollback removes uncommitted quota table',
  );
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'migrated' && migration?.startsWith('0017_'))
        throw new Error('Injected interruption after 0017 COMMIT');
    }),
    'interruption after 0017 commit',
    'Injected interruption after 0017 COMMIT',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    17,
    '0017 committed once',
  );
  const pageDefinition = (
    await pool.query("SELECT pg_get_indexdef('gps_continuity_alert_page'::regclass) AS definition")
  ).rows[0].definition;
  await pool.query('DROP INDEX gps_continuity_alert_page');
  await denied(recoverMaintenance(pool, path, input()), '0017 ledger with missing index rejected');
  await pool.query(pageDefinition);
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'before_commit' && migration?.startsWith('0018_'))
        throw new Error('Injected failure during 0018');
    }),
    '0018 rollback before commit',
    'Injected failure during 0018',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    17,
    '0018 rollback leaves 17 complete migrations',
  );
  same(
    (await pool.query("SELECT to_regclass('mdm_inventory_device') AS relation")).rows[0].relation,
    null,
    '0018 rollback removes uncommitted inventory table',
  );
  await denied(
    recoverMaintenance(pool, path, input(), async (stage, migration) => {
      if (stage === 'migrated' && migration?.startsWith('0018_'))
        throw new Error('Injected interruption after 0018 COMMIT');
    }),
    'interruption after 0018 commit',
    'Injected interruption after 0018 COMMIT',
  );
  same(
    (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
    18,
    '0018 committed once',
  );
  const inventoryIndex = (
    await pool.query(
      "SELECT pg_get_indexdef('mdm_inventory_one_geops_device'::regclass) AS definition",
    )
  ).rows[0].definition;
  await pool.query('DROP INDEX mdm_inventory_one_geops_device');
  await denied(recoverMaintenance(pool, path, input()), '0018 ledger with missing index rejected');
  await pool.query(inventoryIndex);
  const failBeforeGate = input();
  await denied(
    recoverMaintenance(pool, path, failBeforeGate, async (stage) => {
      if (stage === 'audited') throw new Error('Injected interruption before gate reopen');
    }),
    'interruption before gate write',
    'Injected interruption before gate reopen',
  );
  same((await readGate(path)).phase, 'maintenance', 'still in maintenance');
  const concurrent = await Promise.allSettled([
    recoverMaintenance(pool, path, input()),
    recoverMaintenance(pool, path, input()),
  ]);
  same(
    concurrent.filter((result) => result.status === 'fulfilled').length,
    1,
    'concurrent recovery opens only once',
  );
  same(
    concurrent.filter((result) => result.status === 'rejected').length,
    1,
    'second recovery refused',
  );
  same(await gateAllowsTraffic(pool, path), true, 'reopened after validation');
  const after = (
    await pool.query(`SELECT
    (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS admin_sessions,
    (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
    (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
    (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`)
  ).rows[0];
  same(
    after,
    {
      admin_sessions: initial.admin_sessions,
      device_sessions: initial.device_sessions,
      permissions: initial.permissions,
      epoch: initial.epoch,
    },
    'identities and permissions preserved',
  );
  same(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'maintenance.recovery.%'",
      )
    ).rows[0].n,
    17,
    'authorization and validation audits persist',
  );
  await denied(recoverMaintenance(pool, path, input()), 'open gate cannot be replayed');
  await pool.query('UPDATE geops_maintenance_marker SET database_oid=0 WHERE singleton=true');
  await denied(
    beginMaintenance(pool, path, target, initial.epoch),
    'restored open database cannot rebind itself',
  );
  same(await gateAllowsTraffic(pool, path), false, 'altered open marker blocks traffic');
  await pool.query('UPDATE geops_maintenance_marker SET database_oid=$1 WHERE singleton=true', [
    originalOid,
  ]);
  await beginMaintenance(pool, path, target, initial.epoch);
  same(await gateAllowsTraffic(pool, path), false, 'incident starts new closed maintenance');
  same(
    await recoverMaintenance(pool, path, input()),
    21,
    'compatible image recovers without repeating committed migrations',
  );
  same(await gateAllowsTraffic(pool, path), true, 'service can reopen after incident recovery');
  console.log(`Supervised forward recovery: ${checks} checks PASS`);
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
