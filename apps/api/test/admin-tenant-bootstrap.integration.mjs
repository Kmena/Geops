// Synthetic end-to-end administration flow; destructive only in a disposable geops_verify_* DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import {
  GpsCapabilityBootstrapService,
  INITIAL_GPS_CAPABILITIES,
} from '../src/admin-auth/gps-capability-bootstrap.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { GpsAdministrationService } from '../src/gps-administration.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { FakeMdmProvider } from '../src/mdm/provider.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
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
const denied = async (promise, label) => {
  await assert.rejects(promise, (error) => error?.statusCode === 403, label);
  checks++;
};

try {
  check(
    /^geops_verify_[0-9]+(?:_restore)?$/.test(
      (await pool.query('SELECT current_database() AS name')).rows[0].name,
    ),
    'disposable database',
  );
  await pool.query('TRUNCATE admin_user, recovery_custodian, geops_device, audit_event CASCADE');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 61),
    csrfKey: Buffer.alloc(32, 62),
    allowedOrigins: [origin],
  });
  const recovery = new SupervisedRecoveryService(pool, Buffer.alloc(32, 63));
  const primaryEmail = 'primary@example.invalid';
  const primaryId = await auth.bootstrap(primaryEmail, password);
  const custodianEmails = ['custodian-a@example.invalid', 'custodian-b@example.invalid'];
  for (const value of custodianEmails) await recovery.registerSyntheticCustodian(value, password);
  let gateOpen = true;
  const ceremony = new GpsCapabilityBootstrapService(pool, async () => gateOpen);
  const ceremonyInput = (requestId = randomUUID()) => ({
    requestId,
    adminEmail: primaryEmail,
    adminPassword: password,
    custodians: custodianEmails.map((email) => ({ email, password })),
    reason: 'Approved synthetic initial administration',
  });
  await ceremony.grantInitial(ceremonyInput());
  const secondaryCandidates = ['secondary-a@example.invalid', 'secondary-b@example.invalid'];
  await denied(
    ceremony.addSecondary({
      ...ceremonyInput(),
      secondEmail: secondaryCandidates[0],
      custodians: [
        { email: custodianEmails[0], password },
        { email: custodianEmails[1], password: 'wrong-password' },
      ],
    }),
    'invalid custodian denied',
  );
  const addId = randomUUID();
  const results = await Promise.allSettled(
    secondaryCandidates.map((secondEmail, index) =>
      ceremony.addSecondary({ ...ceremonyInput(index === 0 ? addId : randomUUID()), secondEmail }),
    ),
  );
  check(
    results.filter((value) => value.status === 'fulfilled').length === 1,
    'only one secondary administrator created concurrently',
  );
  const secondary = (
    await pool.query(
      'SELECT id,email_normalized,state FROM admin_user WHERE id<>$1 AND email_normalized<>$2',
      [primaryId, 'unprivileged@example.invalid'],
    )
  ).rows[0];
  check(secondary?.state === 'LOCKED', 'secondary begins locked');
  const secondaryEmail = secondary.email_normalized;
  await assert.rejects(
    auth.login(secondaryEmail, password, '127.0.0.1', randomUUID()),
    (error) => error?.statusCode === 401,
  );
  checks++;
  await denied(
    ceremony.addSecondary({ ...ceremonyInput(addId), secondEmail: secondaryEmail }),
    'secondary creation replay denied',
  );
  check(
    (
      await pool.query(
        'SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL',
        [secondary.id],
      )
    ).rowCount === INITIAL_GPS_CAPABILITIES.length,
    'second administrator receives exact GPS capability set while locked',
  );

  const secondaryPassword = 'secondary-synthetic-password-12345678';
  await denied(
    ceremony.activateSecondary(
      { ...ceremonyInput(), adminPassword: 'wrong-password', secondEmail: secondaryEmail },
      secondaryPassword,
      recovery,
    ),
    'initial administrator must authenticate secondary activation',
  );
  await denied(
    ceremony.activateSecondary(
      {
        ...ceremonyInput(),
        secondEmail: secondaryEmail,
        custodians: [
          { email: custodianEmails[0], password },
          { email: custodianEmails[1], password: 'wrong-password' },
        ],
      },
      secondaryPassword,
      recovery,
    ),
    'invalid custodian cannot activate secondary',
  );
  check(
    (await pool.query('SELECT state FROM admin_user WHERE id=$1', [secondary.id])).rows[0].state ===
      'LOCKED',
    'secondary stays locked after invalid activation',
  );
  const activateId = randomUUID();
  await ceremony.activateSecondary(
    { ...ceremonyInput(activateId), secondEmail: secondaryEmail },
    secondaryPassword,
    recovery,
  );
  await denied(
    ceremony.activateSecondary(
      { ...ceremonyInput(activateId), secondEmail: secondaryEmail },
      secondaryPassword,
      recovery,
    ),
    'activation replay denied',
  );
  check(
    (await pool.query('SELECT state FROM admin_user WHERE id=$1', [secondary.id])).rows[0].state ===
      'ACTIVE',
    'second administrator activates only after two recovery approvals',
  );

  const policies = new GpsPolicyService(pool);
  const app = createApp({
    readinessProbe: async () => true,
    restoreGate: async () => gateOpen,
    logLevel: 'silent',
    adminAuth: auth,
    devices: new DeviceRepository(pool),
    mdm: new FakeMdmProvider(),
    gpsPolicies: policies,
    gpsAdministration: new GpsAdministrationService(pool, policies),
    secureCookie: false,
  });
  const login = async (email, secret) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email, password: secret },
    });
    check(response.statusCode === 200, 'administrator login');
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      csrf: response.json().csrf_token,
    };
  };
  const primarySession = await login(primaryEmail, password);
  const secondarySession = await login(secondaryEmail, secondaryPassword);
  const admin = (session, method, path, payload) =>
    app.inject({
      method,
      url: path,
      headers: { cookie: session.cookie, origin, 'x-csrf-token': session.csrf },
      ...(payload === undefined ? {} : { payload }),
    });
  check(
    (await admin(primarySession, 'GET', '/v1/admin/gps-policies')).statusCode === 200,
    'primary can read policies',
  );
  check(
    (await admin(secondarySession, 'GET', '/v1/admin/gps-capabilities')).json().capabilities
      .length === INITIAL_GPS_CAPABILITIES.length,
    'secondary capabilities visible through API',
  );
  check(
    (await admin(primarySession, 'GET', '/v1/admin/gps-devices')).json().items.length === 0,
    'tenant data denied before explicit grant',
  );
  const draft = await admin(primarySession, 'POST', '/v1/admin/devices', {
    display_label: 'Synthetic first tenant handset',
  });
  check(draft.statusCode === 201, 'authorized device draft created without real MDM');
  check(
    (await admin(primarySession, 'GET', '/v1/admin/devices')).json().items.length === 1,
    'authorized synthetic enrollment inventory visible',
  );
  const unprivilegedId = randomUUID();
  await pool.query(
    "INSERT INTO admin_user(id,email_normalized,password_hash,state) SELECT $1,'unprivileged@example.invalid',password_hash,'ACTIVE' FROM admin_user WHERE id=$2",
    [unprivilegedId, primaryId],
  );
  const unprivileged = await login('unprivileged@example.invalid', password);
  check(
    (await admin(unprivileged, 'POST', '/v1/admin/devices', { display_label: 'Denied handset' }))
      .statusCode === 403,
    'admin without installation capability cannot create draft',
  );
  check(
    (await admin(unprivileged, 'GET', '/v1/admin/devices')).statusCode === 403,
    'admin without installation capability cannot read inventory',
  );
  check(
    (await admin(unprivileged, 'GET', '/v1/admin/gps-policies')).statusCode === 403,
    'admin without GPS capability cannot read policies',
  );

  const grantId = randomUUID();
  const body = {
    request_id: grantId,
    target_admin_id: primaryId,
    tenant_id: 'synthetic',
    action: 'GRANT',
    reason: 'Approved first synthetic tenant',
  };
  const proposed = await admin(
    primarySession,
    'POST',
    '/v1/admin/gps-tenant-grants/proposals',
    body,
  );
  check(proposed.statusCode === 201, 'pending fake binding anchors tenant proposal');
  check(
    (await admin(primarySession, 'POST', `/v1/admin/gps-tenant-grants/${grantId}/approve`, {}))
      .statusCode === 403,
    'proposer cannot self approve',
  );
  const approved = await admin(
    secondarySession,
    'POST',
    `/v1/admin/gps-tenant-grants/${grantId}/approve`,
    {},
  );
  check(approved.statusCode === 200, 'independent administrator approves tenant access');
  check(
    (await admin(secondarySession, 'POST', `/v1/admin/gps-tenant-grants/${grantId}/approve`, {}))
      .statusCode === 200,
    'approval replay is idempotent',
  );
  check(
    (
      await admin(primarySession, 'POST', '/v1/admin/gps-tenant-grants/proposals', {
        ...body,
        action: 'REVOKE',
      })
    ).statusCode === 409,
    'conflicting replay rejected',
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    check(
      (
        await pool.query(
          `SELECT 1 FROM ${table} WHERE admin_id=$1 AND tenant_id='synthetic' AND revoked_at IS NULL`,
          [primaryId],
        )
      ).rowCount === 1,
      `${table} granted to exact tenant`,
    );
  await pool.query("UPDATE geops_device SET status='ACTIVE' WHERE id=$1", [draft.json().id]);
  await pool.query("UPDATE mdm_binding SET state='ACTIVE' WHERE id=$1", [
    draft.json().mdm_binding_id,
  ]);
  check(
    (await admin(primarySession, 'GET', '/v1/admin/gps-devices')).json().items.length === 1,
    'primary sees only authorized tenant device',
  );
  check(
    (await admin(secondarySession, 'GET', '/v1/admin/gps-devices')).json().items.length === 0,
    'secondary capability does not imply tenant data access',
  );

  const revokeId = randomUUID();
  check(
    (
      await admin(secondarySession, 'POST', '/v1/admin/gps-tenant-grants/proposals', {
        ...body,
        request_id: revokeId,
        action: 'REVOKE',
      })
    ).statusCode === 201,
    'tenant revocation proposed',
  );
  check(
    (await admin(primarySession, 'POST', `/v1/admin/gps-tenant-grants/${revokeId}/approve`, {}))
      .statusCode === 200,
    'tenant revocation approved by other administrator',
  );
  check(
    (await admin(primarySession, 'GET', '/v1/admin/gps-devices')).json().items.length === 0,
    'tenant data hidden immediately after revocation',
  );
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action IN ('gps.tenant-grant.propose','gps.tenant-grant.approve') AND outcome='success'",
      )
    ).rows[0].n === 4,
    'tenant proposal and approval actions audited',
  );

  await ceremony.revokeSecondary({ ...ceremonyInput(), secondEmail: secondaryEmail });
  check(
    (await pool.query('SELECT state FROM admin_user WHERE id=$1', [secondary.id])).rows[0].state ===
      'REVOKED',
    'secondary account revoked',
  );
  check(
    (await admin(secondarySession, 'GET', '/v1/admin/gps-capabilities')).statusCode === 401,
    'secondary session invalid after revocation',
  );
  await assert.rejects(recovery.request(secondary.id));
  checks++;
  check(
    (
      await pool.query(
        "SELECT 1 FROM audit_event WHERE action='gps.capabilities.bootstrap.revoke-secondary' AND outcome='success'",
      )
    ).rowCount === 1,
    'secondary revocation audited',
  );
  gateOpen = false;
  await denied(
    ceremony.addSecondary({ ...ceremonyInput(), secondEmail: 'third@example.invalid' }),
    'closed gate denies further administrative bootstrap',
  );
  await app.close();
  console.log(`Administrative tenant bootstrap integration: ${checks} checks PASS`);
} finally {
  await pool.end();
}
