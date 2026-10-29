#!/usr/bin/env node
/** Sign only the verified B32 staging bundle with the approved Ed25519 identity. */
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
  assert.equal(policy.kind, 'B32_STAGING_READY');
  assert.equal(policy.activation, 'READY');
  assert.equal(policy.publicationReady, true);
  assert.equal(policy.applicationCommit, '06b6599779bbf95a45576d9bda581119ddce27de');
  assert.equal(policy.candidateManifestSha256, 'c1011f3235d9efd25fdee1336f3a882babd0cbb640d05e3494b27ccc3b176e3f');
  assert.match(policy.promotionCommit ?? '', /^[a-f0-9]{40}$/);
  assert.equal(policy.trustKeySha256, approved);
  assert.deepEqual(policy.migrations, {
    sourceCount: 31,
    sourceListSha256: '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0',
    targetCount: 33,
    targetListSha256: 'd4730ee35c02af8976f1b7a642c305ea0304448742f9d54a5ff829336752074a',
  });
  for (const kind of ['api', 'web', 'recovery']) {
    const repository = kind === 'web' ? 'web' : 'api';
    assert.match(policy.registryDigests?.[kind] ?? '', new RegExp(`^ghcr\\.io/kmena/geops-${repository}@sha256:[a-f0-9]{64}$`));
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
  const message = Buffer.from(`GEOPS-B32-STAGING-PACKAGE-SHA256\n${packageSha256}\n`);
  const signature = sign(null, message, privateKey);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, message, publicKey, signature));
  writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ result: 'B32_STAGING_BUNDLE_SIGNED', packageSha256,
    signatureSha256: hash(signature), publicKeySha256: approved }));
} catch (error) {
  console.error('B32 signing BLOCKED: ' + error.message);
  process.exitCode = 1;
}
