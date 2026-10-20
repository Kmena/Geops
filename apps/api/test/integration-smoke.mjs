import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createHash } from 'node:crypto';
import { AdminAuthService } from '../dist/admin-auth/service.js';
import { SupervisedRecoveryService } from '../dist/admin-auth/supervised-recovery.js';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { applyMigrations, checkReadiness } from '../dist/db/migration-manager.js';
import { createPool } from '../dist/db/pool.js';
import { EnrollmentService } from '../dist/device-identity/enrollment.js';
import { DeviceLifecycleService } from '../dist/device-identity/lifecycle.js';
import { DeviceRepository } from '../dist/device-identity/repository.js';
import { DeviceSessionService } from '../dist/device-identity/session.js';
import { EncryptedGrantStore, SyntheticTokenManager } from '../dist/mdm/grants.js';
import { FakeMdmProvider } from '../dist/mdm/provider.js';
import {
  enrollmentProofBytes,
  requestProofBytes,
  rotationProofBytes,
  sessionProofBytes,
} from '@geops/api-contracts';

let step = 'setup';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha = (value) => createHash('sha256').update(value).digest();
const pair = () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: keys.privateKey,
    spki: keys.publicKey.export({ format: 'der', type: 'spki' }),
  };
};
const signature = (key, bytes) => b64(sign('sha256', bytes, key));

async function main() {
  const config = loadConfig(process.env);
  const url = new URL(config.databaseUrl);
  const testDb = process.env.GEOPS_TEST_DB;
  if (!/^geops_verify_[0-9]+$/.test(testDb ?? '')) throw new Error('Invalid synthetic test DB');
  url.pathname = `/${testDb}`;
  const pool = createPool(url.toString());
  const auth = new AdminAuthService(pool, {
    sessionKey: config.adminSessionKey,
    csrfKey: config.adminCsrfKey,
    allowedOrigins: config.allowedOrigins,
  });
  const devices = new DeviceRepository(pool);
  const enroll = new EnrollmentService(pool, devices, config.invitationHmacKey);
  const sessions = new DeviceSessionService(pool);
  const lifecycle = new DeviceLifecycleService(pool, devices);
  const mdm = new FakeMdmProvider();
  const app = createApp({
    readinessProbe: () => checkReadiness(pool),
    logLevel: 'silent',
    adminAuth: auth,
    devices,
    mdm,
    enrollment: enroll,
    deviceSessions: sessions,
    deviceLifecycle: lifecycle,
    secureCookie: false,
  });
  const origin = 'http://localhost:3501';
  const json = (payload) => JSON.stringify(payload);
  const call = async (method, path, payload, headers = {}) =>
    app.inject({
      method,
      url: path,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload: json(payload) }),
    });
  try {
    step = 'migrations';
    await applyMigrations(pool);
    assert.equal(await checkReadiness(pool), true);
    step = 'bootstrap';
    const password = randomBytes(24).toString('base64url');
    await auth.bootstrap('owner@example.test', password);
    await assert.rejects(auth.bootstrap('other@example.test', password), {
      code: 'bootstrap_closed',
    });
    step = 'login';
    const login = await call(
      'POST',
      '/v1/admin/auth/sessions',
      { email: 'owner@example.test', password },
      { origin },
    );
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    const csrf = login.json().csrf_token;
    const adminId = login.json().admin_id;
    assert.equal((await call('GET', '/v1/admin/auth/me', undefined, { cookie })).statusCode, 200);
    assert.equal(
      (
        await call(
          'POST',
          '/v1/admin/devices',
          { display_label: 'Synthetic handset' },
          { origin, cookie },
        )
      ).statusCode,
      403,
    );
    assert.ok(login.headers['set-cookie'].includes('HttpOnly'));
    assert.ok(login.headers['set-cookie'].includes('SameSite=Lax'));
    const foreignOrigin = await call(
      'POST',
      '/v1/admin/auth/sessions',
      { email: 'owner@example.test', password },
      { origin: 'http://invalid.example.test' },
    );
    assert.equal(foreignOrigin.statusCode, 403);
    const extraLogin = await call(
      'POST',
      '/v1/admin/auth/sessions',
      { email: 'owner@example.test', password },
      { origin },
    );
    assert.equal(extraLogin.statusCode, 200);
    const extraCookie = extraLogin.headers['set-cookie'].split(';')[0];
    const extraCsrf = extraLogin.json().csrf_token;
    const logout = await call('DELETE', '/v1/admin/auth/sessions/current', undefined, {
      origin,
      cookie: extraCookie,
      'x-csrf-token': extraCsrf,
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(
      (await call('GET', '/v1/admin/auth/me', undefined, { cookie: extraCookie })).statusCode,
      401,
    );
    // Explicit synthetic fixture: an authenticated administrator alone cannot create a device.
    await pool.query(
      "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.installation.manage',$1,$2)",
      [adminId, 'Synthetic SPEC-01 integration fixture'],
    );
    step = 'device';
    const created = await call(
      'POST',
      '/v1/admin/devices',
      { display_label: 'Synthetic handset' },
      { origin, cookie, 'x-csrf-token': csrf },
    );
    assert.equal(created.statusCode, 201);
    const device = created.json();
    const fakePage = await call('GET', '/v1/admin/mdm/devices', undefined, { cookie });
    assert.equal(fakePage.statusCode, 200);
    assert.deepEqual(fakePage.json().items, []);
    assert.equal(fakePage.json().source, 'fake');
    step = 'invitation';
    const invitation = await call(
      'POST',
      `/v1/admin/devices/${device.id}/invitations`,
      { mdm_binding_id: device.mdm_binding_id, delivery_mode: 'supervised_qr' },
      { origin, cookie, 'x-csrf-token': csrf },
    );
    assert.equal(invitation.statusCode, 201);
    const invitationData = invitation.json();
    assert.equal(Buffer.from(invitationData.invitation_secret, 'base64url').length, 32);
    const old = pair();
    const nonce = b64(randomBytes(16));
    const claimBody = {
      invitation_id: invitationData.invitation_id,
      invitation_secret: invitationData.invitation_secret,
      geops_device_id: device.id,
      mdm_device_id: `fake-${device.id}`,
      public_key_spki: b64(old.spki),
      client_nonce: nonce,
    };
    const claim = await call('POST', '/v1/device/enrollment/claims', claimBody);
    assert.equal(claim.statusCode, 201);
    assert.equal((await call('POST', '/v1/device/enrollment/claims', claimBody)).statusCode, 409);
    const challenge = claim.json();
    step = 'proof';
    const proofBytes = enrollmentProofBytes({
      claimId: challenge.claim_id,
      challengeId: challenge.challenge_id,
      challenge: challenge.challenge,
      geopsDeviceId: device.id,
      mdmDeviceId: claimBody.mdm_device_id,
      publicKeySpkiSha256: b64(sha(old.spki)),
      clientNonce: nonce,
    });
    const proof = await call('POST', `/v1/device/enrollment/claims/${challenge.claim_id}/proof`, {
      challenge_id: challenge.challenge_id,
      signature: signature(old.privateKey, proofBytes),
    });
    assert.equal(proof.statusCode, 200);
    assert.equal(
      (
        await call('POST', `/v1/device/enrollment/claims/${challenge.claim_id}/proof`, {
          challenge_id: challenge.challenge_id,
          signature: signature(old.privateKey, proofBytes),
        })
      ).statusCode,
      409,
    );
    const pairing = proof.json().pairing_code;
    step = 'activation-guard';
    const missingEvidence = await call(
      'POST',
      `/v1/admin/devices/${device.id}/activate`,
      {
        claim_id: challenge.claim_id,
        pairing_code: pairing,
        mdm_verification_method: 'manual_two_traits',
        evidence_ref: randomUUID(),
      },
      { origin, cookie, 'x-csrf-token': csrf },
    );
    assert.equal(missingEvidence.statusCode, 403);
    const evidence = await call(
      'POST',
      `/v1/admin/devices/${device.id}/synthetic-evidence`,
      { claim_id: challenge.claim_id, physical_confirmed: true, attestation_exception: true },
      { origin, cookie, 'x-csrf-token': csrf },
    );
    assert.equal(evidence.statusCode, 200);
    const evidenceId = evidence.json().evidence_ref;
    await pool.query("UPDATE synthetic_mdm_evidence SET tenant='other' WHERE id=$1", [evidenceId]);
    assert.equal(
      (
        await call(
          'POST',
          `/v1/admin/devices/${device.id}/activate`,
          {
            claim_id: challenge.claim_id,
            pairing_code: pairing,
            mdm_verification_method: 'manual_two_traits',
            evidence_ref: evidenceId,
          },
          { origin, cookie, 'x-csrf-token': csrf },
        )
      ).statusCode,
      403,
    );
    await pool.query(
      "UPDATE synthetic_mdm_evidence SET tenant='synthetic',physical_confirmed=false WHERE id=$1",
      [evidenceId],
    );
    assert.equal(
      (
        await call(
          'POST',
          `/v1/admin/devices/${device.id}/activate`,
          {
            claim_id: challenge.claim_id,
            pairing_code: pairing,
            mdm_verification_method: 'manual_two_traits',
            evidence_ref: evidenceId,
          },
          { origin, cookie, 'x-csrf-token': csrf },
        )
      ).statusCode,
      403,
    );
    await pool.query('UPDATE synthetic_mdm_evidence SET physical_confirmed=true WHERE id=$1', [
      evidenceId,
    ]);
    const wrongPairing = `${pairing.slice(0, 7)}${pairing[7] === '0' ? '1' : '0'}`;
    assert.equal(
      (
        await call(
          'POST',
          `/v1/admin/devices/${device.id}/activate`,
          {
            claim_id: challenge.claim_id,
            pairing_code: wrongPairing,
            mdm_verification_method: 'manual_two_traits',
            evidence_ref: evidenceId,
          },
          { origin, cookie, 'x-csrf-token': csrf },
        )
      ).statusCode,
      403,
    );
    const activated = await call(
      'POST',
      `/v1/admin/devices/${device.id}/activate`,
      {
        claim_id: challenge.claim_id,
        pairing_code: pairing,
        mdm_verification_method: 'manual_two_traits',
        evidence_ref: evidence.json().evidence_ref,
      },
      { origin, cookie, 'x-csrf-token': csrf },
    );
    assert.equal(activated.statusCode, 200);
    const keyId = activated.json().key_id;
    step = 'session';
    const sessionChallenge = await call('POST', '/v1/device/sessions/challenge', {
      geops_device_id: device.id,
      key_id: keyId,
    });
    assert.equal(sessionChallenge.statusCode, 200);
    const sc = sessionChallenge.json();
    const sess = await call('POST', '/v1/device/sessions', {
      geops_device_id: device.id,
      key_id: keyId,
      challenge_id: sc.challenge_id,
      signature: signature(
        old.privateKey,
        sessionProofBytes(sc.challenge_id, sc.challenge, keyId, device.id),
      ),
    });
    assert.equal(sess.statusCode, 201);
    const token = sess.json().access_token;
    const expiredChallenge = await call('POST', '/v1/device/sessions/challenge', {
      geops_device_id: device.id,
      key_id: keyId,
    });
    assert.equal(expiredChallenge.statusCode, 200);
    const ec = expiredChallenge.json();
    await pool.query('UPDATE device_challenge SET expires_at=now() WHERE id=$1', [ec.challenge_id]);
    assert.equal(
      (
        await call('POST', '/v1/device/sessions', {
          geops_device_id: device.id,
          key_id: keyId,
          challenge_id: ec.challenge_id,
          signature: signature(
            old.privateKey,
            sessionProofBytes(ec.challenge_id, ec.challenge, keyId, device.id),
          ),
        })
      ).statusCode,
      410,
    );
    const expiredSessionChallenge = await call('POST', '/v1/device/sessions/challenge', {
      geops_device_id: device.id,
      key_id: keyId,
    });
    const es = expiredSessionChallenge.json();
    const expiredSession = await call('POST', '/v1/device/sessions', {
      geops_device_id: device.id,
      key_id: keyId,
      challenge_id: es.challenge_id,
      signature: signature(
        old.privateKey,
        sessionProofBytes(es.challenge_id, es.challenge, keyId, device.id),
      ),
    });
    assert.equal(expiredSession.statusCode, 201);
    await pool.query('UPDATE device_session SET expires_at=now() WHERE token_hash=$1', [
      sha(expiredSession.json().access_token),
    ]);
    assert.equal(
      (
        await call('POST', '/v1/device/sessions', {
          geops_device_id: device.id,
          key_id: keyId,
          challenge_id: sc.challenge_id,
          signature: signature(
            old.privateKey,
            sessionProofBytes(sc.challenge_id, sc.challenge, keyId, device.id),
          ),
        })
      ).statusCode,
      409,
    );
    const pop = (
      method,
      path,
      payload,
      tokenValue,
      id,
      privateKey,
      nonceValue = b64(randomBytes(16)),
      atMs = Date.now(),
    ) => {
      const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(json(payload));
      const timestamp = String(Math.floor(atMs / 1000));
      const bytes = requestProofBytes({
        method,
        absolutePath: path,
        bodySha256: b64(sha(body)),
        tokenSha256: b64(sha(tokenValue)),
        timestamp,
        nonce: nonceValue,
        keyId: id,
      });
      return {
        authorization: `Bearer ${tokenValue}`,
        'x-geops-key-id': id,
        'x-geops-timestamp': timestamp,
        'x-geops-nonce': nonceValue,
        'x-geops-signature': signature(privateKey, bytes),
      };
    };
    step = 'clock-boundaries';
    let virtualNow = Date.now();
    const clockedSessions = new DeviceSessionService(pool, () => new Date(virtualNow));
    const nearChallenge = await clockedSessions.challenge(device.id, keyId);
    virtualNow += 119_000;
    const nearSession = await clockedSessions.create(
      device.id,
      keyId,
      nearChallenge.challenge_id,
      signature(
        old.privateKey,
        sessionProofBytes(nearChallenge.challenge_id, nearChallenge.challenge, keyId, device.id),
      ),
    );
    const issuedAt = virtualNow;
    const atBoundary = await clockedSessions.challenge(device.id, keyId);
    virtualNow += 120_000;
    await assert.rejects(
      clockedSessions.create(
        device.id,
        keyId,
        atBoundary.challenge_id,
        signature(
          old.privateKey,
          sessionProofBytes(atBoundary.challenge_id, atBoundary.challenge, keyId, device.id),
        ),
      ),
      { code: 'challenge_expired' },
    );
    const rotatePath = '/v1/device/keys/rotate/challenge';
    virtualNow = issuedAt + 899_000;
    const nearHeaders = pop(
      'POST',
      rotatePath,
      undefined,
      nearSession.access_token,
      keyId,
      old.privateKey,
      b64(randomBytes(16)),
      virtualNow,
    );
    await clockedSessions.verifyRequest(
      { method: 'POST', url: rotatePath, headers: nearHeaders, id: randomUUID() },
      Buffer.alloc(0),
    );
    virtualNow = issuedAt + 900_000;
    const boundaryHeaders = pop(
      'POST',
      rotatePath,
      undefined,
      nearSession.access_token,
      keyId,
      old.privateKey,
      b64(randomBytes(16)),
      virtualNow,
    );
    await assert.rejects(
      clockedSessions.verifyRequest(
        { method: 'POST', url: rotatePath, headers: boundaryHeaders, id: randomUUID() },
        Buffer.alloc(0),
      ),
      { code: 'invalid_session' },
    );
    step = 'pop';
    const headers = pop('POST', rotatePath, undefined, token, keyId, old.privateKey);
    assert.equal((await call('POST', `${rotatePath}?x=1`, undefined, headers)).statusCode, 400);
    assert.equal(
      (await call('POST', rotatePath, undefined, { authorization: `Bearer ${token}` })).statusCode,
      401,
    );
    const stale = {
      ...pop('POST', rotatePath, undefined, token, keyId, old.privateKey),
      'x-geops-timestamp': String(Math.floor(Date.now() / 1000) - 301),
    };
    assert.equal((await call('POST', rotatePath, undefined, stale)).statusCode, 401);
    const wrongKey = {
      ...pop('POST', rotatePath, undefined, token, keyId, old.privateKey),
      'x-geops-key-id': randomUUID(),
    };
    assert.equal((await call('POST', rotatePath, undefined, wrongKey)).statusCode, 401);
    const concurrentPop = await Promise.all([
      call('POST', rotatePath, undefined, headers),
      call('POST', rotatePath, undefined, headers),
    ]);
    assert.deepEqual(concurrentPop.map((response) => response.statusCode).sort(), [200, 409]);
    const rotateChallenge = concurrentPop.find((response) => response.statusCode === 200);
    const alteredBody = { synthetic: 'changed' };
    const signedForOtherBody = pop(
      'POST',
      '/v1/device/keys/rotate',
      { synthetic: 'original' },
      token,
      keyId,
      old.privateKey,
    );
    assert.equal(
      (await call('POST', '/v1/device/keys/rotate', alteredBody, signedForOtherBody)).statusCode,
      401,
    );
    const expiredTokenHeaders = pop(
      'POST',
      rotatePath,
      undefined,
      expiredSession.json().access_token,
      keyId,
      old.privateKey,
    );
    assert.equal((await call('POST', rotatePath, undefined, expiredTokenHeaders)).statusCode, 401);
    step = 'rotation';
    const newPair = pair();
    const rc = rotateChallenge.json();
    await lifecycle.recordSyntheticRotationException(
      rc.challenge_id,
      adminId,
      'Synthetic security approval for this rotation',
    );
    const rb = rotationProofBytes(
      rc.challenge_id,
      rc.challenge,
      device.id,
      keyId,
      b64(sha(newPair.spki)),
    );
    const rotateBody = {
      challenge_id: rc.challenge_id,
      new_public_key_spki: b64(newPair.spki),
      old_signature: signature(old.privateKey, rb),
      new_signature: signature(newPair.privateKey, rb),
    };
    const missingOld = { ...rotateBody };
    delete missingOld.old_signature;
    assert.equal(
      (
        await call(
          'POST',
          '/v1/device/keys/rotate',
          missingOld,
          pop('POST', '/v1/device/keys/rotate', missingOld, token, keyId, old.privateKey),
        )
      ).statusCode,
      400,
    );
    const invalidAttestation = { ...rotateBody, attestation_chain: ['invalid-synthetic-chain'] };
    assert.equal(
      (
        await call(
          'POST',
          '/v1/device/keys/rotate',
          invalidAttestation,
          pop('POST', '/v1/device/keys/rotate', invalidAttestation, token, keyId, old.privateKey),
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM device_key WHERE geops_device_id=$1 AND status='ACTIVE'",
          [device.id],
        )
      ).rows[0].n,
      1,
    );
    const rotations = await Promise.all([
      call(
        'POST',
        '/v1/device/keys/rotate',
        rotateBody,
        pop('POST', '/v1/device/keys/rotate', rotateBody, token, keyId, old.privateKey),
      ),
      call(
        'POST',
        '/v1/device/keys/rotate',
        rotateBody,
        pop('POST', '/v1/device/keys/rotate', rotateBody, token, keyId, old.privateKey),
      ),
    ]);
    assert.equal(rotations.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(
      rotations.filter((response) => [401, 403, 409].includes(response.statusCode)).length,
      1,
    );
    const rotated = rotations.find((response) => response.statusCode === 200);
    assert.equal(
      (
        await call(
          'POST',
          rotatePath,
          undefined,
          pop('POST', rotatePath, undefined, token, keyId, old.privateKey),
        )
      ).statusCode,
      401,
    );
    const newKeyId = rotated.json().new_key_id;
    const secondChallenge = await call('POST', '/v1/device/sessions/challenge', {
      geops_device_id: device.id,
      key_id: newKeyId,
    });
    assert.equal(secondChallenge.statusCode, 200);
    const second = secondChallenge.json();
    const newSession = await call('POST', '/v1/device/sessions', {
      geops_device_id: device.id,
      key_id: newKeyId,
      challenge_id: second.challenge_id,
      signature: signature(
        newPair.privateKey,
        sessionProofBytes(second.challenge_id, second.challenge, newKeyId, device.id),
      ),
    });
    assert.equal(newSession.statusCode, 201);
    step = 'revocation';
    const revoked = await call(
      'POST',
      `/v1/admin/devices/${device.id}/revoke`,
      { reason: 'Synthetic loss' },
      { origin, cookie, 'x-csrf-token': csrf },
    );
    assert.equal(revoked.statusCode, 200);
    assert.equal(
      (
        await call(
          'POST',
          rotatePath,
          undefined,
          pop(
            'POST',
            rotatePath,
            undefined,
            newSession.json().access_token,
            newKeyId,
            newPair.privateKey,
          ),
        )
      ).statusCode,
      401,
    );
    const dbStatus = await pool.query('SELECT status FROM geops_device WHERE id=$1', [device.id]);
    assert.equal(dbStatus.rows[0].status, 'REVOKED');
    const replacement = await lifecycle.replace(device.id, 'Synthetic replacement handset');
    assert.notEqual(replacement.id, device.id);
    assert.notEqual(replacement.mdm_binding_id, device.mdm_binding_id);
    assert.equal(replacement.status, 'DRAFT');
    assert.equal(
      (await pool.query('SELECT status FROM geops_device WHERE id=$1', [device.id])).rows[0].status,
      'REVOKED',
    );
    step = 'grant-store';
    const grants = new EncryptedGrantStore(pool, config.mdmGrantKey);
    const syntheticRefresh = randomBytes(32).toString('base64url');
    await grants.save({
      provider: 'manageengine',
      region: 'synthetic',
      customerId: '123',
      scopes: ['MDMOnDemand.MDMInventory.READ'],
      refreshToken: syntheticRefresh,
    });
    const stored = await pool.query(
      "SELECT encrypted_refresh_token FROM mdm_integration WHERE region='synthetic' AND customer_id='123'",
    );
    assert.ok(!stored.rows[0].encrypted_refresh_token.includes(Buffer.from(syntheticRefresh)));
    assert.equal((await grants.load('synthetic', '123')).refreshToken, syntheticRefresh);
    let refreshCount = 0;
    const manager = new SyntheticTokenManager(grants, async () => {
      refreshCount++;
      return { token: randomBytes(32).toString('base64url'), expiresInSeconds: 3600 };
    });
    await Promise.all([manager.token('synthetic', '123'), manager.token('synthetic', '123')]);
    assert.equal(refreshCount, 1);
    await manager.disconnect('synthetic', '123');
    assert.equal(await grants.load('synthetic', '123'), null);
    step = 'recovery';
    await assert.rejects(
      auth.issueRecovery(adminId, 'two labels', 'not authorization', randomUUID()),
      { code: 'supervised_recovery_required' },
    );
    const recovery = new SupervisedRecoveryService(pool, config.adminSessionKey);
    const firstPassword = randomBytes(24).toString('base64url');
    const secondPassword = randomBytes(24).toString('base64url');
    const first = await recovery.registerSyntheticCustodian('first@example.test', firstPassword);
    const secondCustodian = await recovery.registerSyntheticCustodian(
      'second@example.test',
      secondPassword,
    );
    const selfPassword = randomBytes(24).toString('base64url');
    const self = await recovery.registerSyntheticCustodian('owner@example.test', selfPassword);
    const request = await recovery.request(adminId);
    await assert.rejects(recovery.approve(request, self, selfPassword), {
      code: 'recovery_unavailable',
    });
    await recovery.approve(request, first, firstPassword);
    await assert.rejects(recovery.issueCode(request), { code: 'recovery_unavailable' });
    await recovery.approve(request, secondCustodian, secondPassword);
    const revokedCode = await recovery.issueCode(request);
    await recovery.revokeApproval(request, secondCustodian, secondPassword);
    await assert.rejects(recovery.consume(revokedCode, randomBytes(24).toString('base64url')));
    await recovery.approve(request, secondCustodian, secondPassword);
    const expiredCode = await recovery.issueCode(request);
    await pool.query('UPDATE recovery_request SET expires_at=now() WHERE id=$1', [request]);
    await assert.rejects(recovery.consume(expiredCode, randomBytes(24).toString('base64url')));
    const validRequest = await recovery.request(adminId);
    await recovery.approve(validRequest, first, firstPassword);
    await recovery.approve(validRequest, secondCustodian, secondPassword);
    const recoveryCode = await recovery.issueCode(validRequest);
    await recovery.consume(recoveryCode, randomBytes(24).toString('base64url'));
    await assert.rejects(recovery.consume(recoveryCode, randomBytes(24).toString('base64url')));
    const lostRequest = await recovery.request(adminId);
    await recovery.approve(lostRequest, first, firstPassword);
    await recovery.approve(lostRequest, secondCustodian, secondPassword);
    const lostCode = await recovery.issueCode(lostRequest);
    await recovery.revokeCustodian(secondCustodian);
    await assert.rejects(recovery.consume(lostCode, randomBytes(24).toString('base64url')));
    assert.equal((await call('GET', '/v1/admin/auth/me', undefined, { cookie })).statusCode, 401);
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(
        auth.login(
          'owner@example.test',
          'incorrect-synthetic-password',
          '198.51.100.10',
          randomUUID(),
        ),
        { code: 'invalid_credentials' },
      );
    }
    await assert.rejects(
      auth.login(
        'owner@example.test',
        'incorrect-synthetic-password',
        '198.51.100.10',
        randomUUID(),
      ),
      { code: 'rate_limited' },
    );
    step = 'claim-rate-limit';
    let limited = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await call('POST', '/v1/device/enrollment/claims', {});
      if (response.statusCode === 429) limited = true;
    }
    assert.equal(limited, true);
    console.log(
      'GEOPS synthetic integration: PASS bootstrap/login/CSRF/invitation/claim/proof/activation/session/PoP/rotation/revocation/grant/recovery',
    );
    console.log('GEOPS synthetic integration: no real MDM or Android calls');
  } finally {
    await app.close();
  }
}

main().catch(() => {
  console.error(`GEOPS synthetic integration failed at step=${step}; details withheld`);
  process.exitCode = 1;
});
