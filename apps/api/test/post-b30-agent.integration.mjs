// Run after client/route/schedule/evaluation/agent-link fixtures in disposable PostGIS.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { AgentDeviceLinkService } from '../src/agent-device-links.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS required');
const pool = new pg.Pool({ connectionString: url, max: 5 });
const origin = 'https://geops.example.invalid';
let checks = 0;
const check = (value, description) => {
  assert.ok(value, description);
  checks++;
};
let app;
try {
  check(
    (
      await pool.query(
        "SELECT 1 FROM geops_schema_migrations WHERE version='0031_agent_responsibility_geocoding.sql'",
      )
    ).rowCount === 1,
    'additive migration 0031 registered',
  );
  const owner = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
  ).rows[0].id;
  const tenant = 'synthetic';
  const device = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Post-B30 device')",
    [device],
  );
  await pool.query(
    "INSERT INTO geops_device_tenant(device_id,tenant_id,established_by,source) VALUES($1,$2,$3,'GEOPS_ENROLLMENT')",
    [device, tenant, owner],
  );
  await pool.query(
    "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
    [randomUUID(), device, randomBytes(64), randomBytes(32)],
  );
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_tenant_id) VALUES($1,$2,now(),$3)',
    [randomUUID(), device, tenant],
  );
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    agentDeviceLinks: new AgentDeviceLinkService(pool),
    secureCookie: false,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin },
    payload: { email: 'owner@example.invalid', password: 'synthetic-password-12345678' },
  });
  check(login.statusCode === 200, 'authorized admin login');
  const headers = {
    origin,
    cookie: login.headers['set-cookie'].split(';')[0],
    'x-csrf-token': login.json().csrf_token,
  };
  const call = (method, path, payload, key = randomUUID()) =>
    app.inject({
      method,
      url: path,
      headers: { ...headers, 'idempotency-key': key },
      ...(payload === undefined ? {} : { payload }),
    });
  const beforeAssignments = Number(
    (await pool.query('SELECT count(*) FROM route_assignment')).rows[0].count,
  );
  const beforePositions = Number(
    (await pool.query('SELECT count(*) FROM position_event')).rows[0].count,
  );
  const registration = {
    device_id: device,
    code: 'GEOPS_POST_B30',
    name: 'Agente dispositivo',
    person_name: 'Juan Pérez',
    reason: 'Registro de dispositivo corporativo sintético',
  };
  const key = randomUUID();
  const created = await call('POST', '/v1/admin/agent-devices', registration, key);
  check(
    created.statusCode === 201,
    `device-backed agent created: ${created.statusCode} ${created.body}`,
  );
  const agent = created.json();
  check(agent.device_id === device, 'device is stable operational identity');
  check(
    (await call('POST', '/v1/admin/agent-devices', registration, key)).json().id === agent.id,
    'registration retry is idempotent',
  );
  const identity = await call('GET', `/v1/admin/agents/${agent.id}/identity`);
  check(
    identity.statusCode === 200 && identity.json().responsible.person_name === 'Juan Pérez',
    'current responsible appears in agent detail',
  );
  check(identity.json().device.mdm_provider === null, 'GEOPS device without MDM remains usable');
  const change = await call('POST', `/v1/admin/agents/${agent.id}/responsibilities`, {
    person_name: 'María López',
    reason: 'Cambio de responsable de prueba',
  });
  check(change.statusCode === 201, `responsible changed: ${change.statusCode} ${change.body}`);
  const history = await call('GET', `/v1/admin/agents/${agent.id}/responsibilities`);
  check(
    history.statusCode === 200 && history.json().items.length === 2,
    'two historical intervals',
  );
  check(
    history.json().items[0].person_name === 'María López' && history.json().items[1].valid_to,
    'prior person preserved and interval closed',
  );
  check(
    (
      await pool.query(
        'SELECT count(*) FROM agent_responsibility WHERE agent_id=$1 AND valid_to IS NULL',
        [agent.id],
      )
    ).rows[0].count === '1',
    'exactly one current responsible',
  );
  check(
    (await pool.query('SELECT count(*) FROM route_assignment')).rows[0].count ===
      String(beforeAssignments),
    'historical assignments untouched',
  );
  check(
    (await pool.query('SELECT count(*) FROM position_event')).rows[0].count ===
      String(beforePositions),
    'historical GPS evidence untouched',
  );
  const duplicate = await call('POST', '/v1/admin/agent-devices', {
    ...registration,
    code: 'GEOPS_POST_B31',
  });
  check(duplicate.statusCode === 409, 'device cannot become a second operational agent');
  const audit = await pool.query(
    "SELECT count(*) FROM audit_event WHERE actor_id=$1 AND action IN ('visit.agent.device.register','visit.agent.responsibility.change')",
    [owner],
  );
  check(Number(audit.rows[0].count) >= 2, 'registration and responsible change audited');
  console.log(`post-B30 agent integration: ${checks} checks passed`);
} finally {
  await app?.close();
  await pool.end();
}
