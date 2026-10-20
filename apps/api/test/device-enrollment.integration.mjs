// Mutates only a disposable geops_verify_* database supplied explicitly by the caller.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { enrollmentProofBytes } from '@geops/api-contracts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { EnrollmentService } from '../src/device-identity/enrollment.ts';
import { DeviceSessionService } from '../src/device-identity/session.ts';
import { DeviceLifecycleService } from '../src/device-identity/lifecycle.ts';
import { FakeMdmProvider } from '../src/mdm/provider.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsAdministrationService } from '../src/gps-administration.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url });
assert.match(
  (await pool.query('SELECT current_database() AS name')).rows[0].name,
  /^geops_verify_[0-9]+$/,
);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
const auth = new AdminAuthService(pool, {
  sessionKey: Buffer.alloc(32, 1),
  csrfKey: Buffer.alloc(32, 2),
  allowedOrigins: ['https://geops.example.invalid'],
});
const devices = new DeviceRepository(pool);
const enrollment = new EnrollmentService(pool, devices, Buffer.alloc(32, 3));
const policies = new GpsPolicyService(pool);
const app = createApp({
  readinessProbe: async () => true,
  logLevel: 'silent',
  adminAuth: auth,
  devices,
  mdm: new FakeMdmProvider(),
  enrollment,
  deviceSessions: new DeviceSessionService(pool),
  deviceLifecycle: new DeviceLifecycleService(pool, devices),
  gpsPolicies: policies,
  gpsAdministration: new GpsAdministrationService(pool, policies),
  secureCookie: false,
});
try {
  const adminId = await auth.bootstrap('enrollment@example.invalid', 'synthetic-password-12345678');
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.installation.manage',$1,$2)",
    [adminId, 'Synthetic enrollment integration'],
  );
  await pool.query(
    'INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES($1,$2,$3)',
    ['synthetic', adminId, randomUUID()],
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,$2)`,
      [adminId, 'Synthetic enrollment integration'],
    );
  const login = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'enrollment@example.invalid', password: 'synthetic-password-12345678' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const csrf = login.json().csrf_token;
  const admin = (method, path, payload, headers = {}) =>
    app.inject({
      method,
      url: path,
      headers: {
        cookie,
        origin: 'https://geops.example.invalid',
        'x-csrf-token': csrf,
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const setCapability = async (enabled) =>
    pool.query(
      "UPDATE admin_permission SET revoked_at=$2 WHERE admin_id=$1 AND permission='gps.installation.manage'",
      [adminId, enabled ? null : new Date()],
    );
  const setTenantAccess = async (enabled) => {
    for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
      await pool.query(
        `UPDATE ${table} SET revoked_at=$2 WHERE admin_id=$1 AND tenant_id='synthetic'`,
        [adminId, enabled ? null : new Date()],
      );
  };

  await setTenantAccess(false);
  assert.equal(
    (
      await admin('POST', '/v1/admin/devices', {
        display_label: 'Unscoped draft',
      })
    ).statusCode,
    403,
  );
  assert.equal((await admin('GET', '/v1/admin/mdm/status')).statusCode, 403);
  await setTenantAccess(true);

  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin/devices',
        payload: { display_label: 'Phone' },
      })
    ).statusCode,
    401,
  );
  const created = await admin('POST', '/v1/admin/devices', { display_label: 'Equipo 1' });
  assert.equal(created.statusCode, 201);
  const device = created.json();
  assert.equal(device.status, 'DRAFT');
  assert.equal(
    (
      await admin(
        'POST',
        '/v1/admin/devices',
        { display_label: 'Equipo 2' },
        { 'x-csrf-token': 'wrong' },
      )
    ).statusCode,
    403,
  );
  const list = await admin('GET', '/v1/admin/enrollment/devices');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items[0].id, device.id);
  assert.equal(list.json().items[0].last_communication_at, null);
  const mdmId = list.json().items[0].mdm_device_id;

  const path = `/v1/admin/devices/${device.id}/invitations`;
  const invitationRequest = {
    mdm_binding_id: device.mdm_binding_id,
    delivery_mode: 'supervised_qr',
  };
  await setCapability(false);
  const deniedInvitation = await admin('POST', path, invitationRequest);
  assert.equal(deniedInvitation.statusCode, 403);
  await setCapability(true);
  await setTenantAccess(false);
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'another-tenant',$1,$2)`,
      [adminId, 'Synthetic cross tenant test'],
    );
  assert.equal((await admin('POST', path, invitationRequest)).statusCode, 403);
  assert.equal((await admin('GET', '/v1/admin/enrollment/devices')).statusCode, 403);
  await setTenantAccess(true);
  const issued = await admin('POST', path, {
    mdm_binding_id: device.mdm_binding_id,
    delivery_mode: 'supervised_qr',
  });
  assert.equal(issued.statusCode, 201);
  const invitation = issued.json();
  assert.match(invitation.invitation_secret, /^[A-Za-z0-9_-]+$/);
  assert.ok(
    !deniedInvitation.body.includes(invitation.invitation_secret),
    'denial does not disclose the one-time secret',
  );
  assert.equal(
    (await admin('GET', '/v1/admin/enrollment/devices')).json().items[0].invitation_status,
    'ISSUED',
  );
  const cancelPath = `${path}/${invitation.invitation_id}`;
  assert.equal((await app.inject({ method: 'DELETE', url: cancelPath })).statusCode, 401);
  assert.equal(
    (await admin('DELETE', cancelPath, undefined, { 'x-csrf-token': 'wrong' })).statusCode,
    403,
  );
  await setCapability(false);
  assert.equal((await admin('GET', '/v1/admin/enrollment/devices')).statusCode, 403);
  assert.equal((await admin('DELETE', cancelPath)).statusCode, 403);
  await setCapability(true);
  assert.equal((await admin('DELETE', cancelPath)).statusCode, 200);
  assert.equal((await admin('DELETE', cancelPath)).statusCode, 409);
  const after = (await admin('GET', '/v1/admin/enrollment/devices')).json().items[0];
  assert.equal(after.status, 'DRAFT');
  assert.equal(after.invitation_status, 'CANCELLED');
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = await app.inject({
    method: 'POST',
    url: '/v1/device/enrollment/claims',
    payload: {
      invitation_id: invitation.invitation_id,
      invitation_secret: invitation.invitation_secret,
      geops_device_id: device.id,
      mdm_device_id: mdmId,
      public_key_spki: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      client_nonce: randomBytes(16).toString('base64url'),
    },
  });
  assert.equal(claim.statusCode, 409);
  const reissued = (
    await admin('POST', path, {
      mdm_binding_id: device.mdm_binding_id,
      delivery_mode: 'supervised_qr',
    })
  ).json();
  const nonce = randomBytes(16).toString('base64url');
  const spki = key.publicKey.export({ format: 'der', type: 'spki' });
  const claimed = await app.inject({
    method: 'POST',
    url: '/v1/device/enrollment/claims',
    payload: {
      invitation_id: reissued.invitation_id,
      invitation_secret: reissued.invitation_secret,
      geops_device_id: device.id,
      mdm_device_id: mdmId,
      public_key_spki: spki.toString('base64url'),
      client_nonce: nonce,
    },
  });
  assert.equal(claimed.statusCode, 201);
  const challenge = claimed.json();
  const bytes = enrollmentProofBytes({
    claimId: challenge.claim_id,
    challengeId: challenge.challenge_id,
    challenge: challenge.challenge,
    geopsDeviceId: device.id,
    mdmDeviceId: mdmId,
    publicKeySpkiSha256: createHash('sha256').update(spki).digest('base64url'),
    clientNonce: nonce,
  });
  const proven = await app.inject({
    method: 'POST',
    url: `/v1/device/enrollment/claims/${challenge.claim_id}/proof`,
    payload: {
      challenge_id: challenge.challenge_id,
      signature: sign('sha256', bytes, key.privateKey).toString('base64url'),
    },
  });
  assert.equal(proven.statusCode, 200);
  assert.equal(
    (await admin('GET', '/v1/admin/enrollment/devices')).json().items[0].claim_id,
    challenge.claim_id,
  );
  const evidencePath = `/v1/admin/devices/${device.id}/synthetic-evidence`;
  const evidenceRequest = {
    claim_id: challenge.claim_id,
    physical_confirmed: true,
    attestation_exception: true,
  };
  assert.equal(
    (await app.inject({ method: 'POST', url: evidencePath, payload: evidenceRequest })).statusCode,
    401,
  );
  assert.equal(
    (await admin('POST', evidencePath, evidenceRequest, { 'x-csrf-token': 'wrong' })).statusCode,
    403,
  );
  assert.equal(
    (
      await admin('POST', evidencePath, evidenceRequest, {
        origin: 'https://other.example.invalid',
      })
    ).statusCode,
    403,
  );
  await setCapability(false);
  assert.equal((await admin('POST', evidencePath, evidenceRequest)).statusCode, 403);
  await setCapability(true);
  await setTenantAccess(false);
  assert.equal((await admin('POST', evidencePath, evidenceRequest)).statusCode, 403);
  await setTenantAccess(true);
  const evidence = await admin('POST', evidencePath, evidenceRequest);
  assert.equal(evidence.statusCode, 200);
  const activatePath = `/v1/admin/devices/${device.id}/activate`;
  const activationRequest = {
    claim_id: challenge.claim_id,
    pairing_code: proven.json().pairing_code,
    mdm_verification_method: 'manual_two_traits',
    evidence_ref: evidence.json().evidence_ref,
  };
  assert.equal(
    (await app.inject({ method: 'POST', url: activatePath, payload: activationRequest }))
      .statusCode,
    401,
  );
  assert.equal(
    (await admin('POST', activatePath, { ...activationRequest, pairing_code: '00000000' }))
      .statusCode,
    403,
  );
  await setCapability(false);
  assert.equal((await admin('POST', activatePath, activationRequest)).statusCode, 403);
  await setCapability(true);
  await setTenantAccess(false);
  assert.equal((await admin('POST', activatePath, activationRequest)).statusCode, 403);
  await setTenantAccess(true);
  const activated = await admin('POST', activatePath, activationRequest);
  assert.equal(activated.statusCode, 200);
  assert.equal((await admin('POST', activatePath, activationRequest)).statusCode, 409);
  await setTenantAccess(false);
  assert.equal(
    (
      await admin('POST', '/v1/admin/gps-installations', {
        device_id: device.id,
        reason: 'Synthetic denied tenant activation',
      })
    ).statusCode,
    403,
  );
  await setTenantAccess(true);
  const installation = await admin('POST', '/v1/admin/gps-installations', {
    device_id: device.id,
    reason: 'Synthetic authorized enrollment test',
  });
  assert.equal(installation.statusCode, 201);
  const active = (await admin('GET', '/v1/admin/enrollment/devices')).json().items[0];
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.key_id, activated.json().key_id);
  assert.equal(active.installation_id, installation.json().installation_id);
  assert.equal(
    (await admin('POST', path, invitationRequest)).statusCode,
    409,
    'reinstallation cannot silently replace an active key',
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/device/enrollment/claims',
        payload: {
          invitation_id: reissued.invitation_id,
          invitation_secret: reissued.invitation_secret,
          geops_device_id: device.id,
          mdm_device_id: mdmId,
          public_key_spki: spki.toString('base64url'),
          client_nonce: randomBytes(16).toString('base64url'),
        },
      })
    ).statusCode,
    409,
    'consumed invitation cannot be reused',
  );

  const pendingDevice = (
    await admin('POST', '/v1/admin/devices', {
      display_label: 'Equipo pendiente de revocación',
    })
  ).json();
  const pendingInvite = (
    await admin('POST', `/v1/admin/devices/${pendingDevice.id}/invitations`, {
      mdm_binding_id: pendingDevice.mdm_binding_id,
      delivery_mode: 'supervised_qr',
    })
  ).json();
  const pendingClaim = await app.inject({
    method: 'POST',
    url: '/v1/device/enrollment/claims',
    payload: {
      invitation_id: pendingInvite.invitation_id,
      invitation_secret: pendingInvite.invitation_secret,
      geops_device_id: pendingDevice.id,
      mdm_device_id: `fake-${pendingDevice.id}`,
      public_key_spki: spki.toString('base64url'),
      client_nonce: randomBytes(16).toString('base64url'),
    },
  });
  assert.equal(pendingClaim.statusCode, 201);
  await setCapability(false);
  assert.equal(
    (
      await admin('POST', `/v1/admin/devices/${pendingDevice.id}/revoke`, {
        reason: 'Synthetic pending device revoke',
      })
    ).statusCode,
    403,
  );
  await setCapability(true);
  assert.equal(
    (
      await admin('POST', `/v1/admin/devices/${pendingDevice.id}/revoke`, {
        reason: 'Synthetic pending device revoke',
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await admin('POST', `/v1/admin/devices/${pendingDevice.id}/revoke`, {
        reason: 'Synthetic repeat revoke',
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/v1/device/enrollment/claims/${pendingClaim.json().claim_id}/proof`,
        payload: {
          challenge_id: pendingClaim.json().challenge_id,
          signature: randomBytes(72).toString('base64url'),
        },
      })
    ).statusCode,
    409,
    'revocation during enrollment invalidates the claim',
  );

  const racingDevice = (
    await admin('POST', '/v1/admin/devices', {
      display_label: 'Equipo de carrera',
    })
  ).json();
  const racingInvite = (
    await admin('POST', `/v1/admin/devices/${racingDevice.id}/invitations`, {
      mdm_binding_id: racingDevice.mdm_binding_id,
      delivery_mode: 'supervised_qr',
    })
  ).json();
  const racePayload = {
    invitation_id: racingInvite.invitation_id,
    invitation_secret: racingInvite.invitation_secret,
    geops_device_id: racingDevice.id,
    mdm_device_id: `fake-${racingDevice.id}`,
    public_key_spki: spki.toString('base64url'),
    client_nonce: randomBytes(16).toString('base64url'),
  };
  const competingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const race = await Promise.all([
    app.inject({ method: 'POST', url: '/v1/device/enrollment/claims', payload: racePayload }),
    app.inject({
      method: 'POST',
      url: '/v1/device/enrollment/claims',
      payload: {
        ...racePayload,
        public_key_spki: competingKey.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64url'),
        client_nonce: randomBytes(16).toString('base64url'),
      },
    }),
  ]);
  assert.deepEqual(
    race.map((response) => response.statusCode).sort(),
    [201, 409],
    'one claimant wins the invitation',
  );
  const won = race.find((response) => response.statusCode === 201).json();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/v1/device/enrollment/claims/${won.claim_id}/proof`,
        payload: {
          challenge_id: won.challenge_id,
          signature: randomBytes(72).toString('base64url'),
        },
      })
    ).statusCode,
    401,
    'invalid PoP proof is rejected',
  );

  const expiredDevice = (
    await admin('POST', '/v1/admin/devices', {
      display_label: 'Equipo con invitación vencida',
    })
  ).json();
  const expiredInvite = (
    await admin('POST', `/v1/admin/devices/${expiredDevice.id}/invitations`, {
      mdm_binding_id: expiredDevice.mdm_binding_id,
      delivery_mode: 'supervised_qr',
    })
  ).json();
  await pool.query(
    "UPDATE device_invitation SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiredInvite.invitation_id],
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/device/enrollment/claims',
        payload: {
          invitation_id: expiredInvite.invitation_id,
          invitation_secret: expiredInvite.invitation_secret,
          geops_device_id: expiredDevice.id,
          mdm_device_id: `fake-${expiredDevice.id}`,
          public_key_spki: spki.toString('base64url'),
          client_nonce: randomBytes(16).toString('base64url'),
        },
      })
    ).statusCode,
    410,
  );
  const audit = await pool.query(
    "SELECT action FROM audit_event WHERE action IN ('device.draft.create','device.invitation.issue','device.invitation.cancel','device.enrollment.inventory.read')",
  );
  assert.equal(new Set(audit.rows.map((row) => row.action)).size, 4);
  const rejected = await pool.query(
    "SELECT action FROM audit_event WHERE outcome='rejected' AND action IN ('device.invitation.issue','device.synthetic_evidence','device.activate.synthetic','gps.installation.activate')",
  );
  assert.equal(new Set(rejected.rows.map((row) => row.action)).size, 4);
  process.stdout.write(
    'Synthetic Web enrollment, PoP proof, activation and installation checks passed\n',
  );
} finally {
  await app.close();
  await pool.end();
}
