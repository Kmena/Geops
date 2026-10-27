#!/usr/bin/env node
/** Sign only the verified B31 staging bundle with the approved Ed25519 identity. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';

const [archivePath, publicPath, privatePath, signaturePath] = process.argv.slice(2);
const approved = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27';
const hash = (body) => createHash('sha256').update(body).digest('hex');
if (!archivePath || !publicPath || !privatePath || !signaturePath || process.argv.length !== 6) {
  console.error('Usage: sign-package.mjs READY.tar.gz PUBLIC.pem PRIVATE.pem OUTPUT.sig');
  process.exit(2);
}
try {
  for (const path of [archivePath, publicPath, privatePath]) {
    assert.ok(lstatSync(path).isFile(), 'Regular input required');
  }
  const archive = readFileSync(archivePath);
  const publicBody = readFileSync(publicPath);
  assert.equal(hash(publicBody), approved);
  const policy = JSON.parse(execFileSync('tar', ['-xOzf', archivePath, 'policy.json'], {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  }));
  assert.equal(policy.kind, 'B31_STAGING_READY');
  assert.equal(policy.activation, 'READY');
  assert.equal(policy.publicationReady, true);
  assert.equal(policy.applicationCommit, 'eba9b3ba3cf1927dcbf032070322fa32dbfe4db3');
  assert.equal(policy.candidateManifestSha256, '2cebd7f253f87efbc936d1ae08b429de0b5ddbd3a6d44d243d3520a99aae7061');
  assert.equal(policy.trustKeySha256, approved);
  assert.deepEqual(policy.migrations, {
    sourceCount: 30,
    sourceListSha256: '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
    targetCount: 31,
    targetListSha256: '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0',
  });
  for (const kind of ['api', 'web']) {
    assert.match(policy.registryDigests?.[kind] ?? '', new RegExp(`^ghcr\\.io/kmena/geops-${kind}@sha256:[a-f0-9]{64}$`));
  }
  const names = execFileSync('tar', ['-tzf', archivePath], { maxBuffer: 1024 * 1024 }).toString().trim().split(/\r?\n/);
  assert.equal(names.length, new Set(names).size);
  assert.deepEqual(names.slice().sort(), ['policy.json', ...Object.keys(policy.files ?? {})].sort());
  for (const name of names) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
    if (name === 'policy.json') continue;
    const body = execFileSync('tar', ['-xOzf', archivePath, name], { maxBuffer: 3 * 1024 * 1024 });
    assert.equal(hash(body), policy.files[name]);
  }
  assert.equal(policy.files['public.pem'], approved);
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(publicBody);
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  assert.deepEqual(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }));
  const packageSha256 = hash(archive);
  const message = Buffer.from(`GEOPS-B31-STAGING-PACKAGE-SHA256\n${packageSha256}\n`);
  const signature = sign(null, message, privateKey);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, message, publicKey, signature));
  writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ result: 'B31_STAGING_BUNDLE_SIGNED', packageSha256,
    signatureSha256: hash(signature), publicKeySha256: approved }));
} catch (error) {
  console.error('B31 signing BLOCKED: ' + error.message);
  process.exitCode = 1;
}