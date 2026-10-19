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
  const sessionPath = '/v1/device/gps-session-events/batches';
  const positionPath = '/v1/device/locations/batches';
  const batch = (events) => ({ schema_version: 1, batch_id: randomUUID(),
    device_id: deviceId, installation_id: installationId, events });
  const pointBatch = batch([point]);
  pointBatch.batch_id = javaNameUuid(`LOCATION:${point.event_id}`);
  check((await app.inject({ method: 'POST', url: positionPath, payload: pointBatch })).statusCode === 401,
    'anonymous position rejected');
  const early = await device('POST', positionPath, pointBatch);
  check(early.statusCode === 202 && early.json().pending_event_ids[0] === point.event_id,
    'out-of-order position quarantined, no ACK');
  check((await device('POST', positionPath, pointBatch)).statusCode === 202,
    'pending batch retries without terminal ACK');
  const quarantine = await pool.query('SELECT payload_ciphertext,payload_nonce FROM gps_event_quarantine WHERE event_id=$1',
    [point.event_id]);
  check(quarantine.rowCount === 1 && !quarantine.rows[0].payload_ciphertext.includes(Buffer.from('14.61')),
    'pending coordinate encrypted at rest');
  check((await pool.query('SELECT 1 FROM position_event WHERE event_id=$1', [point.event_id])).rowCount === 0,
    'pending point not projected');
  const orphanStop = { event_id: randomUUID(), client_session_id: randomUUID(),
    type: 'STOPPED', occurred_at: at(snap.server_time, 5000),
    ...base, elapsed_realtime_ms: 6000, reason_code: 'UNKNOWN' };
  const orphanBatch = batch([orphanStop]);
  const pendingStop = await device('POST', sessionPath, orphanBatch);
  check(pendingStop.statusCode === 202 && pendingStop.json().pending_event_ids[0] === orphanStop.event_id,
    'STOPPED before STARTED quarantined without invented effective session');
  const sessionBatch = batch([missed, start]);
  sessionBatch.batch_id = javaNameUuid(`SESSION:${missed.event_id},${start.event_id}`);
  const started = await device('POST', sessionPath, sessionBatch);
  if (started.statusCode !== 200) console.error('start', started.statusCode, started.payload);
  check(started.statusCode === 200 && started.json().session_mappings.length === 1,
    'STARTED creates canonical session and MISSED_START remains diagnostic');
  const sessionId = started.json().session_mappings[0].session_id;
  const effective = await pool.query('SELECT state,started_at FROM gps_effective_session WHERE id=$1', [sessionId]);
  check(effective.rows[0]?.state === 'OPEN', 'effective start persisted');
  const acceptedPoint = await device('POST', positionPath, pointBatch);
  if (acceptedPoint.statusCode !== 200) console.error('position', acceptedPoint.statusCode, acceptedPoint.payload);
  check(acceptedPoint.statusCode === 200 && acceptedPoint.json().accepted_event_ids[0] === point.event_id,
    'pending point reconciled and ACK persisted');
  check((await pool.query('SELECT 1 FROM gps_event_quarantine WHERE event_id=$1', [point.event_id])).rowCount === 0,
    'quarantine removed after ACK');
  const retry = await device('POST', positionPath, pointBatch);
  check(retry.statusCode === 200 && retry.json().persisted_at === acceptedPoint.json().persisted_at,
    'same batch retry idempotent');
  const duplicate = await device('POST', positionPath, batch([point]));
  check(duplicate.statusCode === 200 && duplicate.json().duplicate_event_ids[0] === point.event_id,
    'same point in new batch duplicate');
  const conflict = await device('POST', positionPath, batch([{ ...point, latitude: 14.62 }]));
  check(conflict.statusCode === 409, 'changed event ID conflicts');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const bad = await device('POST', positionPath, batch([{ ...point, event_id: randomUUID(), latitude: 91 }]));
  check(bad.statusCode === 422 && bad.json().invalid_event_ids.length === 1,
    'invalid latitude rejected');
  check((await device('POST', positionPath, batch([{ ...point, event_id: randomUUID(),
    session_id: randomUUID() }]))).statusCode === 422,
  'client-declared canonical session ID cannot override server mapping');
  const tooMany = Array.from({ length: 101 }, () => ({ ...point, event_id: randomUUID() }));
  check((await device('POST', positionPath, batch(tooMany))).statusCode === 422,
    '101 positions exceed batch event limit');
  const oversized = await app.inject({ method: 'POST', url: positionPath,
    headers: { 'content-type': 'application/json' }, payload: JSON.stringify({
      pad: 'x'.repeat(262_144) }) });
  check(oversized.statusCode === 413, '256 KiB position body limit enforced before ingest');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const interrupt = { event_id: randomUUID(), client_session_id: clientId, type: 'INTERRUPTED',
    occurred_at: at(snap.server_time, 3000), ...base, elapsed_realtime_ms: 4000,
    reason_code: 'GPS_DISABLED' };
  check((await device('POST', sessionPath, batch([interrupt]))).statusCode === 200,
    'reported interruption persisted');
  const interruptedPoint = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 4000), elapsed_realtime_ms: 5000 };
  check((await device('POST', positionPath, batch([interruptedPoint]))).statusCode === 422,
    'point during interruption rejected');
  const resumed = { ...interrupt, event_id: randomUUID(), type: 'RESUMED',
    occurred_at: at(snap.server_time, 5000), elapsed_realtime_ms: 6000, reason_code: null };
  check((await device('POST', sessionPath, batch([resumed]))).statusCode === 200,
    'reported resume persisted');
  const secondPoint = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 6000), elapsed_realtime_ms: 7000 };
  check((await device('POST', positionPath, batch([secondPoint]))).statusCode === 200,
    'point after resume accepted');
  const stopped = { ...interrupt, event_id: randomUUID(), type: 'STOPPED',
    occurred_at: at(snap.server_time, 8000), elapsed_realtime_ms: 9000,
    reason_code: 'WINDOW_END' };
  check((await device('POST', sessionPath, batch([stopped]))).statusCode === 200,
    'effective stop persisted');
  check((await pool.query('SELECT state,stopped_at FROM gps_effective_session WHERE id=$1',
    [sessionId])).rows[0]?.state === 'STOPPED', 'session stopped without inferred time');
  const afterStop = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 9000), elapsed_realtime_ms: 10000 };
  check((await device('POST', positionPath, batch([afterStop]))).statusCode === 422,
    'point after effective stop rejected');
  const missingGrant = await app.inject({ method: 'GET',
    url: `/v1/admin/devices/${deviceId}/locations?from=${encodeURIComponent(iso(-60_000))}&to=${encodeURIComponent(iso(60_000))}`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic review' } });
  check(missingGrant.statusCode === 404, 'tenant grant required');
  await pool.query("INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,'Synthetic tenant grant')", [adminId]);
  const readPath = `/v1/admin/devices/${deviceId}/locations?from=${encodeURIComponent(iso(-60_000))}&to=${encodeURIComponent(iso(60_000))}`;
  const locations = await app.inject({ method: 'GET', url: readPath,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic review' } });
  check(locations.statusCode === 200 && locations.json().items.length === 2 &&
    locations.json().items[0].latitude === 14.61, 'authorized PostGIS coordinate read');
  const filtered = await app.inject({ method: 'GET', url: `${readPath}&session_id=${sessionId}`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic review' } });
  check(filtered.statusCode === 200 && filtered.json().items.every((item) => item.session_id === sessionId),
    'position history filters by canonical session');
  check((await app.inject({ method: 'GET', url: `${readPath}&session_id=not-a-uuid`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic review' } })).statusCode === 422,
    'invalid session filter rejected');
  const sessionsRead = await app.inject({ method: 'GET',
    url: `/v1/admin/devices/${deviceId}/gps-sessions`, headers: { cookie } });
  check(sessionsRead.statusCode === 200 && sessionsRead.json().items.some((s) =>
    s.session_id === sessionId && s.state === 'STOPPED' && s.missed_start_reported),
    'scheduled and effective states distinguished');
  check((await app.inject({ method: 'GET', url: readPath, headers: { cookie } })).statusCode === 422,
    'sensitive read reason required');
  check((await app.inject({ method: 'GET', url: `/v1/admin/devices/${deviceId}/locations`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic review' } })).statusCode === 422,
  'sensitive read UTC range required');
  const audit = await pool.query("SELECT metadata_redacted FROM audit_event WHERE action='gps.location.read' AND actor_id=$1 AND outcome='success' ORDER BY occurred_at DESC LIMIT 1", [adminId]);
  check(audit.rows[0]?.metadata_redacted?.access_reason === 'Synthetic review' &&
    !JSON.stringify(audit.rows[0].metadata_redacted).includes('latitude'),
    'sensitive read reason audited without coordinates');
  const indexes = await pool.query("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='position_event' AND indexdef ILIKE '%gist%' AND indexdef ILIKE '%geom%'");
  check(indexes.rows[0].n >= 1, 'PostGIS spatial index present');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const concurrentPoint = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 7000), elapsed_realtime_ms: 8000 };
  const concurrentBatch = batch([concurrentPoint]);
  const concurrent = await Promise.all([
    device('POST', positionPath, concurrentBatch), device('POST', positionPath, concurrentBatch),
  ]);
  check(concurrent.every((result) => result.statusCode === 200) &&
    concurrent[0].json().persisted_at === concurrent[1].json().persisted_at,
    'concurrent duplicate batch serializes to one ACK');
  check((await pool.query('SELECT count(*)::int AS n FROM position_event WHERE event_id=$1',
    [concurrentPoint.event_id])).rows[0].n === 1, 'concurrent write persists one position');
  const rollbackPoint = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 7500), elapsed_realtime_ms: 8500 };
  const invalidAfter = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 9000), elapsed_realtime_ms: 10000 };
  const rolledBack = await device('POST', positionPath, batch([rollbackPoint, invalidAfter]));
  check(rolledBack.statusCode === 422 && rolledBack.json().invalid_event_ids.includes(invalidAfter.event_id),
    'mixed valid/invalid position batch rejects atomically');
  check((await pool.query('SELECT 1 FROM position_event WHERE event_id=$1',
    [rollbackPoint.event_id])).rowCount === 0, 'valid point rolled back with invalid batch');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  for (let attempt = 0; attempt < 6; attempt++)
    check((await device('POST', positionPath, pointBatch)).statusCode === 200,
      'position request under per-device quota');
  const limited = await device('POST', positionPath, pointBatch);
  check(limited.statusCode === 429 && Number(limited.headers['retry-after']) > 0,
    'per-device quota returns Retry-After');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const replayNonce = randomBytes(16).toString('base64url');
  const replayBatch = batch([missed]);
  check((await device('POST', sessionPath, replayBatch, replayNonce)).statusCode === 200,
    'fresh signed diagnostic accepted');
  check((await device('POST', sessionPath, replayBatch, replayNonce)).statusCode === 409,
    'reused PoP nonce rejected');
  const foreignBatch = { ...batch([rollbackPoint]), device_id: randomUUID() };
  check((await device('POST', positionPath, foreignBatch)).statusCode === 403,
    'body device ID cannot override canonical PoP device');
  const outOfWindow = { ...point, event_id: randomUUID(),
    captured_at: at(snap.window_instances[0].end_at, 1000),
    elapsed_realtime_ms: Date.parse(snap.window_instances[0].end_at) -
      Date.parse(snap.server_time) + 2000 };
  check((await device('POST', positionPath, batch([outOfWindow]))).statusCode === 422,
    'capture beyond UTC window is not persisted');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  const openClient = randomUUID();
  const openStart = { ...start, event_id: randomUUID(), client_session_id: openClient,
    occurred_at: at(snap.server_time, 10_000), elapsed_realtime_ms: 11_000 };
  const openResponse = await device('POST', sessionPath, batch([openStart]));
  check(openResponse.statusCode === 200, 'new effective session after reported stop');
  const openId = openResponse.json().session_mappings[0].session_id;
  // Let the synthetic wall clock pass the declared second start before publishing a new version.
  const delay = Math.max(0, Date.parse(openStart.occurred_at) - Date.now() + 100);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const edited = await admin('PATCH', `/v1/admin/gps-policies/${policyId}`,
    { name: 'Synthetic event policy revision two' }, published.headers.etag);
  check(edited.statusCode === 200, 'new draft after first revision');
  const republished = await admin('POST', `/v1/admin/gps-policies/${policyId}/publish`,
    { reason: 'Synthetic replacement revision' }, edited.headers.etag);
  check(republished.statusCode === 200, 'replacement revision published');
  const nextConfig = await device('GET', '/v1/device/config');
  check(nextConfig.statusCode === 200 &&
    nextConfig.json().assignment_version > snap.assignment_version, 'new assignment version delivered');
  const next = nextConfig.json(), nextBoot = randomUUID(), nextClient = randomUUID();
  const nextWindow = next.window_instances.find((w) =>
    Date.parse(w.start_at) <= Date.parse(next.server_time) &&
    Date.parse(next.server_time) < Date.parse(w.end_at));
  check(Boolean(nextWindow), 'replacement UTC window materialized');
  const nextStart = { event_id: randomUUID(), client_session_id: nextClient,
    scheduled_session_id: nextWindow.scheduled_session_id, type: 'STARTED',
    occurred_at: at(next.server_time, 1000), assignment_version: next.assignment_version,
    boot_id: nextBoot, capture_anchor_id: next.capture_anchor_id,
    anchor_elapsed_realtime_ms: 1000, elapsed_realtime_ms: 2000, reason_code: null };
  check((await device('POST', sessionPath, batch([nextStart]))).statusCode === 200,
    'new version starts separate canonical session');
  const unknown = await pool.query('SELECT state,stopped_at,evidence_state FROM gps_effective_session WHERE id=$1',
    [openId]);
  check(unknown.rows[0]?.state === 'UNKNOWN_END' && unknown.rows[0].stopped_at === null &&
    unknown.rows[0].evidence_state === 'START_REPORTED_END_UNKNOWN',
    'replaced open session keeps unknown end without fabricated timestamp');
  const oldAnchorPosition = { ...point, event_id: randomUUID(),
    captured_at: at(snap.server_time, 11_000), elapsed_realtime_ms: 12_000,
    client_session_id: openClient };
  check((await device('POST', positionPath, batch([oldAnchorPosition]))).statusCode === 200,
    'historical authorized position reconciles after policy replacement');
  await pool.query("UPDATE gps_event_quarantine SET expires_at=now()-interval '1 second' WHERE event_id=$1",
    [orphanStop.event_id]);
  const expired = await events.purgeExpired();
  const expiredRow = await pool.query('SELECT reason_code,octet_length(payload_ciphertext) AS bytes FROM gps_event_quarantine WHERE event_id=$1',
    [orphanStop.event_id]);
  check(expired.quarantined === 1 && expiredRow.rows[0]?.reason_code === 'dependency_expired' &&
    expiredRow.rows[0].bytes === 0, 'expired dependency erases ciphertext and retains rejection tombstone');
  check((await device('POST', sessionPath, orphanBatch)).statusCode === 410,
    'expired out-of-order event cannot be requeued');
  await pool.query('DELETE FROM gps_event_request_quota WHERE device_id=$1', [deviceId]);
  await pool.query("UPDATE mdm_binding SET state='REVOKED' WHERE id=$1", [bindingId]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-b','synthetic-transfer','ACTIVE')",
    [randomUUID(), deviceId]);
  const transferred = await device('POST', positionPath, batch([{ ...oldAnchorPosition,
    event_id: randomUUID() }]));
  check(transferred.statusCode === 403, 'old tenant installation cannot be attributed to new tenant');
  await pool.query("UPDATE gps_data_tenant_access SET revoked_at=now() WHERE admin_id=$1 AND tenant_id='tenant-a' AND revoked_at IS NULL", [adminId]);
  await pool.query("INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-b',$1,'Synthetic new tenant grant')", [adminId]);
  const newTenantRead = await app.inject({ method: 'GET', url: readPath,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic review' } });
  check(newTenantRead.statusCode === 200 && newTenantRead.json().items.length === 0,
    'new tenant cannot read prior tenant coordinates');
  await pool.query('UPDATE position_event SET captured_at=now()-interval \'91 days\' WHERE event_id=$1',
    [point.event_id]);
  const purged = await events.purgeExpired();
  check(purged.positions === 1 &&
    (await pool.query('SELECT 1 FROM position_event WHERE event_id=$1', [point.event_id])).rowCount === 0,
    '90-day position retention purges old record');
  await pool.query("UPDATE device_key SET status='REVOKED',revoked_at=now() WHERE id=$1", [keyId]);
  check((await device('POST', positionPath, batch([secondPoint]))).statusCode === 403,
    'revoked device rejected before duplicate lookup');
  const wirePath = fileURLToPath(new URL('../../android-agent/build/w1e1/session-position-wire.json', import.meta.url));
  mkdirSync(dirname(wirePath), { recursive: true });
  writeFileSync(wirePath, JSON.stringify({ device_id: deviceId, installation_id: installationId,
    missed_event: missed, start_event: start, position_event: point,
    session_ack: started.json(), position_ack: acceptedPoint.json(),
    pending_response: early.json() }));
  console.log(`gps-events integration PASS: ${checks} assertions`);
} finally {
  await app.close();
  await pool.end();
}
