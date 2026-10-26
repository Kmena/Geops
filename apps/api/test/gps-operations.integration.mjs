// Destructive fixtures only in an explicitly named disposable geops_verify_* database.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { requestProofBytes } from '@geops/api-contracts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceSessionService } from '../src/device-identity/session.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { FakeMdmProvider } from '../src/mdm/provider.ts';
import { GpsAdministrationService } from '../src/gps-administration.ts';
import { GpsDeviceConfigService } from '../src/gps-device-config.ts';
import { GpsEventService } from '../src/gps-event-service.ts';
import { GpsHealthService } from '../src/gps-health-service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsScheduler } from '../src/gps-scheduler.ts';
import { GpsRemote } from '../../web/src/gps/remote.ts';
import { deviceNames } from '../../web/src/gps/tracking-model.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable DB required');
const pool = new pg.Pool({ connectionString: url, max: 12 });
assert.match(
  (await pool.query('SELECT current_database() AS name')).rows[0].name,
  /^geops_verify_[0-9]+(?:_restore)?$/,
);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
const auth = new AdminAuthService(pool, {
  sessionKey: Buffer.alloc(32, 41),
  csrfKey: Buffer.alloc(32, 42),
  allowedOrigins: ['https://geops.example.invalid'],
});
const policies = new GpsPolicyService(pool);
const sessions = new DeviceSessionService(pool);
const events = new GpsEventService(pool, policies, Buffer.alloc(32, 43));
const health = new GpsHealthService(pool, policies);
const config = new GpsDeviceConfigService(pool);
const operations = new GpsAdministrationService(pool, policies);
const app = createApp({
  readinessProbe: async () => true,
  logLevel: 'silent',
  adminAuth: auth,
  devices: new DeviceRepository(pool),
  mdm: new FakeMdmProvider(),
  deviceSessions: sessions,
  gpsPolicies: policies,
  gpsEvents: events,
  gpsHealth: health,
  gpsDeviceConfig: config,
  gpsAdministration: operations,
  secureCookie: false,
});
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
const hash = (value) => createHash('sha256').update(value).digest();
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const DAY = 86_400_000;
const clock = (minutes) => iso(minutes * 60_000).slice(11, 16);

try {
  const adminId = await auth.bootstrap('operator@example.invalid', 'synthetic-password-12345678');
  const secondId = randomUUID();
  await pool.query(
    "INSERT INTO admin_user(id,email_normalized,password_hash,state) SELECT $1,'approver@example.invalid',password_hash,'ACTIVE' FROM admin_user WHERE id=$2",
    [secondId, adminId],
  );
  const unprivilegedId = randomUUID();
  await pool.query(
    "INSERT INTO admin_user(id,email_normalized,password_hash,state) SELECT $1,'no-gps@example.invalid',password_hash,'ACTIVE' FROM admin_user WHERE id=$2",
    [unprivilegedId, adminId],
  );
  for (const permission of [
    'gps.policy.read',
    'gps.policy.write',
    'gps.policy.assign',
    'gps.policy.activate',
    'gps.session.read',
    'gps.location.read',
    'gps.installation.manage',
    'gps.tenant.grant',
  ])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Synthetic operations integration'],
    );
  await pool.query(
    'INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES($1,$2,$3)',
    ['synthetic', adminId, randomUUID()],
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,$2)`,
      [adminId, 'Synthetic installation test access'],
    );
  await pool.query(
    'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
    [secondId, 'gps.tenant.grant', 'Synthetic second approver'],
  );
  async function login(email) {
    const result = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin: 'https://geops.example.invalid' },
      payload: { email, password: 'synthetic-password-12345678' },
    });
    check(result.statusCode === 200, 'admin authenticated');
    return { cookie: result.headers['set-cookie'].split(';')[0], csrf: result.json().csrf_token };
  }
  const operator = await login('operator@example.invalid');
  const approver = await login('approver@example.invalid');
  const unprivileged = await login('no-gps@example.invalid');
  const admin = (session, method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: path,
      headers: {
        cookie: session.cookie,
        origin: 'https://geops.example.invalid',
        'x-csrf-token': session.csrf,
        'idempotency-key': randomUUID(),
        ...extra,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  check(
    (await admin(unprivileged, 'GET', '/v1/admin/auth/me')).statusCode === 200,
    'admin without GPS capability remains authenticated',
  );
  const emptyCapabilities = await admin(unprivileged, 'GET', '/v1/admin/gps-capabilities');
  check(
    emptyCapabilities.statusCode === 200 &&
      JSON.stringify(emptyCapabilities.json()) ===
        JSON.stringify({ capabilities: [], tenant_ids: [] }),
    'capability discovery returns an empty list rather than a denial',
  );
  check(
    (await admin(unprivileged, 'GET', '/v1/admin/gps-policies')).statusCode === 403,
    'policy read still requires an explicit capability',
  );
  const grantedCapabilities = await admin(operator, 'GET', '/v1/admin/gps-capabilities');
  check(
    grantedCapabilities.statusCode === 200 &&
      grantedCapabilities.json().capabilities.includes('gps.policy.read'),
    'granted admin sees the current policy capability',
  );
  const deviceId = randomUUID(),
    bindingId = randomUUID(),
    keyId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','synthetic operations device')",
    [deviceId],
  );
  await pool.query(
    "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic','synthetic-operations','ACTIVE')",
    [bindingId, deviceId],
  );
  await pool.query(
    "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
    [keyId, deviceId, spki, hash(spki)],
  );
  await pool.query(
    'INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), deviceId, keyId, hash(token), iso(-60_000), iso(10 * DAY)],
  );
  async function deviceConfig() {
    const nonce = randomBytes(16).toString('base64url'),
      timestamp = String(Math.floor(Date.now() / 1000));
    const bytes = requestProofBytes({
      method: 'GET',
      absolutePath: '/v1/device/config',
      bodySha256: hash('').toString('base64url'),
      tokenSha256: hash(token).toString('base64url'),
      timestamp,
      nonce,
      keyId,
    });
    return app.inject({
      method: 'GET',
      url: '/v1/device/config',
      headers: {
        authorization: `Bearer ${token}`,
        'x-geops-key-id': keyId,
        'x-geops-timestamp': timestamp,
        'x-geops-nonce': nonce,
        'x-geops-signature': sign('sha256', bytes, pair.privateKey).toString('base64url'),
      },
    });
  }
  check(
    (await deviceConfig()).statusCode === 403,
    'PoP config denied before installation activation',
  );
  check(
    (
      await admin(
        operator,
        'POST',
        '/v1/admin/gps-installations',
        { device_id: deviceId, reason: 'Synthetic installation approval' },
        { 'x-csrf-token': 'invalid' },
      )
    ).statusCode === 403,
    'activation requires valid CSRF',
  );
  check(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin/gps-installations',
        payload: { device_id: deviceId, reason: 'Synthetic installation approval' },
      })
    ).statusCode === 401,
    'anonymous activation rejected',
  );
  const activated = await admin(operator, 'POST', '/v1/admin/gps-installations', {
    device_id: deviceId,
    reason: 'Synthetic installation approval',
  });
  check(
    activated.statusCode === 201 && activated.json().device_id === deviceId,
    'installation activated by separate capability',
  );
  const installationId = activated.json().installation_id;
  check(
    (
      await admin(operator, 'POST', '/v1/admin/gps-installations', {
        device_id: deviceId,
        reason: 'Synthetic duplicate attempt',
      })
    ).statusCode === 409,
    'duplicate active installation rejected',
  );
  check((await deviceConfig()).statusCode === 200, 'PoP config permitted after activation');
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `UPDATE ${table} SET revoked_at=now() WHERE admin_id=$1 AND tenant_id='synthetic' AND revoked_at IS NULL`,
      [adminId],
    );
  check(
    (await admin(operator, 'GET', '/v1/admin/gps-devices')).json().items.length === 0,
    'device list denies tenant before grant',
  );
  const grantId = randomUUID();
  const grant = {
    request_id: grantId,
    target_admin_id: adminId,
    tenant_id: 'synthetic',
    action: 'GRANT',
    reason: 'Synthetic access review',
  };
  check(
    (await admin(operator, 'POST', '/v1/admin/gps-tenant-grants/proposals', grant)).statusCode ===
      201,
    'tenant grant proposed without immediate access',
  );
  check(
    (await admin(operator, 'POST', `/v1/admin/gps-tenant-grants/${grantId}/approve`, {}))
      .statusCode === 403,
    'proposer cannot self-approve',
  );
  check(
    (
      await pool.query(
        "SELECT 1 FROM audit_event WHERE action='gps.tenant-grant.approve' AND outcome='rejected' AND metadata_redacted->>'code'='second_approver_required'",
      )
    ).rowCount === 1,
    'self-approval denial audited without payload',
  );
  check(
    (await admin(approver, 'POST', `/v1/admin/gps-tenant-grants/${grantId}/approve`, {}))
      .statusCode === 200,
    'second capable admin approves both tenant scopes',
  );
  check(
    (await admin(approver, 'POST', `/v1/admin/gps-tenant-grants/${grantId}/approve`, {}))
      .statusCode === 200,
    'approval retry idempotent',
  );
  const authorizedDevices = (await admin(operator, 'GET', '/v1/admin/gps-devices')).json().items;
  check(authorizedDevices.length === 1, 'tenant device visible after approved grant');
  check(
    authorizedDevices[0].display_label === 'synthetic operations device',
    'GPS list includes device display label',
  );
  const policy = {
    name: 'Synthetic scheduler policy',
    days_iso: [1, 2, 3, 4, 5, 6, 7],
    start_local: clock(-60),
    end_local: clock(60),
    time_zone: 'UTC',
    capture_interval_s: 60,
    sync_interval_s: 300,
    health_interval_s: 300,
    heartbeat_missing_after_s: 900,
    valid_from: iso(-DAY),
    valid_until: iso(10 * DAY),
  };
  const created = await admin(operator, 'POST', '/v1/admin/gps-policies', policy);
  check(created.statusCode === 201, 'policy created');
  const policyId = created.json().id;
  const assigned = await admin(
    operator,
    'PUT',
    `/v1/admin/gps-policies/${policyId}/assignments`,
    {
      assignments: [
        {
          scope_type: 'DEVICE',
          scope_id: deviceId,
          valid_from: iso(-3_600_000),
          valid_until: iso(10 * DAY),
        },
      ],
    },
    { 'if-match': created.headers.etag },
  );
  check(assigned.statusCode === 200, 'device assignment prepared');
  const published = await admin(
    operator,
    'POST',
    `/v1/admin/gps-policies/${policyId}/publish`,
    { reason: 'Synthetic scheduler approval' },
    { 'if-match': assigned.headers.etag },
  );
  check(published.statusCode === 200, 'policy published with UTC windows');
  const initial = await pool.query(
    'SELECT count(*)::int AS n FROM gps_scheduled_session WHERE device_id=$1',
    [deviceId],
  );
  check(initial.rows[0].n > 0, 'initial windows materialized');
  const liveConfig = (await deviceConfig()).json();
  const currentWindow = liveConfig.window_instances.find(
    (item) =>
      Date.parse(item.start_at) <= Date.parse(liveConfig.server_time) &&
      Date.parse(liveConfig.server_time) < Date.parse(item.end_at),
  );
  check(Boolean(currentWindow), 'current UTC window available for synthetic observation');
  await pool.query(
    `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,
     local_date,start_at,end_at,state) VALUES($1,$2,$3,1,$4,CURRENT_DATE,
       now()-interval '3 hours',now()-interval '2 hours','SCHEDULED')`,
    [randomUUID(), deviceId, policyId, liveConfig.assignment_version],
  );
  const effectiveId = randomUUID();
  await pool.query(
    `INSERT INTO gps_effective_session(id,device_id,installation_id,client_session_id,
     scheduled_session_id,assignment_version,started_at,start_event_id,state,evidence_state,
     tenant_id,mdm_binding_id,start_boot_id,start_anchor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'OPEN','DEVICE_REPORTED',$9,$10,$11,$12)`,
    [
      effectiveId,
      deviceId,
      installationId,
      randomUUID(),
      currentWindow.scheduled_session_id,
      liveConfig.assignment_version,
      liveConfig.server_time,
      randomUUID(),
      'synthetic',
      bindingId,
      randomUUID(),
      liveConfig.capture_anchor_id,
    ],
  );
  const oldPosition = randomUUID(),
    oldHealth = randomUUID();
  await pool.query(
    `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,
     captured_at,capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,
     geom,accuracy_m,payload_digest,quality_state,tenant_id,mdm_binding_id,installation_id)
     VALUES($1,$2,$3,$4,now()-interval '91 days',$5,$6,0,1,
       ST_SetSRID(ST_MakePoint(-90.52,14.61),4326)::geography,8,$7,'DEVICE_REPORTED',$8,$9,$10)`,
    [
      deviceId,
      oldPosition,
      effectiveId,
      liveConfig.assignment_version,
      liveConfig.capture_anchor_id,
      randomUUID(),
      hash('old synthetic position'),
      'synthetic',
      bindingId,
      installationId,
    ],
  );
  await pool.query(
    `INSERT INTO gps_device_health_event(device_id,event_id,tenant_id,mdm_binding_id,
     installation_id,batch_id,assignment_version,policy_revision,scheduled_session_id,
     capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,due_at,
     observed_at,tracking_state,observed_states,payload_digest)
     VALUES($1,$2,'synthetic',$3,$4,$5,$6,1,$7,$8,$9,0,1,
       now()-interval '91 days',now()-interval '91 days','RUNNING',ARRAY['UNKNOWN']::text[],$10)`,
    [
      deviceId,
      oldHealth,
      bindingId,
      installationId,
      randomUUID(),
      liveConfig.assignment_version,
      currentWindow.scheduled_session_id,
      liveConfig.capture_anchor_id,
      randomUUID(),
      hash('old synthetic health'),
    ],
  );
  const auditBefore = (await pool.query('SELECT count(*)::int AS n FROM audit_event')).rows[0].n;
  const base = Date.now();
  const scheduler = new GpsScheduler(pool, policies, events, health, () => new Date(base + DAY));
  const replenished = await scheduler.tick();
  check(
    !replenished.skipped && replenished.windows_created > 0,
    'rolling seven-day horizon replenished',
  );
  check(
    replenished.positions_purged === 1 && replenished.health_purged === 1,
    'scheduled retention purges expired position and health sample',
  );
  check(
    (await pool.query('SELECT count(*)::int AS n FROM audit_event')).rows[0].n >= auditBefore,
    'GPS retention preserves audit history',
  );
  const unknown = await pool.query(
    'SELECT state,stopped_at FROM gps_effective_session WHERE id=$1',
    [effectiveId],
  );
  check(
    unknown.rows[0]?.state === 'UNKNOWN_END' && unknown.rows[0].stopped_at === null,
    'scheduler marks unknown end without invented stop timestamp',
  );
  const repeated = await scheduler.tick();
  check(
    repeated.windows_created === 0 && repeated.versions_advanced === 0,
    'same scheduler time is idempotent',
  );
  const missed = await pool.query(
    "SELECT count(*)::int AS n FROM gps_scheduled_session WHERE device_id=$1 AND state='MISSED'",
    [deviceId],
  );
  check(
    missed.rows[0].n > 0 &&
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM gps_effective_session WHERE device_id=$1',
          [deviceId],
        )
      ).rows[0].n === 1,
    'other expired windows inferred missed without creating extra effective starts',
  );
  const beforeVersion = await pool.query(
    'SELECT assignment_version FROM gps_device_assignment_state WHERE device_id=$1',
    [deviceId],
  );
  const expired = new GpsScheduler(pool, policies, events, health, () => new Date(base + 11 * DAY));
  const expiration = await expired.tick();
  const afterVersion = await pool.query(
    'SELECT assignment_version FROM gps_device_assignment_state WHERE device_id=$1',
    [deviceId],
  );
  check(
    expiration.versions_advanced === 1 &&
      Number(afterVersion.rows[0].assignment_version) >
        Number(beforeVersion.rows[0].assignment_version),
    'assignment expiry advances version',
  );
  check((await expired.tick()).versions_advanced === 0, 'expiry transition does not repeat');
  const wire = new GpsRemote(async (path, init = {}) => {
    const response = await app.inject({
      method: init.method ?? 'GET',
      url: String(path),
      headers: { cookie: operator.cookie, ...(init.headers ?? {}) },
    });
    return new Response(response.payload, { status: response.statusCode });
  });
  check(
    (await wire.capabilities()).capabilities.includes('gps.session.read'),
    'Web client reads current backend capabilities',
  );
  check(
    (await wire.devices()).items[0]?.device_id === deviceId,
    'Web client receives tenant-filtered device',
  );
  check(
    (await wire.policies()).items.some((item) => item.id === policyId),
    'Web client reads published policy',
  );
  check(
    (await wire.sessions(deviceId)).items.some(
      (item) => item.evidence_state === 'SERVER_INFERRED_MISSED',
    ),
    'Web client distinguishes inferred missing start',
  );
  const staleId = randomUUID();
  await admin(operator, 'POST', '/v1/admin/gps-tenant-grants/proposals', {
    request_id: staleId,
    target_admin_id: adminId,
    tenant_id: 'synthetic',
    action: 'REVOKE',
    reason: 'Synthetic stale revocation',
  });
  await pool.query(
    "UPDATE gps_tenant_grant_request SET proposed_at=now()-interval '25 hours' WHERE id=$1",
    [staleId],
  );
  check(
    (await admin(approver, 'POST', `/v1/admin/gps-tenant-grants/${staleId}/approve`, {}))
      .statusCode === 410,
    'stale grant proposal cannot be approved',
  );
  const revokeId = randomUUID();
  await admin(operator, 'POST', '/v1/admin/gps-tenant-grants/proposals', {
    request_id: revokeId,
    target_admin_id: adminId,
    tenant_id: 'synthetic',
    action: 'REVOKE',
    reason: 'Synthetic access revocation',
  });
  check(
    (await admin(approver, 'POST', `/v1/admin/gps-tenant-grants/${revokeId}/approve`, {}))
      .statusCode === 200,
    'second admin revokes both tenant scopes',
  );
  check((await wire.devices()).items.length === 0, 'Web no longer lists revoked tenant device');
  check(
    (
      await admin(operator, 'POST', `/v1/admin/gps-installations/${installationId}/retire`, {
        reason: 'Synthetic denied retirement',
      })
    ).statusCode === 403,
    'retirement rejects revoked tenant access',
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,$2)`,
      [adminId, 'Synthetic transfer cleanup access'],
    );
  await pool.query("UPDATE mdm_binding SET state='REVOKED' WHERE id=$1", [bindingId]);
  await pool.query(
    "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-new','synthetic-transfer','ACTIVE')",
    [randomUUID(), deviceId],
  );
  check(
    (await deviceConfig()).statusCode === 403,
    'old installation cannot be reused after tenant transfer',
  );
  check(
    (
      await admin(operator, 'POST', `/v1/admin/gps-installations/${installationId}/retire`, {
        reason: 'Synthetic retirement review',
      })
    ).statusCode === 204,
    'installation retired with capability',
  );
  check((await deviceConfig()).statusCode === 403, 'retired installation rejects PoP config');
  const reactivated = await admin(operator, 'POST', '/v1/admin/gps-installations', {
    device_id: deviceId,
    reason: 'Synthetic transfer reactivation',
  });
  check(
    reactivated.statusCode === 403,
    'single operating tenant rejects activation in another tenant',
  );
  check((await deviceConfig()).statusCode === 403, 'rejected transfer cannot restore PoP config');
  const addFixtureDevice = async (
    displayLabel,
    status = 'ACTIVE',
    tenant = 'synthetic',
    bindingState = 'ACTIVE',
  ) => {
    const id = randomUUID();
    await pool.query('INSERT INTO geops_device(id,display_label,status) VALUES($1,$2,$3)', [
      id,
      displayLabel,
      status,
    ]);
    await pool.query(
      "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake',$3,$4,$5)",
      [randomUUID(), id, tenant, randomUUID(), bindingState],
    );
    return id;
  };
  const fiveIds = [];
  for (let number = 1; number <= 5; number++)
    fiveIds.push(await addFixtureDevice(`Android-Prueba-0${number}`));
  const activeInstallationId = randomUUID();
  await pool.query(
    `INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id)
     SELECT $1,$2,now(),b.id,b.customer_id FROM mdm_binding b
     WHERE b.geops_device_id=$2 AND b.state='ACTIVE'`,
    [activeInstallationId, fiveIds[0]],
  );
  const inventoryResponse = await admin(operator, 'GET', '/v1/admin/devices');
  check(
    inventoryResponse.statusCode === 200,
    `Inventory fixture status ${inventoryResponse.statusCode}`,
  );
  const inventory = inventoryResponse.json().items;
  const inventoryById = new Map(inventory.map((device) => [device.id, device.display_label]));
  const gpsDevices = (await admin(operator, 'GET', '/v1/admin/gps-devices')).json().items;
  check(gpsDevices.length === 5, 'GPS lists five eligible synthetic devices');
  check(
    fiveIds.every((id, index) => inventoryById.get(id) === `Android-Prueba-0${index + 1}`),
    'Inventory reads five canonical display labels',
  );
  check(
    fiveIds.every(
      (id) =>
        gpsDevices.find((device) => device.device_id === id)?.display_label ===
        inventoryById.get(id),
    ),
    'GPS labels match canonical Inventory values by device identity',
  );
  check(
    gpsDevices.find((device) => device.device_id === fiveIds[0])?.installation_id ===
      activeInstallationId &&
      fiveIds
        .slice(1)
        .every(
          (id) => gpsDevices.find((device) => device.device_id === id)?.installation_id === null,
        ),
    'GPS lists eligible devices with and without active installation',
  );
  const webDevices = (await wire.devices()).items;
  const webNames = deviceNames(webDevices);
  check(
    fiveIds.every((id, index) => webNames.get(id) === `Android-Prueba-0${index + 1}`),
    'Web client renders the five canonical Inventory names',
  );
  const unnamedId = await addFixtureDevice('');
  const duplicateA = await addFixtureDevice('Android-Duplicado');
  const duplicateB = await addFixtureDevice('Android-Duplicado');
  const revokedId = await addFixtureDevice('Android-Revocado', 'REVOKED');
  const revokedBindingId = await addFixtureDevice(
    'Android-Vínculo-Revocado',
    'ACTIVE',
    'synthetic',
    'REVOKED',
  );
  const pendingId = await addFixtureDevice('Android-Pendiente', 'ACTIVE', 'synthetic', 'PENDING');
  const otherTenantId = await addFixtureDevice('Android-Otro-Tenant', 'ACTIVE', 'tenant-new');
  const scopedDevices = (await wire.devices()).items;
  const scopedIds = new Set(scopedDevices.map((device) => device.device_id));
  check(scopedDevices.length === 8, 'GPS includes named, unnamed and duplicate eligible devices');
  check(
    ![revokedId, revokedBindingId, pendingId, otherTenantId].some((id) => scopedIds.has(id)),
    'GPS excludes revoked identity or binding, pending binding and another tenant',
  );
  check(
    scopedDevices.every((device) => device.tenant_id === 'synthetic'),
    'GPS tenant isolation',
  );
  const scopedNames = deviceNames(scopedDevices);
  check(
    scopedNames.get(unnamedId)?.startsWith('Dispositivo sin nombre · ') &&
      scopedNames.get(duplicateA)?.startsWith('Android-Duplicado · ') &&
      scopedNames.get(duplicateB)?.startsWith('Android-Duplicado · ') &&
      scopedNames.get(duplicateA) !== scopedNames.get(duplicateB),
    'Web adds short IDs only for missing and duplicate names',
  );
  check(
    (await admin(unprivileged, 'GET', '/v1/admin/gps-devices')).statusCode === 403,
    'GPS device list requires permission',
  );
  console.log(`gps-operations integration PASS: ${checks} assertions`);
} finally {
  await app.close();
  await pool.end();
}
