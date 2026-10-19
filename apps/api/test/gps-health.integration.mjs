// Run only against an explicitly named disposable geops_verify_* PostgreSQL database.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { requestProofBytes } from '@geops/api-contracts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceSessionService } from '../src/device-identity/session.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsHealthService } from '../src/gps-health-service.ts';

const url = process.env.DATABASE_URL;
if (!url || !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic')
  throw new Error('Disposable geops_verify_* database and synthetic mode required');
const pool = new pg.Pool({ connectionString: url, max: 10 });
const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
assert.match(database, /^geops_verify_[0-9]+(?:_restore)?$/);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
const auth = new AdminAuthService(pool, { sessionKey: Buffer.alloc(32, 3),
  csrfKey: Buffer.alloc(32, 4), allowedOrigins: ['https://geops.example.invalid'] });
const sessions = new DeviceSessionService(pool);
const policies = new GpsPolicyService(pool);
const health = new GpsHealthService(pool, policies);
const app = createApp({ readinessProbe: async () => true, logLevel: 'silent', adminAuth: auth,
  deviceSessions: sessions, gpsPolicies: policies, gpsHealth: health, secureCookie: false });
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const sha = (value) => createHash('sha256').update(value).digest();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
let cookie;

try {
  const adminId = await auth.bootstrap('health@example.invalid', 'synthetic-password-12345678');
  await pool.query("INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.session.read',$1,'Synthetic health read')", [adminId]);
  const login = await app.inject({ method: 'POST', url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'health@example.invalid', password: 'synthetic-password-12345678' } });
  check(login.statusCode === 200, 'admin login');
  cookie = login.headers['set-cookie'].split(';')[0];

  const deviceId = randomUUID(), keyId = randomUUID(), bindingId = randomUUID();
  const installationId = randomUUID(), anchorId = randomUUID(), scheduledId = randomUUID();
  const policyId = randomUUID(), token = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','synthetic health device')", [deviceId]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-a','synthetic-1','ACTIVE')", [bindingId, deviceId]);
  await pool.query("INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')", [keyId, deviceId, spki, sha(spki)]);
  await pool.query('INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), deviceId, keyId, sha(token), iso(-60_000), iso(600_000)]);
  await pool.query('INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,$5)',
    [installationId, deviceId, iso(-86_400_000), bindingId, 'tenant-a']);
  await pool.query("INSERT INTO gps_policy(id,name,state,draft_config,created_by) VALUES($1,'Synthetic health','ACTIVE','{}',$2)", [policyId, adminId]);
  await pool.query(`INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,
    capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,valid_from,valid_until,created_by,reason)
    VALUES($1,1,ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59','UTC',60,300,300,300,$2,$3,$4,'Synthetic health policy')`,
    [policyId, iso(-86_400_000), iso(86_400_000), adminId]);
  await pool.query("INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,local_date,start_at,end_at,state) VALUES($1,$2,$3,1,1,CURRENT_DATE,$4,$5,'SCHEDULED')",
    [scheduledId, deviceId, policyId, iso(-3_600_000), iso(3_600_000)]);
  const anchorTime = iso(-120_000);
  await pool.query('INSERT INTO gps_policy_delivery(capture_anchor_id,device_id,installation_id,assignment_version,health_mdm_binding_id,health_tenant_id,server_time,offline_not_after) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
    [anchorId, deviceId, installationId, bindingId, 'tenant-a', anchorTime, iso(3_600_000)]);

  const observedAt = new Date(Date.parse(anchorTime) + 120_000).toISOString();
  const event = { event_id: randomUUID(), device_id: deviceId, installation_id: installationId,
    assignment_version: 1, policy_revision: 1,
    due_at: new Date(Date.parse(observedAt) - 1000).toISOString(), observed_at: observedAt,
    boot_id: randomUUID(), capture_anchor_id: anchorId, anchor_elapsed_realtime_ms: 1000,
    elapsed_realtime_ms: 121000, battery_percent: 15, charging: false, plugged: false,
    power_save: false, provider_available: true, network_available: true,
    tracking_state: 'RUNNING', observed_states: ['BATTERY_LOW'] };
  const batch = { schema_version: 1, batch_id: randomUUID(), device_id: deviceId,
    installation_id: installationId, events: [event] };
  async function post(payload, nonce = randomBytes(16).toString('base64url')) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bytes = requestProofBytes({ method: 'POST', absolutePath: '/v1/device/health/batches',
      bodySha256: sha(body).toString('base64url'), tokenSha256: sha(token).toString('base64url'),
      timestamp, nonce, keyId });
    const signature = sign('sha256', bytes, pair.privateKey).toString('base64url');
    return app.inject({ method: 'POST', url: '/v1/device/health/batches',
      headers: { authorization: `Bearer ${token}`, 'x-geops-key-id': keyId,
        'x-geops-timestamp': timestamp, 'x-geops-nonce': nonce,
        'x-geops-signature': signature, 'content-type': 'application/json' }, payload: body });
  }
  async function read(extra = {}, path = `/v1/admin/devices/${deviceId}/health`) {
    return app.inject({ method: 'GET', url: path, headers: { cookie,
      'x-geops-access-reason': 'Synthetic health investigation', ...extra } });
  }
  const anonymous = await app.inject({ method: 'POST', url: '/v1/device/health/batches', payload: batch });
  check(anonymous.statusCode === 401, 'anonymous device denied');
  const oversized = await app.inject({ method: 'POST', url: '/v1/device/health/batches',
    headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ pad: 'x'.repeat(131072) }) });
  if (oversized.statusCode !== 413) console.error('oversized', oversized.statusCode, oversized.payload.slice(0, 300));
  check(oversized.statusCode === 413, 'oversized batch rejected');
  const first = await post(batch);
  if (first.statusCode !== 200) console.error('first ingest', first.statusCode, first.payload);
  check(first.statusCode === 200 && first.json().accepted_event_ids[0] === event.event_id, 'persisted ACK');
  const receipt = await pool.query('SELECT count(*)::int AS n FROM gps_device_health_event WHERE device_id=$1', [deviceId]);
  check(receipt.rows[0].n === 1, 'one stored event');
  const retry = await post(batch);
  check(retry.statusCode === 200 && retry.json().persisted_at === first.json().persisted_at, 'same batch replay ACK');
  const replayNonce = randomBytes(16).toString('base64url');
  await post(batch, replayNonce);
  const replay = await post(batch, replayNonce);
  check(replay.statusCode === 409, 'PoP nonce replay rejected');
  const otherBatch = await post({ ...batch, batch_id: randomUUID() });
  check(otherBatch.statusCode === 200 && otherBatch.json().duplicate_event_ids[0] === event.event_id,
    'event replay in another batch idempotent');
  const conflict = await post({ ...batch, batch_id: randomUUID(),
    events: [{ ...event, battery_percent: 12 }] });
  check(conflict.statusCode === 409, 'changed event conflict');
  const invalid = await post({ ...batch, batch_id: randomUUID(),
    events: [{ ...event, event_id: randomUUID() },
      { ...event, event_id: randomUUID(), battery_percent: 110 }] });
  check(invalid.statusCode === 422 && invalid.json().invalid_event_ids.length === 1,
    'invalid battery rejected with event ID');
  check((await pool.query('SELECT count(*)::int AS n FROM gps_device_health_event WHERE device_id=$1',
    [deviceId])).rows[0].n === 1, 'mixed valid/invalid batch atomic');
  await pool.query('DELETE FROM gps_health_request_quota WHERE device_id=$1', [deviceId]);
  const foreignId = randomUUID();
  check((await post({ ...batch, batch_id: randomUUID(), device_id: foreignId,
    events: [{ ...event, device_id: foreignId }] })).statusCode === 403,
  'client-claimed device ID cannot override PoP identity');
  const secondEvent = { ...event, event_id: randomUUID(),
    observed_at: new Date(Date.parse(event.observed_at) + 1000).toISOString(),
    due_at: event.observed_at, elapsed_realtime_ms: event.elapsed_realtime_ms + 1000,
    battery_percent: 2, observed_states: ['BATTERY_CRITICAL'] };
  const secondBatch = { ...batch, batch_id: randomUUID(), events: [secondEvent] };
  const concurrent = await Promise.all([post(secondBatch), post(secondBatch)]);
  check(concurrent.every((x) => x.statusCode === 200), 'concurrent same batch committed once');
  check((await pool.query('SELECT count(*)::int AS n FROM gps_device_health_event WHERE device_id=$1',
    [deviceId])).rows[0].n === 2, 'concurrent ingest has one event per ID');
  const denied = await read();
  check(denied.statusCode === 404, 'admin without tenant grant denied');
  check((await read({ cookie: '' })).statusCode === 401, 'anonymous admin read denied');
  await pool.query("INSERT INTO gps_health_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,'Synthetic tenant grant')", [adminId]);
  const visible = await read();
  if (visible.statusCode !== 200) console.error('read', visible.statusCode, visible.payload);
  check(visible.statusCode === 200 && visible.json().latest.event_id === secondEvent.event_id,
    'tenant-scoped latest event');
  const silent = await new GpsHealthService(pool, policies,
    () => new Date(Date.now() + 360_000)).read(adminId, randomUUID(), deviceId,
    'Synthetic silence check', undefined, 25);
  check(silent.state === 'NO_COMMUNICATION' && silent.possible_battery_depletion === true &&
    silent.source === 'SERVER_INFERENCE', 'low battery plus silence remains inference');
  const page1 = await read({}, `/v1/admin/devices/${deviceId}/health?limit=1`);
  check(page1.statusCode === 200 && page1.json().items.length === 1 &&
    typeof page1.json().next_cursor === 'string', 'first history page');
  const page2 = await read({}, `/v1/admin/devices/${deviceId}/health?limit=1&cursor=${page1.json().next_cursor}`);
  check(page2.statusCode === 200 && page2.json().items[0].event_id !== page1.json().items[0].event_id,
    'history cursor advances');
  check((await read({}, `/v1/admin/devices/${deviceId}/health?cursor=bad`)).statusCode === 422,
    'invalid cursor denied');
  check((await read({}, `/v1/admin/devices/${randomUUID()}/health`)).statusCode === 404,
    'another device not visible');
  await pool.query("UPDATE gps_health_tenant_access SET revoked_at=now() WHERE admin_id=$1 AND tenant_id='tenant-a' AND revoked_at IS NULL", [adminId]);
  await pool.query("INSERT INTO gps_health_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-b',$1,'Synthetic other tenant')", [adminId]);
  check((await read()).statusCode === 404, 'tenant-b scope cannot read tenant-a device');
  await pool.query("INSERT INTO gps_health_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,'Synthetic tenant regrant')", [adminId]);
  check((await read({ 'x-geops-access-reason': '' })).statusCode === 422,
    'access reason required');
  const audit = await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action='gps.health.read' AND outcome='success' AND actor_id=$1", [adminId]);
  check(audit.rows[0].n >= 1, 'sensitive read audited');
  await pool.query('DELETE FROM gps_health_request_quota WHERE device_id=$1', [deviceId]);
  for (let i = 0; i < 6; i++) check((await post(batch)).statusCode === 200, 'quota accepted');
  const limited = await post(batch);
  check(limited.statusCode === 429 && Number(limited.headers['retry-after']) > 0, 'quota rejected with Retry-After');
  await pool.query('DELETE FROM gps_health_request_quota WHERE device_id=$1', [deviceId]);
  await pool.query("UPDATE mdm_binding SET state='REVOKED' WHERE id=$1", [bindingId]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-b','synthetic-transferred','ACTIVE')", [randomUUID(), deviceId]);
  const transferred = await post({ ...batch, batch_id: randomUUID(),
    events: [{ ...secondEvent, event_id: randomUUID() }] });
  check(transferred.statusCode === 403, 'old tenant installation denied after transfer');
  await pool.query("UPDATE device_key SET status='REVOKED',revoked_at=now() WHERE id=$1", [keyId]);
  const revoked = await post(batch);
  check(revoked.statusCode === 403, 'revoked key denied');
  await pool.query("UPDATE gps_device_health_event SET observed_at=now()-interval '91 days',due_at=now()-interval '91 days'-interval '1 second' WHERE event_id=$1", [event.event_id]);
  await pool.query("UPDATE gps_health_batch_receipt SET persisted_at=now()-interval '91 days' WHERE batch_id=$1", [batch.batch_id]);
  check((await health.purgeExpired()) === 1, '90-day retention deletes old event');
  check((await pool.query('SELECT 1 FROM gps_health_batch_receipt WHERE batch_id=$1',
    [batch.batch_id])).rowCount === 0, 'expired receipt deleted');
  await pool.query("UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='gps.session.read'", [adminId]);
  check((await read()).statusCode === 403, 'revoked admin capability denied');
  console.log(`GPS health integration PASS: ${checks} assertions; disposable DB ${database}`);
} finally {
  await app.close();
  await pool.end();
}
