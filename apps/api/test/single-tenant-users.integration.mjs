// Synthetic authorization flow. Run only against a disposable geops_verify_* PostGIS database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import { GpsCapabilityBootstrapService } from '../src/admin-auth/gps-capability-bootstrap.ts';
import { AdminUserAdministrationService } from '../src/admin-auth/user-administration.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsAdministrationService } from '../src/gps-administration.ts';
import { FakeMdmProvider } from '../src/mdm/provider.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 12 });
const origin = 'https://geops.example.invalid';
const password = 'synthetic-password-12345678';
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
const status = (response, expected, label) =>
  check(response.statusCode === expected, `${label}: ${response.statusCode}`);

try {
  check(
    (await pool.query('SELECT current_database() AS name')).rows[0].name ===
      new URL(url).pathname.slice(1),
    'disposable database',
  );
  await pool.query('TRUNCATE admin_user, recovery_custodian, geops_device, audit_event CASCADE');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 71),
    csrfKey: Buffer.alloc(32, 72),
    allowedOrigins: [origin],
  });
  const primaryId = await auth.bootstrap('owner@example.invalid', password);
  const recovery = new SupervisedRecoveryService(pool, Buffer.alloc(32, 73));
  for (const email of ['custodian-a@example.invalid', 'custodian-b@example.invalid'])
    await recovery.registerSyntheticCustodian(email, password);
  const ceremony = new GpsCapabilityBootstrapService(pool, async () => true);
  const input = () => ({
    requestId: randomUUID(),
    adminEmail: 'owner@example.invalid',
    adminPassword: password,
    custodians: [
      { email: 'custodian-a@example.invalid', password },
      { email: 'custodian-b@example.invalid', password },
    ],
    reason: 'Approved one-company synthetic administration',
  });
  await ceremony.grantInitial(input());
  const establish = input();
  await ceremony.establishTenant(establish);
  check(
    (await pool.query('SELECT tenant_id FROM geops_operating_tenant')).rows[0].tenant_id ===
      'synthetic',
    'one tenant established',
  );
  await assert.rejects(ceremony.establishTenant(establish), (error) => error.statusCode === 403);
  checks++;

  const policies = new GpsPolicyService(pool);
  const app = createApp({
    readinessProbe: async () => true,
    restoreGate: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    adminUsers: new AdminUserAdministrationService(pool),
    gpsPolicies: policies,
    gpsAdministration: new GpsAdministrationService(pool, policies),
    devices: new DeviceRepository(pool),
    mdm: new FakeMdmProvider(),
    secureCookie: false,
  });
  const login = async (email, secret) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email, password: secret },
    });
    status(response, 200, 'login');
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      csrf: response.json().csrf_token,
    };
  };
  const primary = await login('owner@example.invalid', password);
  const call = (session, method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: path,
      headers: { cookie: session.cookie, origin, 'x-csrf-token': session.csrf, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  const primaryRights = await call(primary, 'GET', '/v1/admin/gps-capabilities');
  status(primaryRights, 200, 'primary rights');
  check(
    primaryRights.json().capabilities.includes('gps.user.manage') &&
      primaryRights.json().tenant_ids[0] === 'synthetic',
    'manager and tenant explicit',
  );

  const created = await call(primary, 'POST', '/v1/admin/users', {
    email: 'operator@example.invalid',
    reason: 'Approved synthetic operator identity',
  });
  status(created, 201, 'user invitation created');
  const {
    admin_id: operatorId,
    invitation_id: invitationId,
    invitation_token: token,
  } = created.json();
  check(
    (await call(primary, 'GET', '/v1/admin/users'))
      .json()
      .users.some((user) => user.id === operatorId && user.state === 'LOCKED'),
    'locked user listed',
  );
  status(
    await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email: 'operator@example.invalid', password },
    }),
    401,
    'locked user cannot login',
  );
  status(
    await app.inject({
      method: 'POST',
      url: '/v1/admin/users/invitations/accept',
      headers: { origin: 'https://wrong.example.invalid' },
      payload: { invitation_id: invitationId, invitation_token: token, password },
    }),
    403,
    'wrong origin denied',
  );
  status(
    await app.inject({
      method: 'POST',
      url: '/v1/admin/users/invitations/accept',
      headers: { origin },
      payload: { invitation_id: invitationId, invitation_token: 'A'.repeat(43), password },
    }),
    403,
    'wrong invitation token denied',
  );
  const reissued = await call(primary, 'POST', `/v1/admin/users/${operatorId}/invitations`, {
    reason: 'Replace first synthetic invitation',
  });
  status(reissued, 201, 'locked invitation reissued');
  status(
    await app.inject({
      method: 'POST',
      url: '/v1/admin/users/invitations/accept',
      headers: { origin },
      payload: { invitation_id: invitationId, invitation_token: token, password },
    }),
    403,
    'superseded invitation denied',
  );
  const activeInvitation = reissued.json();
  status(
    await app.inject({
      method: 'POST',
      url: '/v1/admin/users/invitations/accept',
      headers: { origin },
      payload: {
        invitation_id: activeInvitation.invitation_id,
        invitation_token: activeInvitation.invitation_token,
        password,
      },
    }),
    204,
    'invitation accepted once',
  );
  status(
    await app.inject({
      method: 'POST',
      url: '/v1/admin/users/invitations/accept',
      headers: { origin },
      payload: {
        invitation_id: activeInvitation.invitation_id,
        invitation_token: activeInvitation.invitation_token,
        password,
      },
    }),
    403,
    'invitation replay denied',
  );
  const operator = await login('operator@example.invalid', password);
  status(await call(operator, 'GET', '/v1/admin/users'), 403, 'non-manager cannot list users');
  status(await call(operator, 'GET', '/v1/admin/gps-policies'), 403, 'default denied policy read');
  status(
    await call(operator, 'POST', `/v1/admin/users/${primaryId}/tenant-access`, {
      request_id: randomUUID(),
      action: 'REVOKE',
      reason: 'Unauthorized tenant change',
    }),
    403,
    'non-manager cannot revoke tenant',
  );

  const requestId = randomUUID();
  const grant = {
    request_id: requestId,
    action: 'GRANT',
    capabilities: ['gps.policy.read', 'gps.policy.write', 'gps.location.read', 'gps.session.read'],
    reason: 'Approved operator GPS capabilities',
  };
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, grant),
    204,
    'multiple capabilities granted atomically',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, grant),
    204,
    'exact replay idempotent',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, {
      ...grant,
      capabilities: ['gps.audit.read'],
    }),
    409,
    'conflicting replay denied',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, {
      ...grant,
      request_id: randomUUID(),
      capabilities: ['gps.user.manage'],
    }),
    422,
    'manager capability cannot be delegated',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${primaryId}/capabilities`, {
      ...grant,
      request_id: randomUUID(),
    }),
    422,
    'self change denied',
  );
  const operatorRights = await call(operator, 'GET', '/v1/admin/gps-capabilities');
  check(
    operatorRights.json().capabilities.length === 4 &&
      operatorRights.json().tenant_ids.length === 0,
    'capabilities distinct from tenant access',
  );
  status(await call(operator, 'GET', '/v1/admin/gps-policies'), 200, 'authorized policy read');
  const synthetic = await call(primary, 'POST', '/v1/admin/devices', {
    display_label: 'Synthetic tenant device',
  });
  status(synthetic, 201, 'synthetic device draft');
  const other = await call(primary, 'POST', '/v1/admin/devices', {
    display_label: 'Foreign tenant fixture',
  });
  status(other, 201, 'foreign fixture draft');
  await pool.query("UPDATE geops_device SET status='ACTIVE' WHERE id=ANY($1::uuid[])", [
    [synthetic.json().id, other.json().id],
  ]);
  await pool.query("UPDATE mdm_binding SET state='ACTIVE' WHERE id=$1", [
    synthetic.json().mdm_binding_id,
  ]);
  await pool.query(
    "UPDATE mdm_binding SET state='ACTIVE',customer_id='foreign-fixture' WHERE id=$1",
    [other.json().mdm_binding_id],
  );
  check(
    (await call(operator, 'GET', '/v1/admin/gps-devices')).json().items.length === 0,
    'no device data before tenant grant',
  );
  status(
    await call(primary, 'POST', '/v1/admin/gps-tenant-grants/proposals', {
      request_id: randomUUID(),
      target_admin_id: operatorId,
      tenant_id: 'foreign-fixture',
      action: 'GRANT',
      reason: 'Unauthorized foreign tenant attempt',
    }),
    403,
    'legacy grant route cannot escape established company',
  );

  const concurrent = await Promise.all([
    call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, {
      ...grant,
      request_id: randomUUID(),
      capabilities: ['gps.audit.read'],
    }),
    call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, {
      ...grant,
      request_id: randomUUID(),
      capabilities: ['gps.audit.read'],
    }),
  ]);
  check(
    concurrent
      .map((response) => response.statusCode)
      .sort()
      .join(',') === '204,409',
    'concurrent duplicate grant has one winner',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/tenant-access`, {
      request_id: randomUUID(),
      action: 'GRANT',
      reason: 'Approved synthetic company access',
    }),
    204,
    'tenant grant without second administrator',
  );
  check(
    (await call(operator, 'GET', '/v1/admin/gps-capabilities')).json().tenant_ids[0] ===
      'synthetic',
    'tenant access visible',
  );
  const scopedDevices = await call(operator, 'GET', '/v1/admin/gps-devices');
  check(
    scopedDevices.json().items.length === 1 &&
      scopedDevices.json().items[0].tenant_id === 'synthetic',
    'foreign tenant excluded',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/tenant-access`, {
      request_id: randomUUID(),
      action: 'REVOKE',
      reason: 'End synthetic company access',
    }),
    204,
    'tenant revoked',
  );
  check(
    (await call(operator, 'GET', '/v1/admin/gps-capabilities')).json().tenant_ids.length === 0,
    'tenant revoke effective next request',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/capabilities`, {
      request_id: randomUUID(),
      action: 'REVOKE',
      capabilities: ['gps.policy.read', 'gps.location.read'],
      reason: 'Reduce operator GPS access',
    }),
    204,
    'selected capabilities revoked',
  );
  status(await call(operator, 'GET', '/v1/admin/gps-policies'), 403, 'revoked policy read denied');
  check(
    (await call(operator, 'GET', '/v1/admin/gps-capabilities'))
      .json()
      .capabilities.includes('gps.policy.write'),
    'other capability remains',
  );
  status(
    await call(primary, 'POST', `/v1/admin/users/${operatorId}/revoke`, {
      request_id: randomUUID(),
      reason: 'End operator synthetic access',
    }),
    204,
    'user revoked',
  );
  status(await call(operator, 'GET', '/v1/admin/gps-capabilities'), 401, 'revoked session invalid');
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'admin.access.%' AND outcome='success'",
      )
    ).rows[0].n >= 5,
    'sensitive changes audited',
  );
  await app.close();
  console.log(`Single-tenant user administration integration: ${checks} checks PASS`);
} finally {
  await pool.end();
}
