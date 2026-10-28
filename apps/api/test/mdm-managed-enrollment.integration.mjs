// Run only against a fresh disposable geops_verify_* PostGIS database.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { EnrollmentService } from '../src/device-identity/enrollment.ts';
import { enrollmentBytes } from '../src/device-identity/crypto.ts';
import { MdmInventoryService } from '../src/mdm/inventory.ts';
import { resolveGpsDeviceScope } from '../src/gps-device-scope.ts';
import { GpsDeviceConfigService } from '../src/gps-device-config.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url });
try {
  assert.equal((await applyMigrations(pool)).length, 32);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const admin = await auth.bootstrap('managed@test.invalid', 'synthetic-password-12345678');
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.installation.manage',$1,'Synthetic managed enrollment')",
    [admin],
  );
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [admin, randomUUID()],
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,'Synthetic managed enrollment')`,
      [admin],
    );
  const repository = new DeviceRepository(pool);
  const draft = await repository.createDraft('Poco MDM', admin);
  const mdmId = '9007199254740995123';
  await pool.query(
    `INSERT INTO mdm_inventory_device(provider,region,customer_id,mdm_device_id,platform,
       status,removed,last_seen_at) VALUES('manageengine','com','12345',$1,'android','managed',false,now())`,
    [mdmId],
  );
  const inventory = new MdmInventoryService(
    pool,
    {
      listDevices: async () => {
        throw new Error('not used');
      },
      getDevice: async () => null,
    },
    { region: 'com', customerId: '12345' },
  );
  const enrollment = new EnrollmentService(pool, repository, Buffer.alloc(32, 42));
  await assert.rejects(
    enrollment.issueInvitation(draft.id, draft.mdm_binding_id, 'managed_configuration', admin),
    { code: 'mdm_device_unavailable' },
  );
  await inventory.link(draft.id, mdmId, admin, randomUUID());
  const invitation = await enrollment.issueInvitation(
    draft.id,
    draft.mdm_binding_id,
    'managed_configuration',
    admin,
  );
  assert.equal(invitation.managed_configuration?.mdm_device_id, mdmId);
  assert.equal(invitation.managed_configuration?.invitation_secret, invitation.invitation_secret);
  assert.ok(Date.parse(invitation.expires_at) > Date.now() + 23 * 3_600_000);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = Buffer.from(key.publicKey.export({ format: 'der', type: 'spki' }));
  const clientNonce = randomBytes(16).toString('base64url');
  await assert.rejects(
    enrollment.claim({
      invitation_id: invitation.invitation_id,
      invitation_secret: invitation.invitation_secret,
      geops_device_id: draft.id,
      mdm_device_id: '9999999',
      public_key_spki: spki.toString('base64url'),
      client_nonce: clientNonce,
    }),
    { code: 'binding_mismatch' },
  );
  const claim = await enrollment.claim({
    invitation_id: invitation.invitation_id,
    invitation_secret: invitation.invitation_secret,
    geops_device_id: draft.id,
    mdm_device_id: mdmId,
    public_key_spki: spki.toString('base64url'),
    client_nonce: clientNonce,
  });
  const proof = enrollmentBytes({
    claimId: claim.claim_id,
    challengeId: claim.challenge_id,
    challenge: claim.challenge,
    deviceId: draft.id,
    mdmDeviceId: mdmId,
    spki,
    nonce: clientNonce,
  });
  const activated = await enrollment.prove(
    claim.claim_id,
    claim.challenge_id,
    sign('sha256', proof, key.privateKey).toString('base64url'),
  );
  assert.equal(activated.status, 'ACTIVE');
  assert.ok(activated.key_id && activated.installation_id);
  assert.equal(
    (await pool.query('SELECT status FROM geops_device WHERE id=$1', [draft.id])).rows[0].status,
    'ACTIVE',
  );
  assert.equal(
    (
      await pool.query('SELECT status FROM device_invitation WHERE id=$1', [
        invitation.invitation_id,
      ])
    ).rows[0].status,
    'CONSUMED',
  );
  const db = await pool.connect();
  try {
    const scope = await resolveGpsDeviceScope(db, draft.id, activated.installation_id);
    assert.equal(scope.tenantId, 'synthetic');
    assert.equal(scope.bindingId, null);
  } finally {
    db.release();
  }
  await assert.rejects(
    enrollment.claim({
      invitation_id: invitation.invitation_id,
      invitation_secret: invitation.invitation_secret,
      geops_device_id: draft.id,
      mdm_device_id: mdmId,
      public_key_spki: spki.toString('base64url'),
      client_nonce: clientNonce,
    }),
    { code: 'invitation_consumed' },
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM gps_mdm_continuous_authorization WHERE device_id=$1 AND revoked_at IS NULL',
        [draft.id],
      )
    ).rows[0].n,
    1,
  );
  const config = new GpsDeviceConfigService(pool);
  const principal = { deviceId: draft.id, keyId: activated.key_id, sessionId: randomUUID() };
  const v2 = await config.snapshot(principal, randomUUID(), 2);
  assert.equal(v2.active, true);
  assert.equal(v2.policy.mdm_continuous, true);
  assert.equal(v2.policy.capture_interval_s, 60);
  assert.equal(v2.policy.sync_interval_s, 300);
  assert.ok(v2.window_instances.length >= 7);
  assert.ok(Date.parse(v2.offline_not_after) > Date.now() + 11 * 3_600_000);
  const v1 = await config.snapshot(principal, randomUUID(), 1);
  assert.equal(v1.active, false);

  const second = await repository.createDraft('Poco MDM revocado', admin);
  const secondMdm = '9007199254740995124';
  await pool.query(
    `INSERT INTO mdm_inventory_device(provider,region,customer_id,mdm_device_id,platform,
       status,removed,last_seen_at) VALUES('manageengine','com','12345',$1,'android','managed',false,now())`,
    [secondMdm],
  );
  await inventory.link(second.id, secondMdm, admin, randomUUID());
  const pending = await enrollment.issueInvitation(
    second.id,
    second.mdm_binding_id,
    'managed_configuration',
    admin,
  );
  const secondNonce = randomBytes(16).toString('base64url');
  const secondClaim = await enrollment.claim({
    invitation_id: pending.invitation_id,
    invitation_secret: pending.invitation_secret,
    geops_device_id: second.id,
    mdm_device_id: secondMdm,
    public_key_spki: spki.toString('base64url'),
    client_nonce: secondNonce,
  });
  await inventory.unlink(second.id, admin, randomUUID());
  const secondProof = enrollmentBytes({
    claimId: secondClaim.claim_id,
    challengeId: secondClaim.challenge_id,
    challenge: secondClaim.challenge,
    deviceId: second.id,
    mdmDeviceId: secondMdm,
    spki,
    nonce: secondNonce,
  });
  await assert.rejects(
    enrollment.prove(
      secondClaim.claim_id,
      secondClaim.challenge_id,
      sign('sha256', secondProof, key.privateKey).toString('base64url'),
    ),
    { code: 'mdm_device_unavailable' },
  );
  assert.equal(
    (await pool.query('SELECT status FROM geops_device WHERE id=$1', [second.id])).rows[0].status,
    'INVITED',
  );
} finally {
  await pool.end();
}
