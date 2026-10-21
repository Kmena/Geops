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
  assert.ok([14, 15, 16, 17, 18].includes(before.version), 'source must be schema 14-18');
  assert.equal(after.version, 18, 'copy must reach schema 18');
  assert.equal(after.epoch_digest, before.epoch_digest, 'epoch changed during migration');
  for (const [key, value] of Object.entries(before.identity))
    assert.equal(after.identity[key], value, `identity ${key} changed during migration`);
  for (const [key, value] of Object.entries(before.data))
    assert.equal(after.data[key], value, `data ${key} changed during migration`);
  return { result: 'PASS', transition: `${before.version}_to_18`, integrity: 'preserved' };
}

async function inventory(pool, expectedVersion) {
  const { loadMigrations } = await import('../../apps/api/dist/db/migration-manager.js');
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 18);
  const versions = await pool.query('SELECT version,checksum FROM geops_schema_migrations');
  const actual = new Map(versions.rows.map((row) => [row.version, row.checksum]));
  const version = expectedVersion ?? actual.size;
  assert.ok([14, 15, 16, 17, 18].includes(version), 'unsupported replica schema');
  assert.equal(actual.size, version);
  for (const item of migrations.slice(0, version))
    assert.equal(actual.get(item.version), item.checksum, `checksum ${item.version}`);
  assert.ok(
    [...actual.keys()].every((name) =>
      migrations.slice(0, version).some((item) => item.version === name),
    ),
  );
  const epoch = await pool.query(
    'SELECT epoch::text,quarantine_id::text FROM security_epoch WHERE singleton=true',
  );
  assert.equal(epoch.rowCount, 1);
  assert.equal(epoch.rows[0].quarantine_id, null, 'source must not already be quarantined');
  const objects = await pool.query(
    `SELECT to_regclass('geops_operating_tenant')::text AS tenant,
      to_regclass('admin_user_invitation')::text AS invitation,
      to_regclass('admin_access_change')::text AS change,
      to_regclass('gps_continuity_alert')::text AS alert,
      to_regclass('gps_continuity_read_quota')::text AS quota,
      to_regclass('mdm_inventory_device')::text AS mdm_inventory,
      to_regclass('mdm_sync_run')::text AS mdm_sync`,
  );
  assert.equal(Boolean(objects.rows[0].tenant), version >= 15);
  assert.equal(Boolean(objects.rows[0].invitation), version >= 15);
  assert.equal(Boolean(objects.rows[0].change), version >= 15);
  assert.equal(Boolean(objects.rows[0].alert), version >= 16);
  assert.equal(Boolean(objects.rows[0].quota), version >= 17);
  assert.equal(Boolean(objects.rows[0].mdm_inventory), version >= 18);
  assert.equal(Boolean(objects.rows[0].mdm_sync), version >= 18);
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
  if (version >= 15) {
    const extra = await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_operating_tenant) AS operating_tenants,
      (SELECT count(*)::int FROM admin_user_invitation) AS user_invitations,
      (SELECT count(*)::int FROM admin_access_change) AS access_changes`);
    Object.assign(identity, extra.rows[0]);
  }
  const data = { policies, gps_sessions, positions, health_events, audit_events };
  if (version >= 16) {
    const extra = await pool.query(`SELECT
      (SELECT count(*)::int FROM gps_continuity_threshold) AS continuity_thresholds,
      (SELECT count(*)::int FROM gps_continuity_alert) AS continuity_alerts`);
    Object.assign(data, extra.rows[0]);
  }
  if (version >= 18) {
    const extra = await pool.query(`SELECT
      (SELECT count(*)::int FROM mdm_inventory_device) AS mdm_inventory_devices,
      (SELECT count(*)::int FROM mdm_sync_run) AS mdm_sync_runs`);
    Object.assign(data, extra.rows[0]);
  }
  return {
    version,
    epoch_digest: digest(epoch.rows[0].epoch),
    identity,
    data,
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
        ? await inventory(pool)
        : stage === 'post'
          ? await inventory(pool, 18)
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
