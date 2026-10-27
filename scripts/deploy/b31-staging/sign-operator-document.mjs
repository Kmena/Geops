#!/usr/bin/env node
/** Sign one reviewed B31 operator document with the approved operational identity. */
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [documentPath, publicPath, privatePath, signaturePath] = process.argv.slice(2);
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const approved = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27';
const policy = '75bbaf0a2cb9a57a4aecd05ea00ae46b96430a6d2f24f39e2baae6262be931a0';
const b30 = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6';
const b31 = '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), keys.sort());
if (!documentPath || !publicPath || !privatePath || !signaturePath || process.argv.length !== 6) {
  console.error('Usage: sign-operator-document.mjs DOCUMENT.json PUBLIC.pem PRIVATE.pem OUTPUT.sig');
  process.exit(2);
}
try {
  for (const path of [documentPath, publicPath, privatePath]) {
    assert.ok(lstatSync(path).isFile(), 'Regular input required');
  }
  const body = readFileSync(documentPath);
  assert.ok(body.length > 0 && body.length <= 16384, 'Document size invalid');
  const value = JSON.parse(body);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.environment, 'geops-spec02-staging');
  assert.ok(ID.test(value.id));
  assert.equal(basename(documentPath), `${value.id}.${value.kind}.json`);
  assert.equal(value.policySha256, policy);
  const start = Date.parse(value.notBefore);
  const end = Date.parse(value.expiresAt);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start <= Date.now() && Date.now() < end);
  assert.ok(end - start <= (value.kind === 'release' ? 30 * 86400e3 : 30 * 60e3));
  const common = ['schemaVersion', 'kind', 'id', 'environment', 'notBefore', 'expiresAt', 'policySha256'];
  if (value.kind === 'release') {
    sameKeys(value, [...common, 'commit', 'api', 'web', 'sqlCount', 'sqlListSha256']);
    assert.equal(value.commit, 'eba9b3ba3cf1927dcbf032070322fa32dbfe4db3');
    assert.equal(value.api, 'ghcr.io/kmena/geops-api@sha256:14e004b341ba6a4173a66ffe506fa8d2d7ca4f22dc5a033248f7af775f38c17c');
    assert.equal(value.web, 'ghcr.io/kmena/geops-web@sha256:6467721d823c142257205927d2ab6d31d916ac941c15645815db692a2f524ff8');
    assert.equal(value.sqlCount, 31);
    assert.equal(value.sqlListSha256, b31);
  } else if (value.kind === 'restore') {
    sameKeys(value, [...common, 'backupSha256', 'sqlCount', 'sqlListSha256', 'result', 'evidenceSha256']);
    assert.equal(value.result, 'PASS');
    assert.equal(value.sqlCount, 30);
    assert.equal(value.sqlListSha256, b30);
    assert.equal(value.backupSha256, 'f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705');
    assert.equal(value.evidenceSha256, '45ffd1e232b8bdecc08c10698f726401f3d720fc763b1d6db516b716730f0bcc');
  } else if (value.kind === 'approval') {
    sameKeys(value, [...common, 'action', 'releaseSha256', 'sourceStateSha256',
                      'backupSha256', 'restoreProofSha256', 'gateEpoch']);
    assert.equal(value.action, 'promote-b30-b31');
    assert.equal(value.backupSha256, 'f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705');
    for (const key of ['releaseSha256', 'sourceStateSha256', 'restoreProofSha256']) {
      assert.ok(SHA.test(value[key]), `Invalid ${key}`);
    }
    assert.match(value.gateEpoch, /^[a-f0-9-]{36}$/);
  } else if (value.kind === 'recovery') {
    sameKeys(value, [...common, 'result', 'approvalId', 'gateEpoch', 'gateNonce',
                      'ledgerCount', 'ledgerSha256', 'auditRequestId']);
    assert.equal(value.result, 'PASS');
    assert.equal(value.ledgerCount, 31);
    assert.equal(value.ledgerSha256, b31);
    assert.ok(ID.test(value.approvalId) && ID.test(value.auditRequestId));
    assert.match(value.gateEpoch, /^[a-f0-9-]{36}$/);
    assert.match(value.gateNonce, /^[a-f0-9-]{36}$/);
  } else {
    throw Error('Unsupported B31 signed document');
  }
  const publicBody = readFileSync(publicPath);
  assert.equal(hash(publicBody), approved);
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(publicBody);
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  assert.deepEqual(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }));
  const signature = sign(null, body, privateKey);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, body, publicKey, signature));
  writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ result: 'B31_OPERATOR_DOCUMENT_SIGNED', kind: value.kind,
    id: value.id, documentSha256: hash(body), signatureSha256: hash(signature) }));
} catch (error) {
  console.error('B31 operator signing BLOCKED: ' + error.message);
  process.exitCode = 1;
}