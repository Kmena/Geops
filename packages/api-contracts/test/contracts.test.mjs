import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  enrollmentAttestationMessage,
  enrollmentProofBytes,
  requestProofBytes,
  rotationProofBytes,
  rotationAttestationMessage,
  sessionProofBytes,
} from '../dist/index.js';

const ascii = (bytes) => Buffer.from(bytes).toString('utf8');

test('enrollment proof preserves SPEC-00 field order and no trailing LF', () => {
  const value = ascii(
    enrollmentProofBytes({
      claimId: 'claim',
      challengeId: 'challenge-id',
      challenge: 'challenge',
      geopsDeviceId: 'device',
      mdmDeviceId: 'mdm-id',
      publicKeySpkiSha256: 'spki-hash',
      clientNonce: 'nonce',
    }),
  );
  assert.equal(
    value,
    'GEOPS-ENROLL-V1\nclaim\nchallenge-id\nchallenge\ndevice\nmdm-id\nspki-hash\nnonce',
  );
});

test('PoP request refuses query and preserves exact bytes', () => {
  const fields = {
    method: 'POST',
    absolutePath: '/v1/device/heartbeats',
    bodySha256: 'body-hash',
    tokenSha256: 'token-hash',
    timestamp: '1234567890',
    nonce: 'nonce',
    keyId: 'key',
  };
  assert.equal(
    ascii(requestProofBytes(fields)),
    'GEOPS-REQ-V1\nPOST\n/v1/device/heartbeats\nbody-hash\ntoken-hash\n1234567890\nnonce\nkey',
  );
  assert.throws(() => requestProofBytes({ ...fields, absolutePath: '/v1/device/heartbeats?x=1' }));
});

test('attestation and session preimages follow SPEC-00', () => {
  assert.equal(
    ascii(enrollmentAttestationMessage('invitation', 'device', 'nonce')),
    'GEOPS-ATTEST-ENROLL-V1\ninvitation\ndevice\nnonce',
  );
  assert.equal(
    ascii(rotationAttestationMessage('challenge-id', 'challenge')),
    'GEOPS-ATTEST-ROTATE-V1\nchallenge-id\nchallenge',
  );
  assert.equal(
    ascii(sessionProofBytes('challenge-id', 'challenge', 'key', 'device')),
    'GEOPS-SESSION-V1\nchallenge-id\nchallenge\nkey\ndevice',
  );
});

test('synthetic attestation digest vectors and rotation preimage are stable', () => {
  const enrollment = enrollmentAttestationMessage(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'AAAAAAAAAAAAAAAAAAAAAA',
  );
  assert.equal(
    createHmac('sha256', Buffer.alloc(32, 17)).update(enrollment).digest('hex'),
    'dd9815f5813dcac3b33fdcf877df729d8b7e1f297732745347d46b7f18606019',
  );
  const rotation = rotationAttestationMessage(
    '33333333-3333-4333-8333-333333333333',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
  assert.equal(
    createHash('sha256').update(rotation).digest('hex'),
    '6c509383b1f32732cfa468c1f8eb2ecbd384f5f059064d56cc421dd7171c0e05',
  );
  assert.equal(
    ascii(rotationProofBytes('challenge-id', 'challenge', 'device', 'old-key', 'new-spki-hash')),
    'GEOPS-ROTATE-V1\nchallenge-id\nchallenge\ndevice\nold-key\nnew-spki-hash',
  );
});
