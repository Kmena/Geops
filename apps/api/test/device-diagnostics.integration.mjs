// SPEC-05 Wave 2: synthetic fixtures in an explicitly disposable database only.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { requestProofBytes } from '@geops/api-contracts';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceSessionService } from '../src/device-identity/session.ts';
import { DeviceDiagnosticsService } from '../src/device-diagnostics-service.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
let app;
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
const sha = (value) => createHash('sha256').update(value).digest();
try {
  const applied = await applyMigrations(pool);
  check(applied.includes('0041_device_diagnostics.sql'), 'additive migration applied');
  check((await applyMigrations(pool)).length === 0, 'migration recheck is idempotent');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 55),
    csrfKey: Buffer.alloc(32, 56),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const adminId = await auth.bootstrap(
    'diagnostics@example.invalid',
    'synthetic-password-12345678',
  );
  const sessions = new DeviceSessionService(pool);
  let clock = new Date();
  const service = new DeviceDiagnosticsService(pool, () => clock);
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    deviceSessions: sessions,
    deviceDiagnostics: service,
    secureCookie: false,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'diagnostics@example.invalid', password: 'synthetic-password-12345678' },
  });
  check(login.statusCode === 200, 'admin login');
  const cookie = login.headers['set-cookie'].split(';')[0];
  const admin = (path) => app.inject({ method: 'GET', url: path, headers: { cookie } });
  const fixture = async (tenant) => {
    const deviceId = randomUUID(),
      keyId = randomUUID(),
      installationId = randomUUID();
    const bindingId = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
    await pool.query(
      "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic diagnostic device')",
      [deviceId],
    );
    await pool.query(
      "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake',$3,$4,'ACTIVE')",
      [bindingId, deviceId, tenant, `synthetic-${deviceId}`],
    );
    await pool.query(
      "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
      [keyId, deviceId, spki, sha(spki)],
    );
    await pool.query(
      'INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        deviceId,
        keyId,
        sha(token),
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 600_000),
      ],
    );
    await pool.query(
      'INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,now(),$3,$4)',
      [installationId, deviceId, bindingId, tenant],
    );
    const send = async (payload, nonce = randomBytes(16).toString('base64url')) => {
      const path = '/v1/device/diagnostics/snapshots';
      const body = JSON.stringify(payload),
        timestamp = String(Math.floor(Date.now() / 1000));
      const proof = requestProofBytes({
        method: 'POST',
        absolutePath: path,
        bodySha256: sha(body).toString('base64url'),
        tokenSha256: sha(token).toString('base64url'),
        timestamp,
        nonce,
        keyId,
      });
      return app.inject({
        method: 'POST',
        url: path,
        payload: body,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-geops-key-id': keyId,
          'x-geops-timestamp': timestamp,
          'x-geops-nonce': nonce,
          'x-geops-signature': sign('sha256', proof, pair.privateKey).toString('base64url'),
        },
      });
    };
    return { deviceId, keyId, installationId, send };
  };
  const a = await fixture('tenant-a');
  const b = await fixture('tenant-b');
  const base = (installationId, sequence = 1) => ({
    schema_version: 1,
    installation_id: installationId,
    boot_id: 'diagnostic-boot-1',
    sequence,
    observed_at: clock.toISOString(),
    app_version: '1.0.2-spec05-wave2',
    manufacturer: 'Motorola',
    model: 'moto g06',
    android_release: '15',
    android_api: 35,
    permissions: {
      fine: 'GRANTED',
      coarse: 'GRANTED',
      background: 'DENIED',
      notifications: 'GRANTED',
    },
    execution: {
      location_enabled: true,
      gps_provider_enabled: true,
      battery_exempt: false,
      power_save: false,
      background_restricted: true,
      data_saver: 'DISABLED',
      internet: 'VALIDATED',
    },
    gps: {
      service: 'UNKNOWN',
      last_callback_at: null,
      last_capture_at: null,
      last_ack_at: null,
      pending_positions: 0,
      upload_auth_blocked: false,
      capture_interval_s: 60,
      sync_interval_s: 60,
      policy_revision: 1,
      tracking_mode: 'CONTINUOUS',
    },
    errors: [],
  });
  check(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/device/diagnostics/snapshots',
        payload: base(a.installationId),
      })
    ).statusCode === 401,
    'device authentication required',
  );
  check((await a.send(base(b.installationId))).statusCode === 403, 'installation swap rejected');
  check(
    (await a.send({ ...base(a.installationId), secret: 'forbidden' })).statusCode === 422,
    'unknown field rejected',
  );
  const first = await a.send(base(a.installationId));
  check(first.statusCode === 201 && !first.json().duplicate, 'PoP diagnostic stored');
  const retry = await a.send(base(a.installationId));
  check(
    retry.statusCode === 200 &&
      retry.json().duplicate &&
      retry.json().snapshot_id === first.json().snapshot_id,
    'lost ACK retry is idempotent',
  );
  check(
    (await a.send({ ...base(a.installationId), model: 'other' })).statusCode === 409,
    'same sequence with different digest rejected',
  );
  const later = {
    ...base(a.installationId, 3),
    observed_at: new Date(clock.getTime() - 60_000).toISOString(),
  };
  check((await a.send(later)).statusCode === 201, 'out-of-order sequence accepted');
  const concurrent = await Promise.all([
    a.send(base(a.installationId, 4)),
    a.send(base(a.installationId, 4)),
  ]);
  check(
    concurrent.every((r) => [200, 201].includes(r.statusCode)) &&
      concurrent.some((r) => r.json().duplicate),
    'concurrent duplicate serialized',
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics`)).statusCode === 403,
    'admin capability required',
  );
  await pool.query(
    'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
    [adminId, 'mdm.diagnostics.view', 'Synthetic diagnostic read'],
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,$2)`,
      [adminId, 'Synthetic diagnostic tenant'],
    );
  const latest = await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics`);
  check(
    latest.statusCode === 200 && latest.json().payload.sequence === 4,
    'latest chosen by observed time, not arrival order',
  );
  check(
    latest.json().findings.some((f) => f.code === 'GPS_BACKGROUND_PERMISSION_MISSING'),
    'permission finding exposed',
  );
  await pool.query(
    `INSERT INTO gps_device_ownership(device_id,ownership,mdm_state,
    verification_source,evidence_ref,verified_at,valid_until,tracking_authorized,
    authorization_basis,privacy_notice_at,updated_by,change_reason)
    VALUES($1,'PERSONAL_BYOD','NOT_APPLICABLE','ADMIN_EVIDENCE',$2,now(),$3,true,
      'Synthetic diagnostic authorization',$4,$5,'Synthetic diagnostic ownership')`,
    [
      a.deviceId,
      'SYNTHETIC-DIAGNOSTIC-CONSENT',
      new Date(Date.now() + 3 * 86_400_000),
      new Date(Date.now() - 86_400_000),
      adminId,
    ],
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics`))
      .json()
      .findings.some((f) => f.code === 'CONFIGURATION_INCOMPATIBLE'),
    'server ownership mismatch detected',
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${b.deviceId}/diagnostics`)).statusCode === 403,
    'other tenant denied',
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics/history?limit=2`)).json().items
      .length === 2,
    'bounded history',
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics/permissions`)).json().effective
      .background === 'DENIED',
    'permission projection',
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics/findings`)).json().findings
      .length > 0,
    'active findings',
  );
  check(
    (await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics/capture-transmission`)).json().gps
      .pending_positions === 0,
    'capture and transmission projection',
  );
  check(
    (await admin('/v1/admin/mdm/diagnostics/problems')).json().items.length === 1,
    'tenant scoped problem list',
  );
  clock = new Date(clock.getTime() + 20 * 60_000);
  check(
    (await admin('/v1/admin/mdm/diagnostics/stale')).json().items.length === 1,
    'stale diagnostic list',
  );
  const stale = await admin(`/v1/admin/mdm/devices/${a.deviceId}/diagnostics`);
  check(
    !stale.json().findings.some((f) => f.code === 'GPS_SERVICE_NOT_RUNNING'),
    'stale evidence does not assert stopped service',
  );
  await assert.rejects(
    pool.query('UPDATE device_diagnostic_snapshot SET sequence=99 WHERE id=$1', [
      first.json().snapshot_id,
    ]),
    /immutable/,
  );
  checks++;
  console.log(`device-diagnostics integration PASS: ${checks} assertions`);
} finally {
  if (app) await app.close();
  await pool.end();
}
