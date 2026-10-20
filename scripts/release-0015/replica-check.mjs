import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const stage = process.argv[2];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const expectedName = /^geops_verify_[0-9]+_restore$/;

export function compareInventories(before, after) {
  assert.equal(before.version, 14, 'source must be 0014');
  assert.equal(after.version, 15, 'copy must reach 0015');
  assert.equal(after.epoch_digest, before.epoch_digest, 'epoch changed during migration');
  assert.deepEqual(after.identity, before.identity, 'identities changed during migration');
  assert.deepEqual(after.data, before.data, 'GPS or audit data changed during migration');
  return { result: 'PASS', transition: '0014_to_0015', integrity: 'preserved' };
}

async function inventory(pool, expectedVersion) {
  const { loadMigrations } = await import('../../apps/api/dist/db/migration-manager.js');
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 15);
  const versions = await pool.query('SELECT version,checksum FROM geops_schema_migrations');
  const actual = new Map(versions.rows.map((row) => [row.version, row.checksum]));
  assert.equal(actual.size, expectedVersion);
  for (const item of migrations.slice(0, expectedVersion))
    assert.equal(actual.get(item.version), item.checksum, `checksum ${item.version}`);
  const epoch = await pool.query(
    'SELECT epoch::text,quarantine_id::text FROM security_epoch WHERE singleton=true',
  );
  assert.equal(epoch.rowCount, 1);
  assert.equal(epoch.rows[0].quarantine_id, null, 'source must not already be quarantined');
  const objects = await pool.query(
    "SELECT to_regclass('geops_operating_tenant')::text AS tenant,to_regclass('admin_user_invitation')::text AS invitation,to_regclass('admin_access_change')::text AS change",
  );
  assert.equal(Boolean(objects.rows[0].tenant), expectedVersion === 15);
  assert.equal(Boolean(objects.rows[0].invitation), expectedVersion === 15);
  assert.equal(Boolean(objects.rows[0].change), expectedVersion === 15);
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM admin_user) AS admins_total,
    (SELECT count(*)::int FROM admin_user WHERE state='ACTIVE') AS active_admins,
    (SELECT count(*)::int FROM admin_user WHERE state='REVOKED') AS revoked_admins,
    (SELECT count(*)::int FROM admin_session) AS admin_sessions_total,
    (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS admin_sessions,
    (SELECT count(*)::int FROM device_session) AS device_sessions_total,
    (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
    (SELECT count(*)::int FROM device_key) AS device_keys_total,
    (SELECT count(*)::int FROM device_key WHERE status='ACTIVE') AS device_keys,
    (SELECT count(*)::int FROM recovery_custodian WHERE state='ACTIVE') AS custodians,
    (SELECT count(*)::int FROM admin_permission) AS permissions_total,
    (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
    (SELECT count(*)::int FROM gps_data_tenant_access) AS data_grants_total,
    (SELECT count(*)::int FROM gps_data_tenant_access WHERE revoked_at IS NULL) AS data_grants,
    (SELECT count(*)::int FROM gps_health_tenant_access) AS health_grants_total,
    (SELECT count(*)::int FROM gps_health_tenant_access WHERE revoked_at IS NULL) AS health_grants,
    (SELECT count(*)::int FROM gps_policy) AS policies,
    (SELECT count(*)::int FROM gps_effective_session) AS gps_sessions,
    (SELECT count(*)::int FROM position_event) AS positions,
    (SELECT count(*)::int FROM gps_device_health_event) AS health_events,
    (SELECT count(*)::int FROM audit_event) AS audit_events`);
  const { policies, gps_sessions, positions, health_events, audit_events, ...identity } =
    counts.rows[0];
  return {
    version: expectedVersion,
    epoch_digest: digest(epoch.rows[0].epoch),
    identity,
    data: { policies, gps_sessions, positions, health_events, audit_events },
  };
}

async function gateStatus(pool, path, quarantined) {
  const { gateAllowsTraffic, openGateAfterQuarantine, readGate, verifyForReopen } = await import(
    '../../apps/api/dist/db/restore-gate.js'
  );
  const gate = await readGate(path);
  const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
  assert.equal(gate.phase, 'closed', 'replica gate must remain closed');
  assert.equal(await gateAllowsTraffic(pool, path), false, 'replica cannot serve traffic');
  assert.equal(await verifyForReopen(pool, path), quarantined);
  if (quarantined)
    await assert.rejects(
      openGateAfterQuarantine(pool, path),
      'reopen requires explicit authorization',
    );
  else
    await assert.rejects(
      openGateAfterQuarantine(pool, path, { databaseName: name, epoch: gate.epoch }),
      'unquarantined restore must refuse even an exact authorization',
    );
  const row = await pool.query(
    'SELECT epoch::text,quarantine_id::text FROM security_epoch WHERE singleton=true',
  );
  if (quarantined) {
    assert.equal(row.rows[0].epoch, gate.epoch);
    assert.ok(row.rows[0].quarantine_id);
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM admin_user WHERE state='ACTIVE') AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS admin_sessions,
      (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
      (SELECT count(*)::int FROM device_key WHERE status='ACTIVE') AS device_keys,
      (SELECT count(*)::int FROM recovery_custodian WHERE state='ACTIVE') AS custodians,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT count(*)::int FROM gps_data_tenant_access WHERE revoked_at IS NULL) AS data_grants,
      (SELECT count(*)::int FROM gps_health_tenant_access WHERE revoked_at IS NULL) AS health_grants,
      (SELECT count(*)::int FROM admin_user_invitation WHERE consumed_at IS NULL) AS invitations`);
    assert.ok(Object.values(counts.rows[0]).every((value) => value === 0));
  } else assert.notEqual(row.rows[0].epoch, gate.epoch);
  return { result: 'PASS', gate: 'closed', quarantine: quarantined ? 'verified' : 'required' };
}

async function main() {
  if (stage === 'compare') {
    const before = JSON.parse(await readFile(process.argv[3], 'utf8'));
    const after = JSON.parse(await readFile(process.argv[4], 'utf8'));
    process.stdout.write(`${JSON.stringify(compareInventories(before, after))}\n`);
    return;
  }
  const url = process.env.DATABASE_URL;
  const name = url ? new URL(url).pathname.slice(1) : '';
  if (process.env.GEOPS_DATA_MODE !== 'synthetic' || !expectedName.test(name))
    throw new Error('Isolated synthetic restore URL required');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const observed = await pool.query(
      'SELECT current_database() AS name,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS others',
    );
    assert.equal(observed.rows[0].name, name);
    assert.equal(observed.rows[0].others, 0, 'replica must have no other connections');
    const result =
      stage === 'pre'
        ? await inventory(pool, 14)
        : stage === 'post'
          ? await inventory(pool, 15)
          : stage === 'gate-before-quarantine'
            ? await gateStatus(pool, process.env.GEOPS_SECURITY_GATE_PATH, false)
            : stage === 'gate-after-quarantine'
              ? await gateStatus(pool, process.env.GEOPS_SECURITY_GATE_PATH, true)
              : null;
    if (!result) throw new Error('Unknown replica check stage');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write('GEOPS isolated replica check failed; details withheld\n');
    process.exitCode = 1;
  });
