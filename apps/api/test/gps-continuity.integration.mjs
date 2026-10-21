// Destructive fixtures only in a disposable, explicitly named PostGIS database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { createApp } from '../src/app.ts';
import { GpsContinuityMonitor } from '../src/gps-continuity-monitor.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsHealthService } from '../src/gps-health-service.ts';
import { GpsEventService } from '../src/gps-event-service.ts';
import { GpsScheduler } from '../src/gps-scheduler.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable DB required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
assert.match(
  (await pool.query('SELECT current_database() AS name')).rows[0].name,
  /^geops_verify_[0-9]+$/,
);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
await pool.query('TRUNCATE gps_continuity_threshold');
const auth = new AdminAuthService(pool, {
  sessionKey: Buffer.alloc(32, 61),
  csrfKey: Buffer.alloc(32, 62),
  allowedOrigins: ['https://geops.example.invalid'],
});
const admin = await auth.bootstrap('r4a@example.invalid', 'synthetic-password-12345678');
const start = Date.UTC(2026, 9, 20, 12, 0);
const at = (minutes) => new Date(start + minutes * 60_000);
let now = at(4);
const monitor = new GpsContinuityMonitor(pool, () => now);
const app = createApp({
  readinessProbe: async () => true,
  logLevel: 'silent',
  adminAuth: auth,
  gpsContinuity: monitor,
  secureCookie: false,
});
const login = await app.inject({
  method: 'POST',
  url: '/v1/admin/auth/sessions',
  headers: { origin: 'https://geops.example.invalid' },
  payload: { email: 'r4a@example.invalid', password: 'synthetic-password-12345678' },
});
assert.equal(login.statusCode, 200);
const cookie = login.headers['set-cookie'].split(';')[0];
const read = (query = '', headers = {}) =>
  app.inject({
    method: 'GET',
    url: `/v1/admin/gps-continuity/alerts${query}`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic continuity audit', ...headers },
  });
const records = [];
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};

async function fixture(tenant, includeScheduled = true) {
  const device = randomUUID(),
    binding = randomUUID(),
    installation = randomUUID();
  const policy = randomUUID(),
    assignment = randomUUID(),
    scheduled = randomUUID();
  const anchor = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic R4-A')",
    [device],
  );
  await pool.query(
    `INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state)
    VALUES($1,$2,'fake',$3,$4,'ACTIVE')`,
    [binding, device, tenant, `fake-${device}`],
  );
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at) VALUES($1,$2,$3)',
    [installation, device, at(-10)],
  );
  await pool.query(
    "INSERT INTO gps_policy(id,name,state,draft_config,created_by,current_revision) VALUES($1,'Synthetic R4-A','ACTIVE','{}',$2,1)",
    [policy, admin],
  );
  await pool.query(
    `INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,
    capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,valid_from,valid_until,created_by,reason)
    VALUES($1,1,ARRAY[1,2,3,4,5,6,7]::smallint[],'12:00','13:00','Etc/UTC',60,300,900,300,$2,$3,$4,'Synthetic continuity policy')`,
    [policy, at(-60), at(120), admin],
  );
  await pool.query(
    `INSERT INTO gps_policy_assignment(id,policy_id,revision,scope_type,device_id,valid_from,valid_until)
    VALUES($1,$2,1,'DEVICE',$3,$4,$5)`,
    [assignment, policy, device, at(-60), at(120)],
  );
  await pool.query(
    'INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2)',
    [device, at(0)],
  );
  await pool.query(
    `INSERT INTO gps_effective_assignment(id,device_id,policy_id,revision,source_assignment_id,
    effective_range,assignment_version) VALUES($1,$2,$3,1,$4,tstzrange($5,$6,'[)'),1)`,
    [randomUUID(), device, policy, assignment, at(-60), at(120)],
  );
  if (includeScheduled)
    await pool.query(
      `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,
      local_date,start_at,end_at,state) VALUES($1,$2,$3,1,1,'2026-10-20',$4,$5,'SCHEDULED')`,
      [scheduled, device, policy, at(0), at(60)],
    );
  await pool.query(
    `INSERT INTO gps_policy_delivery(capture_anchor_id,device_id,installation_id,
    assignment_version,server_time,fetched_at,offline_not_after)
    VALUES($1,$2,$3,1,$4,$4,$5)`,
    [anchor, device, installation, at(0), at(60)],
  );
  return { device, binding, installation, scheduled, anchor, tenant };
}

async function health(fixture, minute, receivedMinute = minute) {
  const boot = randomUUID();
  await pool.query(
    `INSERT INTO gps_device_health_event(device_id,event_id,tenant_id,mdm_binding_id,
    installation_id,batch_id,assignment_version,policy_revision,scheduled_session_id,
    capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,due_at,
    observed_at,received_at,tracking_state,observed_states,payload_digest)
    VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,0,100,$10,$10,$11,'RUNNING',ARRAY['ONLINE']::text[],$12)`,
    [
      fixture.device,
      randomUUID(),
      fixture.tenant,
      fixture.binding,
      fixture.installation,
      randomUUID(),
      fixture.scheduled,
      fixture.anchor,
      boot,
      at(minute),
      at(receivedMinute),
      Buffer.alloc(32, 71),
    ],
  );
}

async function position(fixture, minute, receivedMinute = minute) {
  const session = randomUUID(),
    boot = randomUUID();
  await pool.query(
    `INSERT INTO gps_effective_session(id,device_id,installation_id,client_session_id,
    scheduled_session_id,assignment_version,started_at,start_event_id,state,evidence_state,
    tenant_id,mdm_binding_id,start_boot_id,start_anchor_id)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,'OPEN','START_REPORTED',$8,$9,$10,$11)`,
    [
      session,
      fixture.device,
      fixture.installation,
      randomUUID(),
      fixture.scheduled,
      at(0),
      randomUUID(),
      fixture.tenant,
      fixture.binding,
      boot,
      fixture.anchor,
    ],
  );
  await pool.query(
    `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,
    captured_at,received_at,capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,
    elapsed_realtime_ms,geom,accuracy_m,payload_digest,quality_state,tenant_id,
    mdm_binding_id,installation_id)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,0,100,ST_SetSRID(ST_MakePoint(0,0),4326)::geography,
      5,$8,'ACCEPTED',$9,$10,$11)`,
    [
      fixture.device,
      randomUUID(),
      session,
      at(minute),
      at(receivedMinute),
      fixture.anchor,
      boot,
      Buffer.alloc(32, 72),
      fixture.tenant,
      fixture.binding,
      fixture.installation,
    ],
  );
}

try {
  const a = await fixture('tenant-a');
  const b = await fixture('tenant-b');
  records.push(a, b);
  check((await monitor.tick()).opened === 0, 'start grace suppresses alerts');
  now = at(5);
  const concurrent = await Promise.all([monitor.tick(), monitor.tick()]);
  check(
    concurrent.reduce((sum, result) => sum + result.opened, 0) === 2,
    'concurrent ticks open one alert per device',
  );
  const initial = await pool.query(
    'SELECT reason_code,severity FROM gps_continuity_alert WHERE resolved_at IS NULL',
  );
  check(
    initial.rowCount === 2 &&
      initial.rows.every(
        (row) => row.reason_code === 'COMMUNICATION_MISSING' && row.severity === 'WARNING',
      ),
    'no communication detected at warning threshold',
  );
  check((await monitor.tick()).opened === 0, 'repeat evaluation is idempotent');
  now = at(10);
  check((await monitor.tick()).changed === 2, 'critical escalation recorded once');
  check((await monitor.tick()).changed === 0, 'critical escalation not duplicated');

  await health(a, 9);
  now = at(11);
  const withTelemetry = await monitor.tick();
  check(
    withTelemetry.opened === 1 && withTelemetry.resolved === 1,
    'live telemetry without positions changes reason to capture stale',
  );
  const capture = await pool.query(
    'SELECT reason_code,last_health_observed_at,last_health_received_at,last_position_captured_at FROM gps_continuity_alert WHERE device_id=$1 AND resolved_at IS NULL',
    [a.device],
  );
  check(
    capture.rows[0].reason_code === 'CAPTURE_STALE' &&
      capture.rows[0].last_position_captured_at === null,
    'observed and inferred evidence are separate',
  );

  await position(a, 11);
  now = at(12);
  check((await monitor.tick()).resolved === 1, 'fresh captured position resolves capture stale');
  await position(b, 1, 12);
  now = at(13);
  await monitor.tick();
  const late = await pool.query(
    'SELECT reason_code,last_position_captured_at,last_position_received_at FROM gps_continuity_alert WHERE device_id=$1 AND resolved_at IS NULL',
    [b.device],
  );
  check(
    late.rows[0].reason_code === 'CAPTURE_STALE' &&
      late.rows[0].last_position_captured_at.getTime() === at(1).getTime() &&
      late.rows[0].last_position_received_at.getTime() === at(12).getTime(),
    'late upload is communication but not recent capture',
  );

  now = at(17);
  check(
    (await monitor.tick()).opened === 2,
    'capture and communication can stall again after recovery in the same window',
  );

  await pool.query(
    `INSERT INTO admin_permission(admin_id,permission,granted_by,reason)
    VALUES($1,'gps.session.read',$1,'Synthetic R4-A read')`,
    [admin],
  );
  check((await read()).statusCode === 403, 'HTTP denies missing location capability');
  await assert.rejects(
    monitor.listForAdmin(admin, randomUUID(), 'Synthetic R4-A audit'),
    (error) => error.statusCode === 403 || error.status === 403,
  );
  checks++;
  await pool.query(
    `INSERT INTO admin_permission(admin_id,permission,granted_by,reason)
    VALUES($1,'gps.location.read',$1,'Synthetic R4-A read')`,
    [admin],
  );
  check(
    (await monitor.listForAdmin(admin, randomUUID(), 'Synthetic R4-A audit')).length === 0,
    'capabilities without tenant grants reveal nothing',
  );
  check((await read()).statusCode === 403, 'HTTP denies missing tenant grants');
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason)
      VALUES($1,'tenant-a',$1,'Synthetic R4-A tenant grant')`,
      [admin],
    );
  const scoped = await monitor.listForAdmin(admin, randomUUID(), 'Synthetic R4-A audit');
  check(scoped.length === 1 && scoped[0].tenant_id === 'tenant-a', 'tenant isolation holds');
  check(
    (await app.inject({ method: 'GET', url: '/v1/admin/gps-continuity/alerts' })).statusCode ===
      401,
    'anonymous continuity read rejected',
  );
  check(
    (await read('', { 'x-geops-access-reason': '' })).statusCode === 422,
    'access reason is required',
  );
  const openHttp = await read('?status=OPEN');
  const openBody = openHttp.json();
  check(
    openHttp.statusCode === 200 &&
      openBody.schema_version === 1 &&
      openBody.items.length === 1 &&
      openBody.items[0].device_id === a.device &&
      openBody.items[0].inference.evaluated_at === now.toISOString() &&
      openHttp.headers['cache-control'] === 'no-store' &&
      !JSON.stringify(openBody).includes('tenant-a') &&
      !JSON.stringify(openBody).includes('latitude'),
    'versioned authorized HTTP returns scoped inference without coordinates',
  );
  check(
    (await read(`?device_id=${b.device}`)).statusCode === 404,
    'other tenant device is not visible',
  );
  const historyQuery =
    `?status=ALL&opened_from=${encodeURIComponent(at(0).toISOString())}` +
    `&opened_before=${encodeURIComponent(at(60).toISOString())}&limit=1`;
  const first = (await read(historyQuery)).json();
  const second = (
    await read(`${historyQuery}&cursor=${encodeURIComponent(first.next_cursor)}`)
  ).json();
  check(
    first.items.length === 1 &&
      second.items.length === 1 &&
      first.items[0].alert_id !== second.items[0].alert_id,
    'keyset pagination yields unique episodes',
  );
  check((await read(`${historyQuery}&cursor=bad`)).statusCode === 422, 'tampered cursor rejected');
  const resolvedHttp = await read(
    `?status=RESOLVED&opened_from=${encodeURIComponent(at(0).toISOString())}` +
      `&opened_before=${encodeURIComponent(at(60).toISOString())}`,
  );
  check(
    resolvedHttp.statusCode === 200 &&
      resolvedHttp
        .json()
        .items.every(
          (item) => item.status === 'RESOLVED' && item.resolved_at && item.resolution_reason,
        ),
    'resolved episodes retain resolution time and reason',
  );
  check((await read('?status=RESOLVED')).statusCode === 422, 'unbounded history rejected');
  await pool.query(
    `INSERT INTO gps_continuity_read_quota(admin_id,minute_bucket,request_count)
    VALUES($1,date_trunc('minute',now()),60)
    ON CONFLICT (admin_id,minute_bucket) DO UPDATE SET request_count=60`,
    [admin],
  );
  const limited = await read();
  check(
    limited.statusCode === 429 && limited.headers['retry-after'] === '60',
    'read quota rejects excess requests with Retry-After',
  );
  await pool.query('DELETE FROM gps_continuity_read_quota WHERE admin_id=$1', [admin]);
  await pool.query(
    "UPDATE gps_health_tenant_access SET revoked_at=now() WHERE admin_id=$1 AND tenant_id='tenant-a' AND revoked_at IS NULL",
    [admin],
  );
  check(
    (await monitor.listForAdmin(admin, randomUUID(), 'Synthetic R4-A audit')).length === 0,
    'revoked tenant grant removes visibility',
  );
  check((await read()).statusCode === 403, 'revoked tenant grant blocks HTTP read');
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'gps.continuity.alert.%' ",
      )
    ).rows[0].n >= 8,
    'transitions and sensitive reads are audited',
  );

  await pool.query('UPDATE gps_device_assignment_state SET changed_at=$2 WHERE device_id=$1', [
    a.device,
    at(17),
  ]);
  now = at(18);
  check(
    (await monitor.tick()).resolved === 1,
    'policy change grace resolves old alarm without asserting capture',
  );
  await pool.query(`INSERT INTO gps_continuity_threshold(tenant_id,warning_after_s,
    critical_after_s,start_grace_s,policy_grace_s)
    VALUES('tenant-a',60,120,0,0)`);
  check(
    (await monitor.tick()).opened === 1,
    'tenant-specific threshold configuration applies without changing GPS policy',
  );

  const configured = {
    warning_after_s: 300,
    critical_after_s: 600,
    start_grace_s: 300,
    policy_grace_s: 300,
  };
  await assert.rejects(
    monitor.configureForAdmin(
      admin,
      randomUUID(),
      'tenant-a',
      'Synthetic R4-A change',
      1,
      configured,
    ),
    (error) => error.statusCode === 403 || error.status === 403,
  );
  checks++;
  await pool.query(
    `INSERT INTO admin_permission(admin_id,permission,granted_by,reason)
    VALUES($1,'gps.policy.write',$1,'Synthetic R4-A settings')`,
    [admin],
  );
  await pool.query(
    `INSERT INTO gps_health_tenant_access(admin_id,tenant_id,granted_by,reason)
    VALUES($1,'tenant-a',$1,'Synthetic R4-A regrant')`,
    [admin],
  );
  check(
    (await monitor.configureForAdmin(
      admin,
      randomUUID(),
      'tenant-a',
      'Synthetic R4-A change',
      1,
      configured,
    )) === 2,
    'authorized threshold update increments version',
  );
  await assert.rejects(
    monitor.configureForAdmin(
      admin,
      randomUUID(),
      'tenant-a',
      'Synthetic R4-A replay',
      1,
      configured,
    ),
    (error) => error.statusCode === 409 || error.status === 409,
  );
  checks++;

  const replacementBinding = randomUUID();
  await pool.query("UPDATE mdm_binding SET state='REVOKED' WHERE id=$1", [a.binding]);
  await pool.query(
    `INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state)
    VALUES($1,$2,'fake','tenant-c',$3,'ACTIVE')`,
    [replacementBinding, a.device, `fake-${replacementBinding}`],
  );
  now = at(19);
  const transfer = await monitor.tick();
  check(transfer.resolved >= 1, 'binding transition closes the old tenant alert');
  now = at(23);
  await monitor.tick();
  const transferred = await pool.query(
    `SELECT tenant_id,mdm_binding_id,
    last_position_captured_at,last_health_observed_at FROM gps_continuity_alert
    WHERE device_id=$1 AND resolved_at IS NULL`,
    [a.device],
  );
  check(
    transferred.rows.length === 1 &&
      transferred.rows[0].tenant_id === 'tenant-c' &&
      transferred.rows[0].mdm_binding_id === replacementBinding &&
      transferred.rows[0].last_position_captured_at === null &&
      transferred.rows[0].last_health_observed_at === null,
    'binding transition resolves old alert and never reuses old tenant evidence',
  );

  const replacementInstallation = randomUUID();
  await pool.query('UPDATE gps_device_installation SET retired_at=$2 WHERE installation_id=$1', [
    a.installation,
    at(24),
  ]);
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at) VALUES($1,$2,$3)',
    [replacementInstallation, a.device, at(24)],
  );
  now = at(24);
  await monitor.tick();
  const reinstalled = await pool.query(
    `SELECT installation_id,last_position_captured_at,
    last_health_observed_at FROM gps_continuity_alert
    WHERE device_id=$1 AND resolved_at IS NULL`,
    [a.device],
  );
  check(
    reinstalled.rows.length === 1 &&
      reinstalled.rows[0].installation_id === replacementInstallation &&
      reinstalled.rows[0].last_position_captured_at === null &&
      reinstalled.rows[0].last_health_observed_at === null,
    'new installation begins a separate alert episode without prior evidence',
  );
  check(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM gps_continuity_alert
    WHERE device_id=$1 AND resolution_reason='INSTALLATION_CHANGED'`,
        [a.device],
      )
    ).rows[0].n === 1,
    'previous installation alert has an explicit resolution reason',
  );

  const afterRestart = await fixture('tenant-d', false);
  now = at(30);
  const policies = new GpsPolicyService(pool);
  const scheduler = new GpsScheduler(
    pool,
    policies,
    new GpsEventService(pool, policies, Buffer.alloc(32, 73)),
    new GpsHealthService(pool, policies),
    () => now,
  );
  await scheduler.tick();
  const materialized = await pool.query(
    `SELECT count(*)::int AS n FROM gps_scheduled_session
     WHERE device_id=$1 AND state='SCHEDULED' AND start_at <= $2 AND $2 < end_at`,
    [afterRestart.device, now],
  );
  check(
    materialized.rows[0].n === 1,
    'scheduler restart during shift materializes its active window',
  );

  const fleet = [];
  for (let index = 0; index < 22; index++) fleet.push(await fixture('tenant-a'));
  await monitor.tick();
  const fleetIds = new Set(fleet.map((item) => item.device));
  const fleetPages = [];
  let next = '?status=OPEN&limit=10';
  while (next) {
    const response = await read(next);
    check(response.statusCode === 200, '25-device synthetic fleet page authorized');
    const page = response.json();
    fleetPages.push(...page.items);
    next = page.next_cursor
      ? `?status=OPEN&limit=10&cursor=${encodeURIComponent(page.next_cursor)}`
      : '';
  }
  check(
    fleetPages.length === 22 &&
      fleetPages.every((item) => fleetIds.has(item.device_id)) &&
      new Set(fleetPages.map((item) => item.alert_id)).size === fleetPages.length,
    '25-device fleet pages remain tenant isolated and do not duplicate alerts',
  );

  now = at(60);
  const end = await monitor.tick();
  check(
    end.opened === 0 &&
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM gps_continuity_alert WHERE resolved_at IS NULL',
        )
      ).rows[0].n === 0,
    'end of shift resolves alerts without opening off-hours alerts',
  );
  now = at(65);
  check((await monitor.tick()).opened === 0, 'outside shift remains silent');
  console.log(`gps-continuity integration PASS: ${checks} assertions`);
} finally {
  await app.close();
  await pool.end();
}
