// Runs only in a disposable GEOPS API image on the rehearsal's private network.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { requestProofBytes } from '@geops/api-contracts';
import { AdminAuthService } from '../../apps/api/dist/admin-auth/service.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseName = new URL(databaseUrl ?? '').pathname.slice(1);
assert.match(databaseName, /^geops_verify_[0-9]+_restore$/);
assert.equal(process.env.GEOPS_DATA_MODE, 'synthetic');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const origin = 'http://localhost:3501';
const web = 'http://geops-web:8080';
const sha = (value) => createHash('sha256').update(value).digest();
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const at = (value, offset) => new Date(Date.parse(value) + offset).toISOString();
const clock = (offset) => iso(offset * 60_000).slice(11, 16);

async function readInput() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value ? JSON.parse(value) : {};
}

async function jsonRequest(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${web}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3000),
  });
  const payload = await response.json();
  return { status: response.status, payload, headers: response.headers };
}

async function device(state, method, path, body) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  const bytes = requestProofBytes({
    method,
    absolutePath: path,
    bodySha256: sha(serialized).toString('base64url'),
    tokenSha256: sha(state.token).toString('base64url'),
    timestamp,
    nonce,
    keyId: state.keyId,
  });
  return jsonRequest(path, method, body, {
    authorization: `Bearer ${state.token}`,
    'x-geops-key-id': state.keyId,
    'x-geops-timestamp': timestamp,
    'x-geops-nonce': nonce,
    'x-geops-signature': sign('sha256', bytes, state.privateKey).toString('base64url'),
  });
}

async function setup() {
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.from(process.env.GEOPS_ADMIN_SESSION_KEY, 'base64url'),
    csrfKey: Buffer.from(process.env.GEOPS_ADMIN_CSRF_KEY, 'base64url'),
    allowedOrigins: [origin],
  });
  const email = `deploy-p0-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const adminId = await auth.bootstrap(email, password);
  for (const permission of [
    'gps.policy.read',
    'gps.policy.write',
    'gps.policy.assign',
    'gps.policy.activate',
  ]) {
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Isolated deploy rehearsal'],
    );
  }
  const login = await jsonRequest(
    '/v1/admin/auth/sessions',
    'POST',
    { email, password },
    { origin },
  );
  assert.equal(login.status, 200, 'admin login');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const csrf = login.payload.csrf_token;
  assert.ok(cookie && csrf);
  const admin = (method, path, payload, etag) =>
    jsonRequest(path, method, payload, {
      cookie,
      origin,
      'x-csrf-token': csrf,
      'idempotency-key': randomUUID(),
      ...(etag ? { 'if-match': etag } : {}),
    });

  const deviceId = randomUUID();
  const keyId = randomUUID();
  const bindingId = randomUUID();
  const installationId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','deploy p0 synthetic')",
    [deviceId],
  );
  await pool.query(
    "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-p0','deploy-p0','ACTIVE')",
    [bindingId, deviceId],
  );
  await pool.query(
    "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
    [keyId, deviceId, spki, sha(spki)],
  );
  await pool.query(
    'INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), deviceId, keyId, sha(token), iso(-60_000), iso(900_000)],
  );
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,$5)',
    [installationId, deviceId, iso(-60_000), bindingId, 'tenant-p0'],
  );
  const policy = {
    name: 'Deploy P0 synthetic',
    days_iso: [1, 2, 3, 4, 5, 6, 7],
    start_local: clock(-60),
    end_local: clock(60),
    time_zone: 'UTC',
    capture_interval_s: 60,
    sync_interval_s: 300,
    health_interval_s: 300,
    heartbeat_missing_after_s: 900,
    valid_from: iso(-86_400_000),
    valid_until: iso(7 * 86_400_000),
  };
  const created = await admin('POST', '/v1/admin/gps-policies', policy);
  assert.equal(created.status, 201, 'policy creation');
  const policyId = created.payload.id;
  const assigned = await admin(
    'PUT',
    `/v1/admin/gps-policies/${policyId}/assignments`,
    {
      assignments: [
        {
          scope_type: 'DEVICE',
          scope_id: deviceId,
          valid_from: iso(-3_600_000),
          valid_until: iso(7 * 86_400_000),
        },
      ],
    },
    created.headers.get('etag'),
  );
  assert.equal(assigned.status, 200, 'policy assignment');
  const published = await admin(
    'POST',
    `/v1/admin/gps-policies/${policyId}/publish`,
    { reason: 'Isolated deploy rehearsal' },
    assigned.headers.get('etag'),
  );
  assert.equal(published.status, 200, 'policy publication');
  const state = {
    deviceId,
    keyId,
    installationId,
    token,
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
  const config = await device(state, 'GET', '/v1/device/config');
  assert.equal(config.status, 200, 'device config');
  const snapshot = config.payload;
  const scheduled = snapshot.window_instances.find(
    (window) =>
      Date.parse(window.start_at) <= Date.parse(snapshot.server_time) &&
      Date.parse(snapshot.server_time) < Date.parse(window.end_at),
  );
  assert.ok(scheduled, 'active GPS window');
  const clientId = randomUUID();
  const bootId = randomUUID();
  const started = await device(state, 'POST', '/v1/device/gps-session-events/batches', {
    schema_version: 1,
    batch_id: randomUUID(),
    device_id: deviceId,
    installation_id: installationId,
    events: [
      {
        event_id: randomUUID(),
        client_session_id: clientId,
        scheduled_session_id: scheduled.scheduled_session_id,
        type: 'STARTED',
        occurred_at: at(snapshot.server_time, 1000),
        assignment_version: snapshot.assignment_version,
        boot_id: bootId,
        capture_anchor_id: snapshot.capture_anchor_id,
        anchor_elapsed_realtime_ms: 1000,
        elapsed_realtime_ms: 2000,
        reason_code: null,
      },
    ],
  });
  assert.equal(started.status, 200, 'session start ACK');
  state.events = [2, 4, 6].map((second) => ({
    schema_version: 1,
    batch_id: randomUUID(),
    device_id: deviceId,
    installation_id: installationId,
    events: [
      {
        event_id: randomUUID(),
        client_session_id: clientId,
        assignment_version: snapshot.assignment_version,
        captured_at: at(snapshot.server_time, second * 1000),
        latitude: 14.61,
        longitude: -90.52,
        accuracy_m: 8.5,
        boot_id: bootId,
        anchor_elapsed_realtime_ms: 1000,
        elapsed_realtime_ms: (second + 1) * 1000,
        capture_anchor_id: snapshot.capture_anchor_id,
      },
    ],
  }));
  return state;
}

async function send(input) {
  const batch = input.state.events[input.index];
  assert.ok(batch && Number.isInteger(input.index));
  try {
    const response = await device(input.state, 'POST', '/v1/device/locations/batches', batch);
    return {
      status: response.status,
      ack:
        response.status === 200 &&
        [...response.payload.accepted_event_ids, ...response.payload.duplicate_event_ids].includes(
          batch.events[0].event_id,
        ),
      persistedAt: response.payload.persisted_at ?? null,
      eventId: batch.events[0].event_id,
    };
  } catch {
    return {
      status: 'transport_error',
      ack: false,
      persistedAt: null,
      eventId: batch.events[0].event_id,
    };
  }
}

async function verify(state, expected = 3) {
  assert.ok(Number.isInteger(expected) && expected >= 1 && expected <= 3);
  const eventIds = state.events.slice(0, expected).map((batch) => batch.events[0].event_id);
  const batchIds = state.events.slice(0, expected).map((batch) => batch.batch_id);
  const positions = await pool.query(
    'SELECT event_id::text, count(*)::int AS n FROM position_event WHERE event_id=ANY($1::uuid[]) GROUP BY event_id',
    [eventIds],
  );
  const receipts = await pool.query(
    "SELECT batch_id::text, count(*)::int AS n FROM gps_event_batch_receipt WHERE kind='POSITION' AND batch_id=ANY($1::uuid[]) GROUP BY batch_id",
    [batchIds],
  );
  const uniquePositions =
    positions.rows.length === expected && positions.rows.every((row) => row.n === 1);
  const uniqueReceipts =
    receipts.rows.length === expected && receipts.rows.every((row) => row.n === 1);
  return {
    pass: uniquePositions && uniqueReceipts,
    positions: positions.rows.length,
    receipts: receipts.rows.length,
    eventIds,
    batchIds,
  };
}

const mode = process.argv[2];
try {
  const input = await readInput();
  const result =
    mode === 'setup'
      ? await setup()
      : mode === 'send'
        ? await send(input)
        : mode === 'verify'
          ? await verify(input.state, input.expected)
          : null;
  assert.ok(result, 'mode must be setup, send or verify');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (mode === 'verify' && !result.pass) process.exitCode = 1;
} finally {
  await pool.end();
}
