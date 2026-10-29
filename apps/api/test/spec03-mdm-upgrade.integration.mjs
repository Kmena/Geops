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
  assert.equal(catalog.length, 33);
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
  const deviceId = randomUUID();
  const bindingId = randomUUID();
  const installationId = randomUUID();
  const policyId = randomUUID();
  const assignmentId = randomUUID();
  const scheduledId = randomUUID();
  const anchorId = randomUUID();
  const sessionId = randomUUID();
  const positionId = randomUUID();
  const bootId = randomUUID();
  const startAt = new Date('2026-10-20T12:00:00.000Z');
  const endAt = new Date('2026-10-20T13:00:00.000Z');
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic B23')",
    [deviceId],
  );
  await pool.query(
    "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic',$3,'ACTIVE')",
    [bindingId, deviceId, `fake-${deviceId}`],
  );
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,$5)',
    [installationId, deviceId, startAt, bindingId, 'synthetic'],
  );
  await pool.query(
    "INSERT INTO gps_policy(id,name,state,draft_config,created_by,current_revision) VALUES($1,'Synthetic B23','ACTIVE','{}',$2,1)",
    [policyId, adminId],
  );
  await pool.query(
    `INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,
      capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,
      valid_from,valid_until,created_by,reason)
     VALUES($1,1,ARRAY[1,2,3,4,5,6,7]::smallint[],'12:00','13:00','Etc/UTC',
      60,300,900,300,$2,$3,$4,'Synthetic B23 upgrade')`,
    [policyId, startAt, endAt, adminId],
  );
  await pool.query(
    "INSERT INTO gps_policy_assignment(id,policy_id,revision,scope_type,device_id,valid_from,valid_until) VALUES($1,$2,1,'DEVICE',$3,$4,$5)",
    [assignmentId, policyId, deviceId, startAt, endAt],
  );
  await pool.query(
    'INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2)',
    [deviceId, startAt],
  );
  await pool.query(
    "INSERT INTO gps_effective_assignment(id,device_id,policy_id,revision,source_assignment_id,effective_range,assignment_version) VALUES($1,$2,$3,1,$4,tstzrange($5,$6,'[)'),1)",
    [randomUUID(), deviceId, policyId, assignmentId, startAt, endAt],
  );
  await pool.query(
    "INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,local_date,start_at,end_at,state) VALUES($1,$2,$3,1,1,'2026-10-20',$4,$5,'SCHEDULED')",
    [scheduledId, deviceId, policyId, startAt, endAt],
  );
  await pool.query(
    `INSERT INTO gps_policy_delivery(capture_anchor_id,device_id,installation_id,
      assignment_version,server_time,fetched_at,offline_not_after,health_mdm_binding_id,health_tenant_id)
     VALUES($1,$2,$3,1,$4,$4,$5,$6,'synthetic')`,
    [anchorId, deviceId, installationId, startAt, endAt, bindingId],
  );
  await pool.query(
    `INSERT INTO gps_effective_session(id,device_id,installation_id,client_session_id,
      scheduled_session_id,assignment_version,started_at,start_event_id,state,evidence_state,
      tenant_id,mdm_binding_id,start_boot_id,start_anchor_id)
     VALUES($1,$2,$3,$4,$5,1,$6,$7,'OPEN','START_REPORTED','synthetic',$8,$9,$10)`,
    [
      sessionId,
      deviceId,
      installationId,
      randomUUID(),
      scheduledId,
      startAt,
      randomUUID(),
      bindingId,
      bootId,
      anchorId,
    ],
  );
  await pool.query(
    `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,captured_at,
      received_at,capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,
      geom,accuracy_m,payload_digest,quality_state,tenant_id,mdm_binding_id,installation_id)
     VALUES($1,$2,$3,1,$4,$4,$5,$6,0,100,
      ST_SetSRID(ST_MakePoint(-90.52,14.63),4326)::geography,5,$7,'ACCEPTED','synthetic',$8,$9)`,
    [
      deviceId,
      positionId,
      sessionId,
      startAt,
      anchorId,
      bootId,
      Buffer.alloc(32, 72),
      bindingId,
      installationId,
    ],
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
    (await pool.query('SELECT mdm_binding_id FROM gps_effective_session WHERE id=$1', [sessionId]))
      .rows[0].mdm_binding_id,
    bindingId,
  );
  assert.equal(
    (await pool.query('SELECT mdm_binding_id FROM position_event WHERE event_id=$1', [positionId]))
      .rows[0].mdm_binding_id,
    bindingId,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT activation_binding_id FROM gps_device_installation WHERE installation_id=$1',
        [installationId],
      )
    ).rows[0].activation_binding_id,
    bindingId,
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
  console.log('MDM 23 -> SPEC-03 33 upgrade, data, checksums and replay: PASS');
} finally {
  await pool.end();
}
