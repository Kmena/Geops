// One-shot 0016 -> current-schema upgrade rehearsal in a new disposable PostGIS database only.
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
  throw new Error('Disposable DB required');
const pool = new pg.Pool({ connectionString: url });
try {
  const identity = await pool.query(`SELECT current_database() AS name,
    to_regclass('geops_schema_migrations') AS version_table`);
  assert.match(identity.rows[0].name, /^geops_verify_[0-9]+$/);
  assert.equal(identity.rows[0].version_table, null, 'test needs an empty disposable database');
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 30);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`CREATE TABLE geops_schema_migrations(version text PRIMARY KEY,
      checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of migrations.slice(0, 16)) {
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
    sessionKey: Buffer.alloc(32, 81),
    csrfKey: Buffer.alloc(32, 82),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const admin = await auth.bootstrap(
    'migration-r4a@example.invalid',
    'synthetic-password-12345678',
  );
  const device = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic migration continuity')",
    [device],
  );
  const binding = randomUUID(),
    installation = randomUUID(),
    policy = randomUUID();
  const scheduled = randomUUID(),
    alert = randomUUID();
  const start = new Date('2026-10-20T12:00:00Z');
  const end = new Date('2026-10-20T13:00:00Z');
  await pool.query(
    `INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state)
    VALUES($1,$2,'fake','synthetic',$3,'ACTIVE')`,
    [binding, device, `fake-${device}`],
  );
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at) VALUES($1,$2,$3)',
    [installation, device, start],
  );
  await pool.query(
    "INSERT INTO gps_policy(id,name,state,draft_config,created_by,current_revision) VALUES($1,'Migration fixture','ACTIVE','{}',$2,1)",
    [policy, admin],
  );
  await pool.query(
    `INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,
    capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,valid_from,
    valid_until,created_by,reason)
    VALUES($1,1,ARRAY[1,2,3,4,5,6,7]::smallint[],'12:00','13:00','Etc/UTC',60,300,900,300,$2,$3,$4,'Migration fixture')`,
    [policy, start, end, admin],
  );
  await pool.query(
    'INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2)',
    [device, start],
  );
  await pool.query(
    `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,
    local_date,start_at,end_at,state) VALUES($1,$2,$3,1,1,'2026-10-20',$4,$5,'SCHEDULED')`,
    [scheduled, device, policy, start, end],
  );
  await pool.query(
    `INSERT INTO gps_continuity_alert(id,tenant_id,device_id,mdm_binding_id,
    installation_id,scheduled_session_id,assignment_version,reason_code,severity,
    opened_at,updated_at,resolved_at,resolution_reason,age_s,threshold_s)
    VALUES($1,'synthetic',$2,$3,$4,$5,1,'CAPTURE_STALE','WARNING',$6,$7,$7,
      'WINDOW_ENDED',300,300)`,
    [alert, device, binding, installation, scheduled, start, end],
  );
  assert.deepEqual(await applyMigrations(pool), [
    '0017_gps_continuity_evaluated_at.sql',
    '0018_mdm_inventory.sql',
    '0019_mdm_security.sql',
    '0020_gps_mixed_batch_receipt.sql',
    '0021_gps_offline_policy_contract.sql',
    '0022_mdm_web_oauth.sql',
    '0023_mdm_oauth_client.sql',
    '0024_client_geofences.sql',
    '0025_route_catalog.sql',
    '0026_agents_assignments.sql',
    '0027_visit_dwell_engine.sql',
    '0028_agent_device_links.sql',
    '0029_geops_gps_identity.sql',
    '0030_gps_continuity_geops_owner.sql',
  ]);
  assert.equal(await checkReadiness(pool), true);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM admin_user WHERE id=$1', [admin])).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM geops_device WHERE id=$1', [device])).rows[0]
      .n,
    1,
  );
  const preserved = await pool.query(
    'SELECT resolved_at,updated_at,evaluated_at FROM gps_continuity_alert WHERE id=$1',
    [alert],
  );
  assert.equal(preserved.rowCount, 1);
  assert.equal(preserved.rows[0].resolved_at.toISOString(), end.toISOString());
  assert.equal(preserved.rows[0].updated_at.toISOString(), end.toISOString());
  assert.equal(
    preserved.rows[0].evaluated_at,
    null,
    'legacy inference time remains unknown rather than falsely using resolution time',
  );
  assert.deepEqual(await applyMigrations(pool), []);
  console.log(
    'gps-continuity migration PASS: 0016 -> 0030, alerts and resolution preserved, idempotent',
  );
} finally {
  await pool.end();
}
