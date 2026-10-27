#!/usr/bin/env node
/** Cross-check the signed B30 release manifest against local artifacts and pulled GHCR images. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const manifestPath = resolve(
  root,
  'specs/spec-03-clients-geofences-routes/b30-final-publication-manifest.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hash = (body) => createHash('sha256').update(body).digest('hex');
const local = (name) => readFileSync(resolve(root, name));
const docker = (...args) =>
  execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();

assert.equal(manifest.kind, 'B30_STAGING_PUBLICATION_MANIFEST');
assert.equal(manifest.state.publicationReady, 'YES');
assert.equal(manifest.state.ghcrPublished, true);
assert.equal(manifest.state.bundleSigned, true);
assert.equal(manifest.state.stagingChanged, false);
assert.equal(manifest.source.applicationCommit, '2f89b87f1f636feb7e21d7e09af03959ee95f68d');
assert.equal(hash(local(manifest.source.sourceArchiveFile)), manifest.source.sourceArchiveSha256);
assert.equal(
  hash(local('specs/spec-03-clients-geofences-routes/b30-staging-candidate.json')),
  manifest.source.candidateManifestSha256,
);
for (const [name, expected] of [
  ['infrastructure/docker/api.Dockerfile', manifest.source.apiDockerfileSha256],
  ['infrastructure/docker/web.Dockerfile', manifest.source.webDockerfileSha256],
  ['package-lock.json', manifest.source.packageLockSha256],
])
  assert.equal(hash(local(name)), expected, `${name} changed`);

const archive = local(manifest.bundle.file);
const signature = local(manifest.bundle.signatureFile);
const publicPem = local(manifest.trust.publicKeyFile);
assert.equal(hash(archive), manifest.bundle.sha256);
assert.equal(archive.length, manifest.bundle.bytes);
assert.equal(hash(signature), manifest.bundle.signatureSha256);
assert.equal(signature.length, 64);
assert.equal(hash(publicPem), manifest.trust.approvedPublicKeySha256);
assert.equal(createPublicKey(publicPem).asymmetricKeyType, 'ed25519');
assert.ok(
  verify(
    null,
    Buffer.from(`GEOPS-B30-STAGING-PACKAGE-SHA256\n${manifest.bundle.sha256}\n`),
    publicPem,
    signature,
  ),
);

const policy = JSON.parse(
  execFileSync('tar', ['-xOzf', resolve(root, manifest.bundle.file), 'policy.json'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  }),
);
assert.equal(policy.kind, 'B30_STAGING_READY');
assert.equal(policy.activation, 'READY');
assert.equal(policy.publicationReady, true);
assert.equal(policy.applicationCommit, manifest.source.applicationCommit);
assert.equal(policy.candidateManifestSha256, manifest.source.candidateManifestSha256);
assert.equal(policy.trustKeySha256, manifest.trust.approvedPublicKeySha256);
assert.deepEqual(policy.sourceB23, {
  wrapperSha256: manifest.sourceB23.wrapperSha256,
  policySha256: manifest.sourceB23.policySha256,
});
assert.equal(policy.migrations.sourceCount, manifest.database.sourceSchema);
assert.equal(policy.migrations.sourceListSha256, manifest.database.sourceListSha256);
assert.equal(policy.migrations.targetCount, manifest.database.targetSchema);
assert.equal(policy.migrations.targetListSha256, manifest.database.targetListSha256);
assert.equal(policy.mdmRegion, manifest.compatibility.mdmRegion);
const archivePath = resolve(root, manifest.bundle.file);
const names = execFileSync('tar', ['-tzf', archivePath], {
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
})
  .trim()
  .split(/\r?\n/);
assert.equal(names.length, manifest.bundle.members);
assert.deepEqual(names.slice().sort(), ['policy.json', ...Object.keys(policy.files)].sort());
for (const name of Object.keys(policy.files)) {
  const body = execFileSync('tar', ['-xOzf', archivePath, name], {
    timeout: 10_000,
    maxBuffer: 3 * 1024 * 1024,
  });
  assert.equal(hash(body), policy.files[name], `${name} differs`);
}
assert.equal(policy.files['public.pem'], manifest.trust.approvedPublicKeySha256);

for (const kind of ['api', 'web']) {
  const entry = manifest.images[kind];
  assert.equal(policy.registryDigests[kind], entry.ref);
  const observed = JSON.parse(docker('image', 'inspect', entry.ref, '--format', '{{json .}}'));
  assert.equal(observed.Id, entry.localImageId);
  assert.equal(observed.Architecture, entry.architecture);
  assert.ok(observed.RepoDigests.includes(entry.ref));
  const labels = observed.Config.Labels;
  assert.equal(labels['org.opencontainers.image.revision'], manifest.source.applicationCommit);
  assert.equal(labels[`org.geops.${kind}.variant`], 'B30-integrated');
  if (kind === 'api') assert.equal(labels['org.geops.maintenance.recovery.max_schema'], '30');
  else assert.equal(labels['org.geops.web.mdm_enabled'], 'true');
}

console.log(
  JSON.stringify({
    result: 'B30_FINAL_PUBLICATION_VERIFIED',
    api: manifest.images.api.ref,
    web: manifest.images.web.ref,
    packageSha256: manifest.bundle.sha256,
    signatureSha256: manifest.bundle.signatureSha256,
    publicKeySha256: manifest.trust.approvedPublicKeySha256,
  }),
);
