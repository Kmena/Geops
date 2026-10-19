// Only the explicitly named disposable geops_verify_* database may be used.
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
import { GpsHealthService } from '../src/gps-health-service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';

const url = process.env.DATABASE_URL;
if (!url || !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic')
  throw new Error('Disposable geops_verify_* database and synthetic mode required');
const pool = new pg.Pool({ connectionString: url, max: 10 });
assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,
  /^geops_verify_[0-9]+(?:_restore)?$/);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
const auth = new AdminAuthService(pool, { sessionKey: Buffer.alloc(32, 11),
  csrfKey: Buffer.alloc(32, 12), allowedOrigins: ['https://geops.example.invalid'] });
const sessions = new DeviceSessionService(pool);
const policies = new GpsPolicyService(pool);
const config = new GpsDeviceConfigService(pool);
const health = new GpsHealthService(pool, policies);
const app = createApp({ readinessProbe: async () => true, logLevel: 'silent', adminAuth: auth,
  deviceSessions: sessions, gpsPolicies: policies, gpsDeviceConfig: config, gpsHealth: health,
  secureCookie: false });
const sha = (value) => createHash('sha256').update(value).digest();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const clock = (offsetMinutes) => iso(offsetMinutes * 60_000).slice(11, 16);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

try {
  const adminId = await auth.bootstrap('config@example.invalid', 'synthetic-password-12345678');
  for (const permission of ['gps.policy.read', 'gps.policy.write', 'gps.policy.assign',
    'gps.policy.activate', 'gps.session.read'])
    await pool.query('INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Synthetic config test']);
  const login = await app.inject({ method: 'POST', url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'config@example.invalid', password: 'synthetic-password-12345678' } });
  check(login.statusCode === 200, 'admin authenticated');
  const cookie = login.headers['set-cookie'].split(';')[0];
  const csrf = login.json().csrf_token;
  const admin = async (method, path, payload, etag) => app.inject({ method, url: path,
    headers: { cookie, origin: 'https://geops.example.invalid', 'x-csrf-token': csrf,
      'idempotency-key': randomUUID(), ...(etag ? { 'if-match': etag } : {}) },
    payload });
  const deviceId = randomUUID(), keyId = randomUUID(), bindingId = randomUUID();
  const installationId = randomUUID(), token = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','synthetic config device')", [deviceId]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-a','synthetic-config-1','ACTIVE')", [bindingId, deviceId]);
  await pool.query("INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')", [keyId, deviceId, spki, sha(spki)]);
  await pool.query('INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), deviceId, keyId, sha(token), iso(-60_000), iso(600_000)]);
  const policy = { name: 'Published name', days_iso: [1, 2, 3, 4, 5, 6, 7],
    start_local: clock(-60), end_local: clock(60), time_zone: 'UTC',
    capture_interval_s: 60, sync_interval_s: 300, health_interval_s: 300,
    heartbeat_missing_after_s: 900, valid_from: iso(-86_400_000), valid_until: iso(7 * 86_400_000) };
  const created = await admin('POST', '/v1/admin/gps-policies', policy);
  check(created.statusCode === 201, 'policy created');
  const policyId = created.json().id;
  const assigned = await admin('PUT', `/v1/admin/gps-policies/${policyId}/assignments`,
    { assignments: [{ scope_type: 'DEVICE', scope_id: deviceId,
      valid_from: iso(-3_600_000), valid_until: iso(7 * 86_400_000) }] }, created.headers.etag);
  check(assigned.statusCode === 200, 'policy assigned');
  const published = await admin('POST', `/v1/admin/gps-policies/${policyId}/publish`,
    { reason: 'Synthetic config approval' }, assigned.headers.etag);
  check(published.statusCode === 200, 'policy published and windows materialized');
  const count = await pool.query('SELECT count(*)::int AS n FROM gps_scheduled_session WHERE device_id=$1', [deviceId]);
  check(count.rows[0].n > 0, 'UTC windows persisted');
  async function getConfig(nonce = randomBytes(16).toString('base64url'), path = '/v1/device/config') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bytes = requestProofBytes({ method: 'GET', absolutePath: path,
      bodySha256: sha('').toString('base64url'), tokenSha256: sha(token).toString('base64url'),
      timestamp, nonce, keyId });
    return app.inject({ method: 'GET', url: path,
      headers: { authorization: `Bearer ${token}`, 'x-geops-key-id': keyId,
        'x-geops-timestamp': timestamp, 'x-geops-nonce': nonce,
        'x-geops-signature': sign('sha256', bytes, pair.privateKey).toString('base64url') } });
  }
  check((await app.inject({ method: 'GET', url: '/v1/device/config' })).statusCode === 401,
    'anonymous device denied');
  check((await getConfig()).statusCode === 403, 'config does not auto-provision installation');
  await pool.query('INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,$5)',
    [installationId, deviceId, iso(-60_000), bindingId, 'tenant-a']);
  const delivered = await getConfig();
  if (delivered.statusCode !== 200) console.error('config status', delivered.statusCode, delivered.payload);
  check(delivered.statusCode === 200 && delivered.headers['cache-control'] === 'no-store',
    'PoP config delivered uncached');
  const snap = delivered.json();
  const interopPath = new URL('../../android-agent/build/w1e1/config-snapshot.json', import.meta.url);
  mkdirSync(dirname(fileURLToPath(interopPath)), { recursive: true });
  writeFileSync(fileURLToPath(interopPath), delivered.payload);
  check(snap.active && snap.device_id === deviceId && snap.installation_id === installationId &&
    snap.policy_id === policyId && snap.policy_revision === 1 && snap.policy.health_interval_s === 300,
  'canonical identity and policy revision');
  check(snap.window_instances.length > 0 && snap.window_instances.every((w) =>
    Date.parse(w.start_at) < Date.parse(w.end_at)), 'UTC windows in snapshot');
  check(Date.parse(snap.offline_not_after) <= Date.parse(snap.window_instances[0].end_at) &&
    Date.parse(snap.offline_not_after) <= Date.parse(snap.server_time) + 12 * 3_600_000,
  'offline authorization does not extend next window');
  const anchor = await pool.query('SELECT health_mdm_binding_id,health_tenant_id FROM gps_policy_delivery WHERE capture_anchor_id=$1',
    [snap.capture_anchor_id]);
  check(anchor.rows[0].health_mdm_binding_id === bindingId && anchor.rows[0].health_tenant_id === 'tenant-a',
    'delivery anchor bound to tenant');
  const observedAt = new Date(Date.parse(snap.server_time) + 1000).toISOString();
  const healthEvent = { event_id: randomUUID(), device_id: deviceId, installation_id: installationId,
    assignment_version: snap.assignment_version, policy_revision: snap.policy_revision,
    due_at: snap.server_time, observed_at: observedAt, boot_id: randomUUID(),
    capture_anchor_id: snap.capture_anchor_id, anchor_elapsed_realtime_ms: 1000,
    elapsed_realtime_ms: 2000, battery_percent: 67, charging: false, plugged: false,
    power_save: false, provider_available: true, network_available: true,
    tracking_state: 'RUNNING', observed_states: ['ONLINE'] };
  const healthBatch = { schema_version: 1, batch_id: randomUUID(), device_id: deviceId,
    installation_id: installationId, events: [healthEvent] };
  async function postHealth(payload) {
    const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('base64url');
    const bytes = requestProofBytes({ method: 'POST', absolutePath: '/v1/device/health/batches',
      bodySha256: sha(body).toString('base64url'), tokenSha256: sha(token).toString('base64url'),
      timestamp, nonce, keyId });
    return app.inject({ method: 'POST', url: '/v1/device/health/batches', payload: body,
      headers: { authorization: `Bearer ${token}`, 'x-geops-key-id': keyId,
        'x-geops-timestamp': timestamp, 'x-geops-nonce': nonce,
        'x-geops-signature': sign('sha256', bytes, pair.privateKey).toString('base64url'),
        'content-type': 'application/json' } });
  }
  const healthAck = await postHealth(healthBatch);
  if (healthAck.statusCode !== 200) console.error('config health', healthAck.statusCode, healthAck.payload);
  check(healthAck.statusCode === 200 && healthAck.json().accepted_event_ids[0] === healthEvent.event_id,
    'actual config anchor supports authenticated persisted health ACK');
  check((await pool.query('SELECT count(*)::int AS n FROM gps_device_health_event WHERE capture_anchor_id=$1',
    [snap.capture_anchor_id])).rows[0].n === 1, 'health persisted under delivered anchor');
  const deniedHealth = await app.inject({ method: 'GET', url: `/v1/admin/devices/${deviceId}/health`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic integration read' } });
  check(deniedHealth.statusCode === 404, 'tenant grant required for Web read');
  await pool.query("INSERT INTO gps_health_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,'Synthetic integration grant')", [adminId]);
  const visibleHealth = await app.inject({ method: 'GET', url: `/v1/admin/devices/${deviceId}/health`,
    headers: { cookie, 'x-geops-access-reason': 'Synthetic integration read' } });
  check(visibleHealth.statusCode === 200 && visibleHealth.json().latest.event_id === healthEvent.event_id,
    'tenant-scoped administrative latest health from delivered config');
  const nonce = randomBytes(16).toString('base64url');
  check((await getConfig(nonce)).statusCode === 200, 'new nonce accepted');
  check((await getConfig(nonce)).statusCode === 409, 'nonce replay rejected');
  check((await app.inject({ method: 'GET', url: '/v1/device/config?x=1' })).statusCode === 400,
    'query forbidden before proof');
  const edited = await admin('PATCH', `/v1/admin/gps-policies/${policyId}`,
    { name: 'Unpublished draft name' }, published.headers.etag);
  check(edited.statusCode === 200, 'new draft name saved');
  const stable = await getConfig();
  check(stable.json().policy.name === 'Published name', 'published name immutable in snapshot');
  const paused = await admin('POST', `/v1/admin/gps-policies/${policyId}/pause`,
    { reason: 'Synthetic pause test' }, edited.headers.etag);
  check(paused.statusCode === 200, 'policy paused');
  const tombstone = await getConfig();
  check(tombstone.statusCode === 200 && tombstone.json().active === false &&
    tombstone.json().assignment_version > snap.assignment_version &&
    tombstone.json().window_instances.length === 0, 'tombstone advances version');
  await pool.query("UPDATE device_key SET status='REVOKED' WHERE id=$1", [keyId]);
  check((await getConfig()).statusCode === 403, 'revoked key rejects later config');
  console.log(`gps-config integration: ${checks} assertions passed`);
} finally {
  await app.close();
  await pool.end();
}
