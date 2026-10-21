// Destructive fixtures are allowed only in the explicitly named disposable database.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requestProofBytes } from '@geops/api-contracts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceSessionService } from '../src/device-identity/session.ts';
import { GpsDeviceConfigService } from '../src/gps-device-config.ts';
import { GpsEventService } from '../src/gps-event-service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';

const url = process.env.DATABASE_URL;
if (!url || !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic') throw new Error('Disposable DB required');
const pool = new pg.Pool({ connectionString: url, max: 10 });
assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,
  /^geops_verify_[0-9]+(?:_restore)?$/);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
const auth = new AdminAuthService(pool, { sessionKey: Buffer.alloc(32, 31),
  csrfKey: Buffer.alloc(32, 32), allowedOrigins: ['https://geops.example.invalid'] });
const sessions = new DeviceSessionService(pool);
const policies = new GpsPolicyService(pool);
const config = new GpsDeviceConfigService(pool);
const events = new GpsEventService(pool, policies, Buffer.alloc(32, 33));
const app = createApp({ readinessProbe: async () => true, logLevel: 'silent', adminAuth: auth,
  deviceSessions: sessions, gpsPolicies: policies, gpsDeviceConfig: config,
  gpsEvents: events, secureCookie: false });
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }
const sha = (value) => createHash('sha256').update(value).digest();
const DAY = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const clock = (offset) => iso(offset * 60_000).slice(11, 16);
const at = (serverTime, offset) => new Date(Date.parse(serverTime) + offset).toISOString();
function javaNameUuid(value) {
  const bytes = createHash('md5').update(value).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

try {
  const adminId = await auth.bootstrap('events@example.invalid', 'synthetic-password-12345678');
  for (const permission of ['gps.policy.read', 'gps.policy.write', 'gps.policy.assign',
    'gps.policy.activate', 'gps.session.read', 'gps.location.read'])
    await pool.query('INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Synthetic GPS event integration']);
  const login = await app.inject({ method: 'POST', url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'events@example.invalid', password: 'synthetic-password-12345678' } });
  check(login.statusCode === 200, 'admin login');
  const cookie = login.headers['set-cookie'].split(';')[0], csrf = login.json().csrf_token;
  const admin = (method, path, payload, etag) => app.inject({ method, url: path,
    headers: { cookie, origin: 'https://geops.example.invalid', 'x-csrf-token': csrf,
      'idempotency-key': randomUUID(), ...(etag ? { 'if-match': etag } : {}) }, payload });
  const deviceId = randomUUID(), keyId = randomUUID(), bindingId = randomUUID();
  const installationId = randomUUID(), token = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','synthetic events device')", [deviceId]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-a','synthetic-events-1','ACTIVE')", [bindingId, deviceId]);
  await pool.query("INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')", [keyId, deviceId, spki, sha(spki)]);
  await pool.query('INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), deviceId, keyId, sha(token), iso(-60_000), iso(600_000)]);
  await pool.query('INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,$5)',
    [installationId, deviceId, iso(-60_000), bindingId, 'tenant-a']);
  const policy = { name: 'Synthetic event policy', days_iso: [1, 2, 3, 4, 5, 6, 7],
    start_local: clock(-60), end_local: clock(60), time_zone: 'UTC',
    capture_interval_s: 60, sync_interval_s: 300, health_interval_s: 300,
    heartbeat_missing_after_s: 900, valid_from: iso(-DAY), valid_until: iso(7 * DAY) };
  const created = await admin('POST', '/v1/admin/gps-policies', policy);
  check(created.statusCode === 201, 'policy created');
  const policyId = created.json().id;
  const assigned = await admin('PUT', `/v1/admin/gps-policies/${policyId}/assignments`,
    { assignments: [{ scope_type: 'DEVICE', scope_id: deviceId,
      valid_from: iso(-3_600_000), valid_until: iso(7 * DAY) }] }, created.headers.etag);
  check(assigned.statusCode === 200, 'policy assigned');
  const published = await admin('POST', `/v1/admin/gps-policies/${policyId}/publish`,
    { reason: 'Synthetic event approval' }, assigned.headers.etag);
  check(published.statusCode === 200, 'policy published');

  async function device(method, path, payload, nonce = randomBytes(16).toString('base64url')) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bytes = requestProofBytes({ method, absolutePath: path,
      bodySha256: sha(body).toString('base64url'), tokenSha256: sha(token).toString('base64url'),
      timestamp, nonce, keyId });
    return app.inject({ method, url: path,
      headers: { authorization: `Bearer ${token}`, 'x-geops-key-id': keyId,
        'x-geops-timestamp': timestamp, 'x-geops-nonce': nonce,
        'x-geops-signature': sign('sha256', bytes, pair.privateKey).toString('base64url'),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: body }) });
  }
  const snapshotResponse = await device('GET', '/v1/device/config');
  check(snapshotResponse.statusCode === 200, 'authenticated config');
  const snap = snapshotResponse.json();
  check(snap.active && snap.window_instances.length > 0 && snap.installation_id === installationId,
    'canonical snapshot and UTC window');
  const clientId = randomUUID(), bootId = randomUUID();
  const scheduledId = snap.window_instances.find((w) =>
    Date.parse(w.start_at) <= Date.parse(snap.server_time) &&
    Date.parse(snap.server_time) < Date.parse(w.end_at))?.scheduled_session_id;
  check(Boolean(scheduledId), 'current scheduled window exists');
  const base = { assignment_version: snap.assignment_version, boot_id: bootId,
    capture_anchor_id: snap.capture_anchor_id, anchor_elapsed_realtime_ms: 1000 };
  const start = { event_id: randomUUID(), client_session_id: clientId,
    scheduled_session_id: scheduledId, type: 'STARTED', occurred_at: at(snap.server_time, 1000),
    ...base, elapsed_realtime_ms: 2000, reason_code: null };
  const missed = { event_id: randomUUID(), type: 'MISSED_START',
    occurred_at: snap.server_time, assignment_version: snap.assignment_version,
    boot_id: bootId, elapsed_realtime_ms: 1000, reason_code: 'FGS_START_BLOCKED' };
  const point = { event_id: randomUUID(), client_session_id: clientId,
    assignment_version: snap.assignment_version, captured_at: at(snap.server_time, 2000),
    latitude: 14.61, longitude: -90.52, accuracy_m: 8.5, boot_id: bootId,
    anchor_elapsed_realtime_ms: 1000, elapsed_realtime_ms: 3000,
    capture_anchor_id: snap.capture_anchor_id };
  const path = '/v2/device/gps/batches';
  const mixed = (clientId, items, batchId = randomUUID()) => ({
    schema_version: 2, batch_id: batchId, device_id: deviceId,
    installation_id: installationId, client_session_id: clientId,
    events: items.map(([kind, payload]) => ({ kind, payload })),
  });
  const first = mixed(clientId, [['SESSION', start], ['POSITION', point]]);
  check((await app.inject({ method: 'POST', url: path, payload: first })).statusCode === 401,
    'v2 requires authenticated device');
  const accepted = await device('POST', path, first);
  if (accepted.statusCode !== 200) console.error('v2-first', accepted.statusCode, accepted.payload);
  check(accepted.statusCode === 200, 'STARTED and first position committed together');
  check(new Set(accepted.json().accepted_event_ids).size === 2 &&
    accepted.json().accepted_event_ids.includes(start.event_id) &&
    accepted.json().accepted_event_ids.includes(point.event_id), 'exact combined ACK');
  check(accepted.json().session_mappings[0]?.client_session_id === clientId,
    'canonical session mapping returned');
  check((await pool.query('SELECT count(*)::int AS n FROM gps_effective_session WHERE client_session_id=$1',
    [clientId])).rows[0].n === 1, 'one canonical session');
  check((await pool.query('SELECT count(*)::int AS n FROM position_event WHERE event_id=$1',
    [point.event_id])).rows[0].n === 1, 'first point linked and persisted');
  const lostAckRetry = await device('POST', path, first);
  check(lostAckRetry.statusCode === 200 &&
    lostAckRetry.json().persisted_at === accepted.json().persisted_at,
    'lost ACK retry returns original receipt');
  const duplicate = await device('POST', path, mixed(clientId,
    [['SESSION', start], ['POSITION', point]]));
  check(duplicate.statusCode === 200 && duplicate.json().duplicate_event_ids.length === 2,
    'new batch with original IDs is deduplicated');
  const orphanId = randomUUID();
  const orphanPoint = { ...point, event_id: randomUUID(), client_session_id: orphanId };
  const pending = await device('POST', path, mixed(orphanId, [['POSITION', orphanPoint]]));
  check(pending.statusCode === 202 && pending.json().pending_event_ids[0] === orphanPoint.event_id,
    'missing STARTED is pending without ACK');
  check((await pool.query('SELECT 1 FROM position_event WHERE event_id=$1',
    [orphanPoint.event_id])).rowCount === 0, 'orphan point not persisted');
  check((await device('POST', path, { ...first, batch_id: randomUUID(),
    device_id: randomUUID() })).statusCode === 403, 'body device cannot override PoP principal');
  check((await device('POST', path, mixed(clientId, [['SESSION', start],
    ['POSITION', orphanPoint]]))).statusCode === 422,
    'mixed local sessions rejected atomically');
  const stop = { ...start, event_id: randomUUID(), type: 'STOPPED',
    occurred_at: at(snap.server_time, 3000), elapsed_realtime_ms: 4000,
    reason_code: 'WINDOW_END' };
  const v1Stop = { schema_version: 1, batch_id: randomUUID(), device_id: deviceId,
    installation_id: installationId, events: [stop] };
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const stopResponse = await device('POST', '/v1/device/gps-session-events/batches', v1Stop);
  if (stopResponse.statusCode !== 200) console.error('v1-stop', stopResponse.statusCode, stopResponse.payload);
  check(stopResponse.statusCode === 200,
    'v1 session endpoint remains compatible');
  const badClient = randomUUID();
  const badStart = { ...start, event_id: randomUUID(), client_session_id: badClient,
    occurred_at: at(snap.server_time, 4000), elapsed_realtime_ms: 5000 };
  const badPoint = { ...point, event_id: randomUUID(), client_session_id: badClient,
    session_id: randomUUID(), captured_at: at(snap.server_time, 5000),
    elapsed_realtime_ms: 6000 };
  const rolledBack = await device('POST', path, mixed(badClient,
    [['SESSION', badStart], ['POSITION', badPoint]]));
  check(rolledBack.statusCode === 422 &&
    rolledBack.json().invalid_event_ids.includes(badPoint.event_id),
    'invalid canonical link rolls back combined batch');
  check((await pool.query('SELECT 1 FROM gps_effective_session WHERE client_session_id=$1',
    [badClient])).rowCount === 0, 'rollback removes started session');
  check((await pool.query('SELECT 1 FROM gps_mixed_batch_receipt WHERE batch_id=$1',
    [first.batch_id])).rowCount === 1, 'receipt exists only for committed batch');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const legacyClient = randomUUID();
  const legacyStart = { ...start, event_id: randomUUID(), client_session_id: legacyClient,
    occurred_at: at(snap.server_time, 7000), elapsed_realtime_ms: 8000 };
  const legacyPoint = { ...point, event_id: randomUUID(), client_session_id: legacyClient,
    captured_at: at(snap.server_time, 8000), elapsed_realtime_ms: 9000 };
  const legacyV1Point = { schema_version: 1, batch_id: randomUUID(), device_id: deviceId,
    installation_id: installationId, events: [legacyPoint] };
  check((await device('POST', '/v1/device/locations/batches', legacyV1Point)).statusCode === 202,
    'existing v1 buffer waits for STARTED');
  check((await device('POST', path, mixed(legacyClient,
    [['SESSION', legacyStart], ['POSITION', legacyPoint]]))).statusCode === 200,
    'v2 reconciles a pending v1 position in one commit');
  const legacyReplayed = await device('POST', '/v1/device/locations/batches', legacyV1Point);
  check(legacyReplayed.statusCode === 200 &&
    legacyReplayed.json().duplicate_event_ids.includes(legacyPoint.event_id),
    'v1 buffer replay receives exact duplicate ACK after v2 reconciliation');
  const legacyStop = { ...legacyStart, event_id: randomUUID(), type: 'STOPPED',
    occurred_at: at(snap.server_time, 9000), elapsed_realtime_ms: 10000,
    reason_code: 'WINDOW_END' };
  check((await device('POST', '/v1/device/gps-session-events/batches',
    { ...v1Stop, batch_id: randomUUID(), events: [legacyStop] })).statusCode === 200,
    'reconciled legacy session closes before the next session');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const concurrentClient = randomUUID();
  const concurrentStart = { ...start, event_id: randomUUID(),
    client_session_id: concurrentClient, occurred_at: at(snap.server_time, 10000),
    elapsed_realtime_ms: 11000 };
  const concurrentPoint = { ...point, event_id: randomUUID(),
    client_session_id: concurrentClient, captured_at: at(snap.server_time, 11000),
    elapsed_realtime_ms: 12000 };
  const concurrentBatch = mixed(concurrentClient,
    [['POSITION', concurrentPoint], ['SESSION', concurrentStart]]);
  const concurrent = await Promise.all([device('POST', path, concurrentBatch),
    device('POST', path, concurrentBatch)]);
  check(concurrent.every((response) => response.statusCode === 200),
    'concurrent identical batches both ACK');
  check(concurrent[0].json().persisted_at === concurrent[1].json().persisted_at,
    'concurrent retry shares receipt');
  check((await pool.query('SELECT count(*)::int AS n FROM gps_effective_session WHERE client_session_id=$1',
    [concurrentClient])).rows[0].n === 1, 'concurrency creates one session');
  console.log(`gps-mixed integration PASS: ${checks} assertions`);
} finally {
  await app.close();
  await pool.end();
}
