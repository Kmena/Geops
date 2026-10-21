// Requires an empty, disposable PostGIS database named geops_verify_<digits>.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { MdmConnectionControl } from '../src/mdm/connection-control.ts';
import { MdmInventoryService } from '../src/mdm/inventory.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { createApp } from '../src/app.ts';
import { ApiError } from '../src/errors.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS database required');

const pool = new pg.Pool({ connectionString: url, max: 8 });
try {
  const applied = await applyMigrations(pool);
  assert.equal(applied.at(-1), '0021_gps_offline_policy_contract.sql');
  assert.deepEqual(await applyMigrations(pool), [], 'migration replay is idempotent');
  const clock = { now: new Date('2026-10-21T12:00:00Z') };
  const settings = {
    sessionKey: Buffer.alloc(32, 71),
    csrfKey: Buffer.alloc(32, 72),
    allowedOrigins: ['https://example.invalid'],
    now: () => clock.now,
  };
  const auth = new AdminAuthService(pool, settings);
  const adminId = await auth.bootstrap(
    'mdm-security@example.invalid',
    'synthetic-password-12345678',
  );
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [adminId, randomUUID()],
  );
  for (const permission of ['gps.installation.manage', 'gps.tenant.grant'])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Synthetic MDM security fixture'],
    );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,$2)`,
      [adminId, 'Synthetic MDM security fixture'],
    );
  const first = new MdmConnectionControl(pool, 'com', '12345', 'synthetic-refresh-A');
  assert.equal(await first.withConnected(async () => 'permitted'), 'permitted');

  let releaseOperation;
  let operationStarted;
  const started = new Promise((resolve) => {
    operationStarted = resolve;
  });
  const operation = first.withConnected(async () => {
    operationStarted();
    await new Promise((resolve) => {
      releaseOperation = resolve;
    });
  });
  await started;
  let remoteCalls = 0;
  const disconnect = first.disconnect(adminId, randomUUID(), async () => {
    remoteCalls++;
    return false;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(remoteCalls, 0, 'disconnect waits for in-flight provider call');
  releaseOperation();
  await operation;
  assert.equal(await disconnect, false);
  assert.equal(remoteCalls, 1);
  const restarted = new MdmConnectionControl(pool, 'com', '12345', 'synthetic-refresh-A');
  await assert.rejects(
    restarted.withConnected(async () => 'bad'),
    { code: 'mdm_disconnected' },
  );
  const state = await pool.query(
    "SELECT state,remote_revoked FROM mdm_connection_control WHERE customer_id='12345'",
  );
  assert.deepEqual(state.rows[0], { state: 'DISCONNECTING', remote_revoked: false });
  assert.equal(await restarted.disconnect(adminId, randomUUID(), async () => true), true);
  assert.equal(
    await restarted.disconnect(adminId, randomUUID(), async () => {
      throw new Error('Duplicate revocation must not call provider');
    }),
    true,
  );
  await assert.rejects(
    restarted.withConnected(async () => 'bad'),
    { code: 'mdm_disconnected' },
  );
  await assert.rejects(
    restarted.reconnect(adminId, randomUUID(), async () => {}),
    {
      code: 'mdm_reconnect_requires_new_grant',
    },
  );
  const rotated = new MdmConnectionControl(pool, 'com', '12345', 'synthetic-refresh-B');
  await assert.rejects(
    rotated.reconnect(adminId, randomUUID(), async () => {
      throw new Error('synthetic grant rejected');
    }),
  );
  await assert.rejects(
    rotated.withConnected(async () => 'bad'),
    { code: 'mdm_disconnected' },
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='gps.tenant.grant'",
    [adminId],
  );
  await assert.rejects(
    rotated.reconnect(adminId, randomUUID(), async () => 'bad'),
    {
      code: 'gps_forbidden',
    },
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=NULL WHERE admin_id=$1 AND permission='gps.tenant.grant'",
    [adminId],
  );
  await pool.query(
    "UPDATE gps_data_tenant_access SET revoked_at=now() WHERE admin_id=$1 AND tenant_id='synthetic'",
    [adminId],
  );
  await assert.rejects(
    rotated.reconnect(adminId, randomUUID(), async () => 'bad'),
    {
      code: 'gps_forbidden',
    },
  );
  await pool.query(
    "UPDATE gps_data_tenant_access SET revoked_at=NULL WHERE admin_id=$1 AND tenant_id='synthetic'",
    [adminId],
  );
  await rotated.reconnect(adminId, randomUUID(), async () => 'synthetic-grant-verified');
  assert.equal(await rotated.withConnected(async () => 'permitted'), 'permitted');
  await assert.rejects(
    first.withConnected(async () => 'bad'),
    { code: 'mdm_disconnected' },
  );
  let releaseRemote;
  let remoteStarted;
  const remoteSignal = new Promise((resolve) => {
    remoteStarted = resolve;
  });
  const pendingDisconnect = rotated.disconnect(adminId, randomUUID(), async () => {
    remoteStarted();
    return new Promise((resolve) => {
      releaseRemote = resolve;
    });
  });
  await remoteSignal;
  assert.deepEqual(
    (
      await pool.query(
        "SELECT state,remote_revoked FROM mdm_connection_control WHERE customer_id='12345'",
      )
    ).rows[0],
    { state: 'DISCONNECTING', remote_revoked: false },
  );
  await assert.rejects(
    rotated.withConnected(async () => 'bad'),
    { code: 'mdm_disconnected' },
  );
  const concurrentRetry = rotated.disconnect(adminId, randomUUID(), async () => false);
  releaseRemote(true);
  assert.equal(await pendingDisconnect, true);
  assert.equal(
    await concurrentRetry,
    true,
    'failed duplicate remote call cannot undo a completed revocation',
  );
  const controlAudit = await pool.query(
    "SELECT action,metadata_redacted FROM audit_event WHERE action LIKE 'mdm.disconnect.%' OR action='mdm.reconnect'",
  );
  assert.ok(controlAudit.rows.some((row) => row.action === 'mdm.disconnect.started'));
  assert.ok(controlAudit.rows.some((row) => row.action === 'mdm.disconnect.remote'));
  assert.ok(controlAudit.rows.some((row) => row.action === 'mdm.reconnect'));
  assert.ok(
    controlAudit.rows.every(
      (row) => !JSON.stringify(row.metadata_redacted).includes('synthetic-refresh'),
    ),
  );

  const routeControl = new MdmConnectionControl(pool, 'com', '12345', 'synthetic-refresh-C');
  let rejectProvider = false;
  const provider = {
    integrationStatus: async () => ({
      provider: 'manageengine',
      connected: false,
      edition_evidence: 'UNVERIFIED',
      last_checked_at: null,
      last_http_status: null,
      sanitized_error_code: null,
    }),
    listDevices: async () => {
      if (rejectProvider) throw new ApiError(503, 'mdm_response_too_large', 'MDM unavailable');
      return { items: [], next_cursor: null, source: 'manageengine' };
    },
    getDevice: async () => null,
  };
  const app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    devices: new DeviceRepository(pool),
    mdm: provider,
    mdmInventory: new MdmInventoryService(
      pool,
      provider,
      { region: 'com', customerId: '12345' },
      undefined,
      routeControl,
    ),
    mdmOAuth: { token: async () => 'synthetic-new-grant', revoke: async () => true },
    mdmControl: routeControl,
  });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin/mdm/reconnect',
        payload: { reason: 'Synthetic authorized reconnection' },
      })
    ).statusCode,
    401,
  );
  const routeSession = await auth.login(
    'mdm-security@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.90',
    randomUUID(),
  );
  const headers = {
    cookie: `geops_admin=${routeSession.token}`,
    origin: 'https://example.invalid',
    'x-csrf-token': routeSession.csrfToken,
  };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin/mdm/reconnect',
        headers: { cookie: headers.cookie, origin: headers.origin },
        payload: { reason: 'Synthetic authorized reconnection' },
      })
    ).statusCode,
    403,
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='gps.tenant.grant'",
    [adminId],
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin/mdm/reconnect',
        headers,
        payload: { reason: 'Synthetic authorized reconnection' },
      })
    ).statusCode,
    403,
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=NULL WHERE admin_id=$1 AND permission='gps.tenant.grant'",
    [adminId],
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin/mdm/reconnect',
        headers,
        payload: { reason: 'Synthetic authorized reconnection' },
      })
    ).statusCode,
    200,
  );
  assert.equal(await routeControl.withConnected(async () => 'allowed'), 'allowed');
  const reconnectAudit = await pool.query(
    "SELECT metadata_redacted FROM audit_event WHERE action='mdm.reconnect' ORDER BY occurred_at DESC LIMIT 1",
  );
  assert.ok(reconnectAudit.rows[0].metadata_redacted.reason_sha256);
  assert.ok(
    !JSON.stringify(reconnectAudit.rows[0].metadata_redacted).includes(
      'Synthetic authorized reconnection',
    ),
  );
  rejectProvider = true;
  assert.equal(
    (await app.inject({ method: 'GET', url: '/v1/admin/mdm/devices', headers })).statusCode,
    503,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='mdm.provider.read' AND metadata_redacted->>'code'='mdm_response_too_large'",
      )
    ).rows[0].n,
    1,
  );
  await app.close();

  for (let attempt = 0; attempt < 5; attempt++)
    await assert.rejects(
      auth.login('mdm-security@example.invalid', 'wrong', '192.0.2.10', randomUUID()),
      {
        code: 'invalid_credentials',
      },
    );
  const restartedAuth = new AdminAuthService(pool, settings);
  await assert.rejects(
    restartedAuth.login(
      'mdm-security@example.invalid',
      'synthetic-password-12345678',
      '192.0.2.11',
      randomUUID(),
    ),
    { code: 'rate_limited' },
  );
  await assert.rejects(
    restartedAuth.login('other@example.invalid', 'wrong', '192.0.2.10', randomUUID()),
    { code: 'rate_limited' },
  );
  clock.now = new Date('2026-10-21T12:16:00Z');
  assert.equal(
    (
      await restartedAuth.login(
        'mdm-security@example.invalid',
        'synthetic-password-12345678',
        '192.0.2.11',
        randomUUID(),
      )
    ).id,
    adminId,
  );
  const limits = await pool.query('SELECT attempts,blocked_until FROM admin_login_limit');
  assert.ok(limits.rows.every((row) => row.attempts >= 0));
  const loginAudit = await pool.query(
    "SELECT metadata_redacted FROM audit_event WHERE action LIKE 'admin.login%'",
  );
  assert.ok(
    loginAudit.rows.every(
      (row) => !JSON.stringify(row.metadata_redacted).includes('mdm-security@example.invalid'),
    ),
  );
  clock.now = new Date('2026-10-21T13:00:00Z');
  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      new AdminAuthService(pool, settings).login(
        'mdm-security@example.invalid',
        'wrong',
        '192.0.2.20',
        randomUUID(),
      ),
    ),
  );
  assert.equal(
    attempts.filter(
      (entry) => entry.status === 'rejected' && entry.reason.code === 'invalid_credentials',
    ).length,
    5,
  );
  assert.equal(
    attempts.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'rate_limited')
      .length,
    5,
  );
  await assert.rejects(
    auth.login(
      'mdm-security@example.invalid',
      'synthetic-password-12345678',
      '192.0.2.21',
      randomUUID(),
    ),
    { code: 'rate_limited' },
  );
  clock.now = new Date('2026-10-21T13:16:00Z');
  assert.equal(
    (
      await auth.login(
        'mdm-security@example.invalid',
        'synthetic-password-12345678',
        '192.0.2.21',
        randomUUID(),
      )
    ).id,
    adminId,
  );
  console.log('MDM disconnect persistence, replay, rotation and login rate limit: PASS');
} finally {
  await pool.end();
}
