// Run against a disposable database prepared with migration-0015-upgrade.integration.mjs prepare-N.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { beginMaintenance } from '../src/db/maintenance-gate.ts';
import { recoverMaintenance } from '../src/db/maintenance-recovery.ts';
import { checkReadiness } from '../src/db/migration-manager.ts';
import { gateAllowsTraffic, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
const initialVersion = Number(process.argv[2]);
if (
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  ![14, 15, 16, 17, 18].includes(initialVersion)
)
  throw new Error('Prepared disposable schema 14-18 and explicit synthetic mode required');

const target = new URL(url).pathname.slice(1);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const root = await mkdtemp(join(tmpdir(), 'geops-recovery-versions-'));
const path = join(root, 'security-gate.json');
try {
  let alertId;
  let mdmRunId;
  if (initialVersion >= 15) {
    const adminId = (
      await pool.query(
        "SELECT id FROM admin_user WHERE email_normalized='existing@example.invalid'",
      )
    ).rows[0].id;
    await pool.query(
      'INSERT INTO geops_operating_tenant(singleton,tenant_id,established_by,audit_ref) VALUES(true,$1,$2,$3)',
      ['synthetic', adminId, randomUUID()],
    );
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, 'gps.user.manage', 'Synthetic recovery preservation'],
    );
    if (initialVersion >= 16) {
      const binding = (await pool.query('SELECT id,geops_device_id FROM mdm_binding LIMIT 1'))
        .rows[0];
      const installationId = randomUUID();
      const policyId = randomUUID();
      const sessionId = randomUUID();
      alertId = randomUUID();
      const start = new Date('2026-10-20T12:00:00Z');
      const end = new Date('2026-10-20T13:00:00Z');
      await pool.query(
        'INSERT INTO gps_device_installation(installation_id,device_id,activated_at) VALUES($1,$2,$3)',
        [installationId, binding.geops_device_id, start],
      );
      await pool.query(
        "INSERT INTO gps_policy(id,name,state,draft_config,created_by,current_revision) VALUES($1,'Recovery fixture','ACTIVE','{}',$2,1)",
        [policyId, adminId],
      );
      await pool.query(
        `INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,
          capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,valid_from,
          valid_until,created_by,reason)
         VALUES($1,1,ARRAY[1,2,3,4,5,6,7]::smallint[],'12:00','13:00','Etc/UTC',
          60,300,900,300,$2,$3,$4,'Recovery fixture')`,
        [policyId, start, end, adminId],
      );
      await pool.query(
        'INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2)',
        [binding.geops_device_id, start],
      );
      await pool.query(
        `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,
          local_date,start_at,end_at,state)
         VALUES($1,$2,$3,1,1,'2026-10-20',$4,$5,'SCHEDULED')`,
        [sessionId, binding.geops_device_id, policyId, start, end],
      );
      await pool.query(
        `INSERT INTO gps_continuity_alert(id,tenant_id,device_id,mdm_binding_id,
          installation_id,scheduled_session_id,assignment_version,reason_code,severity,
          opened_at,updated_at,resolved_at,resolution_reason,age_s,threshold_s)
         VALUES($1,'synthetic',$2,$3,$4,$5,1,'CAPTURE_STALE','WARNING',$6,$7,$7,
          'WINDOW_ENDED',300,300)`,
        [alertId, binding.geops_device_id, binding.id, installationId, sessionId, start, end],
      );
    }
  }
  if (initialVersion >= 18) {
    const deviceId = (await pool.query('SELECT geops_device_id FROM mdm_binding LIMIT 1')).rows[0]
      .geops_device_id;
    await pool.query(
      `INSERT INTO mdm_inventory_device(provider,region,customer_id,mdm_device_id,platform,status,
        geops_device_id,last_seen_at) VALUES('manageengine','com','synthetic','mdm-fixture','android',
        'managed',$1,$2)`,
      [deviceId, new Date('2026-10-20T12:00:00Z')],
    );
    mdmRunId = randomUUID();
    await pool.query(
      `INSERT INTO mdm_sync_run(id,region,customer_id,outcome,device_count)
       VALUES($1,'com','synthetic','SUCCESS',1)`,
      [mdmRunId],
    );
  }
  const before = (
    await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`)
  ).rows[0];
  assert.equal(before.migrations, initialVersion, 'fixture is at requested schema');
  assert.ok(before.admins && before.sessions && before.device_sessions && before.permissions);
  const recovery = new SupervisedRecoveryService(pool, Buffer.alloc(32, 73));
  for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
    await recovery.registerSyntheticCustodian(email, 'synthetic-password-12345678');
  await writeGate(path, { version: 1, phase: 'open', epoch: before.epoch });
  await beginMaintenance(pool, path, target, before.epoch);
  assert.equal(await gateAllowsTraffic(pool, path), false);
  const request = () => ({
    target,
    epoch: before.epoch,
    requestId: randomUUID(),
    reason: 'Approved synthetic schema-version recovery',
    adminEmail: 'existing@example.invalid',
    adminPassword: 'synthetic-password-12345678',
    custodians: [
      { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
      { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
    ],
    compatibleReleaseConfirmed: true,
  });
  if (initialVersion === 18) {
    const version = '0018_mdm_inventory.sql';
    const checksum = (
      await pool.query('SELECT checksum FROM geops_schema_migrations WHERE version=$1', [version])
    ).rows[0].checksum;
    await pool.query('UPDATE geops_schema_migrations SET checksum=$2 WHERE version=$1', [
      version,
      'invalid',
    ]);
    await assert.rejects(
      recoverMaintenance(pool, path, request()),
      '0018 checksum mismatch denied',
    );
    assert.equal(await gateAllowsTraffic(pool, path), false);
    await pool.query('UPDATE geops_schema_migrations SET checksum=$2 WHERE version=$1', [
      version,
      checksum,
    ]);
  }
  if (initialVersion >= 15) {
    const indexName =
      initialVersion === 15
        ? 'admin_user_invitation_one_open'
        : initialVersion === 16
          ? 'gps_continuity_alert_one_open'
          : initialVersion === 17
            ? 'gps_continuity_alert_page'
            : 'mdm_inventory_one_geops_device';
    const definition = (
      await pool.query('SELECT pg_get_indexdef($1::regclass) AS definition', [indexName])
    ).rows[0].definition;
    await pool.query(`DROP INDEX ${indexName}`);
    await assert.rejects(
      recoverMaintenance(pool, path, request()),
      'incomplete schema stays closed',
    );
    assert.equal(await gateAllowsTraffic(pool, path), false);
    await pool.query(definition);
  }
  assert.equal(await recoverMaintenance(pool, path, request()), initialVersion);
  assert.equal(await gateAllowsTraffic(pool, path), true);
  assert.equal(await checkReadiness(pool), true);
  const after = (
    await pool.query(`SELECT
      (SELECT count(*)::int FROM geops_schema_migrations) AS migrations,
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`)
  ).rows[0];
  assert.deepEqual(after, { ...before, migrations: 21 }, 'identity, grants and epoch retained');
  if (initialVersion >= 15)
    assert.equal(
      (await pool.query('SELECT tenant_id FROM geops_operating_tenant')).rows[0].tenant_id,
      'synthetic',
    );
  if (alertId) {
    const alert = await pool.query(
      'SELECT resolved_at,updated_at,evaluated_at FROM gps_continuity_alert WHERE id=$1',
      [alertId],
    );
    assert.equal(alert.rowCount, 1);
    assert.equal(alert.rows[0].resolved_at.toISOString(), '2026-10-20T13:00:00.000Z');
    assert.equal(alert.rows[0].updated_at.toISOString(), '2026-10-20T13:00:00.000Z');
    assert.equal(alert.rows[0].evaluated_at, null);
  }
  if (mdmRunId) {
    const inventory = await pool.query(
      "SELECT geops_device_id,status FROM mdm_inventory_device WHERE mdm_device_id='mdm-fixture'",
    );
    assert.equal(inventory.rowCount, 1);
    assert.equal(inventory.rows[0].status, 'managed');
    assert.ok(inventory.rows[0].geops_device_id);
    assert.equal(
      (await pool.query('SELECT device_count FROM mdm_sync_run WHERE id=$1', [mdmRunId])).rows[0]
        .device_count,
      1,
    );
  }
  await assert.rejects(recoverMaintenance(pool, path, request()), 'open gate rejects replay');
  console.log(`Supervised schema ${initialVersion} -> 21 recovery: PASS`);
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
