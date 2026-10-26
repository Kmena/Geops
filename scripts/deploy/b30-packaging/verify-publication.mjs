#!/usr/bin/env node
/** Verify local B30 image archives and refuse publication without real registry digests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const artifactRoot = join(root, 'artifacts/b30-packaging');
const APP_COMMIT = '15f77a0d1904b77833972d8e2fd628a6cb97678f';
const CANDIDATE_SHA = '02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f';
const B30 = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6';
const refs = {
  api: 'geops-b30-packaging-api:15f77a0',
  web: 'geops-b30-packaging-web:15f77a0',
};
const archiveNames = { api: 'api-b30.tar', web: 'web-b30.tar' };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const docker = (args) =>
  execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const image = (ref) => JSON.parse(docker(['image', 'inspect', ref, '--format', '{{json .}}']));

function localImage(kind) {
  const value = image(refs[kind]);
  const labels = value.Config?.Labels ?? {};
  assert.equal(value.Architecture, 'amd64');
  assert.equal(labels['org.opencontainers.image.revision'], APP_COMMIT);
  assert.equal(labels['org.opencontainers.image.source'], 'https://github.com/Kmena/Geops');
  assert.equal(labels['org.geops.release.schema'], '30');
  if (kind === 'api') assert.equal(labels['org.geops.api.variant'], 'B30-integrated');
  else {
    assert.equal(labels['org.geops.web.variant'], 'B30-integrated');
    assert.equal(labels['org.geops.web.mdm_enabled'], 'true');
  }
  assert.match(value.Id, /^sha256:[a-f0-9]{64}$/);
  const env = value.Config?.Env ?? [];
  assert.ok(
    env.every((item) => !/GEOPS_(ADMIN|MDM|GPS).*KEY=|PASSWORD=|TOKEN=/.test(item)),
    'Image environment must not contain GEOPS secrets',
  );
  return {
    imageId: value.Id,
    architecture: value.Architecture,
    repoDigests: value.RepoDigests ?? [],
  };
}

function embeddedSql() {
  const script =
    'const f=require("fs"),c=require("crypto"),p="/work/apps/api/dist/db/migrations";' +
    'const n=f.readdirSync(p).filter(x=>/^\\d{4}_[a-z0-9_]+\\.sql$/.test(x)).sort();' +
    'console.log(JSON.stringify({count:n.length,listSha256:c.createHash("sha256").update(' +
    'n.map(x=>x+"|"+c.createHash("sha256").update(f.readFileSync(p+"/"+x))' +
    '.digest("hex")).join("\\n")).digest("hex")}))';
  return JSON.parse(
    docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', refs.api, '-e', script]),
  );
}

function webAssets() {
  const html = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'cat',
    refs.web,
    '/usr/share/nginx/html/index.html',
  ]);
  assert.ok(html.includes('/assets/'), 'B30 Web assets missing');
}

function digestArchive(name) {
  const path = join(artifactRoot, name);
  return { bytes: statSync(path).size, sha256: hash(readFileSync(path)) };
}

function verifyArchive(kind, imageId) {
  const result = JSON.parse(
    execFileSync(
      'python',
      [
        join(root, 'scripts/deploy/b30-packaging/verify-image-archive.py'),
        join(artifactRoot, archiveNames[kind]),
        refs[kind],
        imageId,
      ],
      { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 },
    ),
  );
  assert.equal(result.result, 'IMAGE_ARCHIVE_VERIFIED');
  return result.layers;
}

function expectedDraft() {
  assert.equal(
    hash(
      readFileSync(
        join(root, 'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json'),
      ),
    ),
    CANDIDATE_SHA,
  );
  assert.deepEqual(embeddedSql(), { count: 30, listSha256: B30 });
  webAssets();
  return {
    schemaVersion: 1,
    kind: 'B30_PUBLICATION_DRAFT',
    applicationCommit: APP_COMMIT,
    candidateManifestSha256: CANDIDATE_SHA,
    sqlListSha256: B30,
    provenance: {
      apiDockerfileSha256: hash(readFileSync(join(root, 'infrastructure/docker/api.Dockerfile'))),
      webDockerfileSha256: hash(readFileSync(join(root, 'infrastructure/docker/web.Dockerfile'))),
      packageLockSha256: hash(readFileSync(join(root, 'package-lock.json'))),
      nodeBaseId: image('node:24.16.0-bookworm-slim').Id,
      webBaseId: image('nginxinc/nginx-unprivileged:1.27-alpine').Id,
    },
    controller: {
      file: 'controller-b30-lab.tar.gz',
      ...digestArchive('controller-b30-lab.tar.gz'),
      scope: 'LAB_ONLY',
    },
    images: Object.fromEntries(
      Object.keys(refs).map((kind) => {
        const observed = localImage(kind);
        return [
          kind,
          {
            tag: refs[kind],
            ...observed,
            archive: archiveNames[kind],
            ...digestArchive(archiveNames[kind]),
            layers: verifyArchive(kind, observed.imageId),
            registryDigest: null,
          },
        ];
      }),
    ),
    publicationReady: false,
    publishAuthorized: false,
  };
}

function assertPublishable(value) {
  assert.equal(value.controller.scope, 'STAGING_PRIVILEGED_CONTROLLER');
  for (const kind of Object.keys(refs)) {
    const digest = value.images[kind].registryDigest;
    assert.match(digest ?? '', new RegExp(`^ghcr\\.io/kmena/geops-${kind}@sha256:[a-f0-9]{64}$`));
    assert.ok(
      value.images[kind].repoDigests.includes(digest),
      'Registry digest unavailable locally',
    );
  }
  assert.equal(value.publicationReady, true);
}

const [mode, file] = process.argv.slice(2);
assert.ok(['create', 'verify', 'publishable'].includes(mode) && file && process.argv.length === 4);
const evidencePath = join(
  root,
  'specs/spec-03-clients-geofences-routes/b30-packaging-publication-evidence.json',
);
assert.ok(
  resolve(file) === join(artifactRoot, 'publication-draft.json') ||
    (mode !== 'create' && resolve(file) === evidencePath),
  'Only the B30 draft or its public evidence copy may be verified',
);
const expected = expectedDraft();
if (mode === 'create') {
  writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      result: 'B30_PUBLICATION_DRAFT_CREATED',
      manifestSha256: hash(readFileSync(file)),
    }),
  );
} else {
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')),
    expected,
    'Publication draft or local archive differs',
  );
  if (mode === 'publishable') assertPublishable(expected);
  console.log(
    JSON.stringify({
      result: 'B30_LOCAL_BUNDLE_VERIFIED',
      publicationReady: false,
      apiImageId: expected.images.api.imageId,
      webImageId: expected.images.web.imageId,
    }),
  );
}
