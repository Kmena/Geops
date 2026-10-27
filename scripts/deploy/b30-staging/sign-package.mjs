#!/usr/bin/env node
/** Offline B30 staging bundle signer. Never exports private key material. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [archivePath, publicPath, privatePath, approvedSha256, signaturePath] = process.argv.slice(2);
if (
  !archivePath ||
  !publicPath ||
  !privatePath ||
  !/^[a-f0-9]{64}$/.test(approvedSha256 ?? '') ||
  !signaturePath ||
  process.argv.length !== 7
) {
  console.error(
    'Usage: sign-package.mjs READY.tar.gz PUBLIC.pem PRIVATE.pem APPROVED_PUBLIC_SHA256 OUTPUT.sig',
  );
  process.exit(2);
}

try {
  for (const path of [archivePath, publicPath, privatePath]) {
    assert.ok(lstatSync(path).isFile(), 'Regular input file required');
  }
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./verify-trust-key.mjs', import.meta.url)), publicPath, approvedSha256],
    { stdio: 'ignore', timeout: 10_000 },
  );
  const archive = readFileSync(archivePath);
  const policy = JSON.parse(
    execFileSync('tar', ['-xOzf', archivePath, 'policy.json'], {
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    }).toString('utf8'),
  );
  assert.equal(policy.kind, 'B30_STAGING_READY');
  assert.equal(policy.activation, 'READY');
  assert.equal(policy.publicationReady, true);
  assert.equal(policy.trustKeySha256, approvedSha256);
  assert.equal(policy.applicationCommit, '2f89b87f1f636feb7e21d7e09af03959ee95f68d');
  assert.equal(
    policy.candidateManifestSha256,
    '3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b',
  );
  assert.deepEqual(policy.migrations, {
    sourceCount: 23,
    sourceListSha256: '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
    targetCount: 30,
    targetListSha256: '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
  });
  for (const field of ['wrapperSha256', 'policySha256']) {
    assert.match(policy.sourceB23?.[field] ?? '', /^[a-f0-9]{64}$/);
  }
  for (const kind of ['api', 'web']) {
    assert.match(
      policy.registryDigests?.[kind] ?? '',
      new RegExp(`^ghcr\\.io/kmena/geops-${kind}@sha256:[a-f0-9]{64}$`),
    );
  }
  const names = execFileSync('tar', ['-tzf', archivePath], {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  })
    .toString('utf8')
    .trim()
    .split(/\r?\n/);
  assert.equal(names.length, new Set(names).size, 'Duplicate archive member');
  assert.deepEqual(
    names.slice().sort(),
    ['policy.json', ...Object.keys(policy.files ?? {})].sort(),
  );
  for (const required of [
    'public.pem',
    'scripts/deploy/b30-staging/controller.py',
    'scripts/deploy/b30-staging/guard.py',
    'scripts/deploy/b30-staging/install.py',
    'scripts/deploy/b30-staging/sudoers-ready',
    'specs/spec-03-clients-geofences-routes/b30-staging-candidate.json',
  ]) {
    assert.ok(names.includes(required), `Missing bundle member: ${required}`);
  }
  for (const name of names) {
    assert.match(
      name,
      /^(?:public\.pem|(?:scripts\/deploy|infrastructure|specs)\/[a-zA-Z0-9_./-]+|policy\.json)$/,
    );
    assert.ok(!name.split('/').includes('..'), 'Unsafe archive member');
    if (name === 'policy.json') continue;
    const body = execFileSync('tar', ['-xOzf', archivePath, name], {
      maxBuffer: 3 * 1024 * 1024,
      timeout: 10_000,
    });
    assert.equal(createHash('sha256').update(body).digest('hex'), policy.files[name]);
  }
  assert.equal(policy.files['public.pem'], approvedSha256);
  assert.equal(
    policy.files['specs/spec-03-clients-geofences-routes/b30-staging-candidate.json'],
    policy.candidateManifestSha256,
  );
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(readFileSync(publicPath));
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  assert.deepEqual(
    createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }),
    'Private/public identity differs',
  );
  const packageSha256 = createHash('sha256').update(archive).digest('hex');
  const message = Buffer.from(`GEOPS-B30-STAGING-PACKAGE-SHA256\n${packageSha256}\n`);
  const signature = sign(null, message, privateKey);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, message, publicKey, signature));
  writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      result: 'B30_STAGING_BUNDLE_SIGNED',
      packageSha256,
      signatureSha256: createHash('sha256').update(signature).digest('hex'),
      publicKeySha256: approvedSha256,
    }),
  );
} catch (error) {
  console.error(`B30 signing BLOCKED: ${error.message}`);
  process.exitCode = 1;
}
