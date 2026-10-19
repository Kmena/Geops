// Scheduler scale only; destructive fixtures require a disposable geops_verify_* database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { GpsEventService } from '../src/gps-event-service.ts';
import { GpsHealthService } from '../src/gps-health-service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsScheduler } from '../src/gps-scheduler.ts';

const url = process.env.DATABASE_URL;
if (!url || !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic') throw new Error('Disposable DB required');
const pool = new pg.Pool({ connectionString: url, max: 12 });
assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /^geops_verify_[0-9]+(?:_restore)?$/);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  const auth = new AdminAuthService(pool, { sessionKey: Buffer.alloc(32, 51),
    csrfKey: Buffer.alloc(32, 52), allowedOrigins: ['https://geops.example.invalid'] });
  const adminId = await auth.bootstrap('load@example.invalid', 'synthetic-password-12345678');
  const policyId = randomUUID(), now = Date.now();
  await pool.query("INSERT INTO gps_policy(id,name,state,draft_config,created_by,current_revision) VALUES($1,'Synthetic 25-device load','ACTIVE','{}',$2,1)", [policyId,adminId]);
  await pool.query(`INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,
    capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,valid_from,valid_until,created_by,reason)
    VALUES($1,1,ARRAY[1,2,3,4,5,6,7]::smallint[],'08:00','17:00','America/Guatemala',60,300,900,300,$2,$3,$4,'Synthetic load approval')`,
  [policyId,new Date(now-86_400_000),new Date(now+20*86_400_000),adminId]);
  for (let index=0; index<25; index++) {
    const deviceId = randomUUID(), assignmentId=randomUUID();
    await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE',$2)", [deviceId,`Synthetic OEM ${index%4}`]);
    await pool.query(`INSERT INTO gps_policy_assignment(id,policy_id,revision,scope_type,device_id,valid_from,valid_until)
      VALUES($1,$2,1,'DEVICE',$3,$4,$5)`,
      [assignmentId,policyId,deviceId,new Date(now),new Date(now+20*86_400_000)]);
    await pool.query('INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2)',
      [deviceId,new Date(now)]);
    await pool.query(`INSERT INTO gps_effective_assignment(id,device_id,policy_id,revision,
      source_assignment_id,effective_range,assignment_version)
      VALUES($1,$2,$3,1,$4,tstzrange($5,$6,'[)'),1)`,
      [randomUUID(),deviceId,policyId,assignmentId,new Date(now),new Date(now+20*86_400_000)]);
  }
  const policies = new GpsPolicyService(pool);
  const scheduler = new GpsScheduler(pool, policies,
    new GpsEventService(pool, policies, Buffer.alloc(32, 53)),
    new GpsHealthService(pool, policies), () => new Date(now+86_400_000));
  const start = performance.now();
  const [first, second] = await Promise.all([scheduler.tick(),scheduler.tick()]);
  const elapsed = performance.now()-start;
  const coverage = await pool.query('SELECT count(DISTINCT device_id)::int AS n,count(*)::int AS windows FROM gps_scheduled_session');
  check(coverage.rows[0].n === 25 && coverage.rows[0].windows >= 125,
    'all 25 synthetic devices receive IANA UTC windows');
  check(first.windows_created + second.windows_created === coverage.rows[0].windows,
    'concurrent ticks materialize each window once');
  check(elapsed < 30_000, '25-device synthetic scheduler completes under 30 seconds locally');
  const repeat = await scheduler.tick();
  check(repeat.windows_created === 0 && repeat.versions_advanced === 0,
    'next tick is idempotent without transition');
  console.log(`gps-scheduler-load PASS: ${checks} assertions, 25 devices, ${coverage.rows[0].windows} windows, ${Math.round(elapsed)} ms`);
} finally { await pool.end(); }
