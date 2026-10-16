import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { enrollmentProofBytes } from '@geops/api-contracts';
import { loadConfig } from '../dist/config.js';
import { applyMigrations } from '../dist/db/migration-manager.js';
import { createPool } from '../dist/db/pool.js';
import { AdminAuthService } from '../dist/admin-auth/service.js';
import { DeviceRepository } from '../dist/device-identity/repository.js';
import { EnrollmentService } from '../dist/device-identity/enrollment.js';

let step = 'setup';
const b64 = (value) => Buffer.from(value).toString('base64url');
const sha = (value) => createHash('sha256').update(value).digest();
const pair = () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: keys.privateKey,
    spki: keys.publicKey.export({ type: 'spki', format: 'der' }),
  };
};
const failCode = async (promise, code) => {
  await assert.rejects(promise, (error) => error?.code === code);
};

async function main() {
  const config = loadConfig(process.env);
  const name = process.env.GEOPS_TEST_DB;
  if (!/^geops_verify_[0-9]+$/.test(name ?? '')) throw new Error('Invalid synthetic DB');
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  try {
    await applyMigrations(pool);
    const auth = new AdminAuthService(pool, {
      sessionKey: config.adminSessionKey,
      csrfKey: config.adminCsrfKey,
      allowedOrigins: config.allowedOrigins,
    });
    const adminId = await auth.bootstrap(
      'edge@example.test',
      randomBytes(24).toString('base64url'),
    );
    const repo = new DeviceRepository(pool);
    let current = Date.now();
    const enroll = new EnrollmentService(
      pool,
      repo,
      config.invitationHmacKey,
      undefined,
      () => new Date(current),
    );
    const fixture = async () => {
      const device = await repo.createDraft('Synthetic edge device');
      const invitation = await enroll.issueInvitation(
        device.id,
        device.mdm_binding_id,
        'supervised_qr',
        adminId,
      );
      const key = pair();
      const clientNonce = b64(randomBytes(16));
      const input = {
        invitation_id: invitation.invitation_id,
        invitation_secret: invitation.invitation_secret,
        geops_device_id: device.id,
        mdm_device_id: `fake-${device.id}`,
        public_key_spki: b64(key.spki),
        client_nonce: clientNonce,
      };
      return { device, invitation, key, input };
    };
    step = 'invitation-expiry-boundary';
    const late = await fixture();
    current += 600_000;
    await failCode(enroll.claim(late.input), 'invitation_expired');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_session')).rows[0].n, 0);
    const before = await fixture();
    current += 599_000;
    const within = await enroll.claim(before.input);
    assert.ok(within.claim_id);
    await failCode(enroll.claim(before.input), 'invitation_consumed');
    step = 'reissue-cancels-claim';
    const renewed = await enroll.issueInvitation(
      before.device.id,
      before.device.mdm_binding_id,
      'supervised_qr',
      adminId,
    );
    assert.notEqual(renewed.invitation_id, before.invitation.invitation_id);
    await failCode(enroll.claim(before.input), 'invitation_consumed');
    await failCode(
      enroll.prove(within.claim_id, within.challenge_id, b64(randomBytes(72))),
      'claim_consumed',
    );
    assert.equal(
      (await pool.query('SELECT status FROM enrollment_claim WHERE id=$1', [within.claim_id]))
        .rows[0].status,
      'CANCELLED',
    );
    step = 'concurrent-claim';
    const race = await fixture();
    const other = pair();
    const otherInput = {
      ...race.input,
      public_key_spki: b64(other.spki),
      client_nonce: b64(randomBytes(16)),
    };
    const results = await Promise.allSettled([enroll.claim(race.input), enroll.claim(otherInput)]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(
      results.filter(
        (item) => item.status === 'rejected' && item.reason?.code === 'invitation_consumed',
      ).length,
      1,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM enrollment_claim WHERE invitation_id=$1', [
          race.invitation.invitation_id,
        ])
      ).rows[0].n,
      1,
    );
    step = 'state-and-binding-uniqueness';
    const firstBinding = await repo.createDraft('Synthetic binding first');
    const duplicateBinding = await repo.createDraft('Synthetic binding second');
    await pool.query(
      "UPDATE mdm_binding SET state='ACTIVE',mdm_device_id='synthetic-shared-mdm' WHERE id=$1",
      [firstBinding.mdm_binding_id],
    );
    await assert.rejects(
      pool.query(
        "UPDATE mdm_binding SET state='ACTIVE',mdm_device_id='synthetic-shared-mdm' WHERE id=$1",
        [duplicateBinding.mdm_binding_id],
      ),
      (error) => error?.code === '23505',
    );
    await pool.query("UPDATE geops_device SET status='SUSPENDED' WHERE id=$1", [firstBinding.id]);
    await failCode(
      enroll.issueInvitation(
        firstBinding.id,
        firstBinding.mdm_binding_id,
        'supervised_qr',
        adminId,
      ),
      'device_state',
    );
    step = 'binding-impersonation';
    const mismatch = await fixture();
    await failCode(
      enroll.claim({ ...mismatch.input, mdm_device_id: 'fake-other-device' }),
      'binding_mismatch',
    );
    step = 'invalid-attestation';
    const claim = await enroll.claim(mismatch.input);
    const bytes = enrollmentProofBytes({
      claimId: claim.claim_id,
      challengeId: claim.challenge_id,
      challenge: claim.challenge,
      geopsDeviceId: mismatch.device.id,
      mdmDeviceId: mismatch.input.mdm_device_id,
      publicKeySpkiSha256: b64(sha(mismatch.key.spki)),
      clientNonce: mismatch.input.client_nonce,
    });
    const validSignature = b64(sign('sha256', bytes, mismatch.key.privateKey));
    await failCode(
      enroll.prove(claim.claim_id, claim.challenge_id, validSignature, ['invalid-synthetic-chain']),
      'invalid_proof',
    );
    const state = await pool.query('SELECT status FROM enrollment_claim WHERE id=$1', [
      claim.claim_id,
    ]);
    assert.equal(state.rows[0].status, 'CANCELLED');
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM device_key WHERE geops_device_id=$1', [
          mismatch.device.id,
        ])
      ).rows[0].n,
      0,
    );
    step = 'invalid-signature';
    const bad = await fixture();
    const badClaim = await enroll.claim(bad.input);
    await failCode(
      enroll.prove(badClaim.claim_id, badClaim.challenge_id, b64(randomBytes(72))),
      'invalid_proof',
    );
    assert.equal(
      (await pool.query('SELECT status FROM enrollment_claim WHERE id=$1', [badClaim.claim_id]))
        .rows[0].status,
      'CANCELLED',
    );
    console.log(
      'GEOPS synthetic identity edge: PASS invite boundary, reissue cancellation, concurrent claim, duplicate MDM binding, invalid state, replay, binding mismatch, invalid attestation, invalid signature, no key activation',
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error(`GEOPS synthetic identity edge failed at step=${step}; details withheld`);
  process.exitCode = 1;
});
