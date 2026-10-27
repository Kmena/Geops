#!/usr/bin/env node
/** Verify local B30 image archives and refuse publication without real registry digests. */
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
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

function verifyLabSignature(packageSha256) {
  const signature = readFileSync(join(artifactRoot, 'controller-b30-lab.sig'));
  const publicKey = readFileSync(join(artifactRoot, 'lab-public.pem'));
  const message = Buffer.from(`GEOPS-B30-LAB-PACKAGE-SHA256\n${packageSha256}\n`);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, message, publicKey, signature), 'Lab package signature changed');
  return {
    scope: 'LAB_ONLY',
    signatureSha256: hash(signature),
    publicKeySha256: hash(publicKey),
  };
}

function stagingCompatibility() {
  const candidate = JSON.parse(
    readFileSync(
      join(root, 'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json'),
    ),
  );
  assert.equal(candidate.database.minimumSourceSchema, 23);
  assert.equal(candidate.database.targetSchema, 30);
  assert.equal(
    candidate.database.b23PrefixSha256,
    '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
  );
  assert.equal(candidate.database.targetListSha256, B30);
  assert.equal(candidate.database.migrations.length, 30);
  assert.equal(candidate.compatibility.apiDuringMigration, 'STOPPED');
  assert.equal(candidate.compatibility.webDuringMigration, 'STOPPED');
  assert.equal(
    candidate.compatibility.rollback,
    'NO_DATABASE_DOWNGRADE; RECOVER_FORWARD_TO_SCHEMA_30',
  );
  const v2Profiles = JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        'import json,sys;sys.path.insert(0,"scripts/deploy/remote");import geops_deploy_v2 as v;print(json.dumps(v.PROFILES))',
      ],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    ),
  );
  assert.equal(v2Profiles['B23-mdm'].sqlCount, 23);
  assert.ok(!Object.keys(v2Profiles).some((profile) => profile.startsWith('B30')));
  const exampleApi = `ghcr.io/kmena/geops-api@sha256:${'a'.repeat(64)}`;
  const exampleWeb = `ghcr.io/kmena/geops-web@sha256:${'b'.repeat(64)}`;
  const env = {
    ...process.env,
    GEOPS_STAGE_IMAGE_TAG: '03e582fba66c0d29eab885e109d3404e86b140a3',
    GEOPS_STAGE_SECRET_GID: '24001',
    GEOPS_STAGE_ORIGIN: 'https://geops-staging.duckdns.org',
    GEOPS_STAGE_API_IMAGE_REF: exampleApi,
    GEOPS_STAGE_WEB_IMAGE_REF: exampleWeb,
    GEOPS_MDM_REGION: 'com',
  };
  const config = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        'infrastructure/compose/compose.staging.yaml',
        '-f',
        'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
        '-f',
        'infrastructure/compose/compose.staging.digest.override.yaml',
        '-f',
        'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
        '--profile',
        'maintenance',
        'config',
        '--format',
        'json',
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    ),
  );
  assert.equal(config.name, 'geops-spec02-staging');
  assert.equal(config.services['geops-db'].image, 'postgis/postgis:18-3.6');
  assert.equal(config.services['geops-api'].image, exampleApi);
  assert.equal(config.services['geops-web'].image, exampleWeb);
  assert.equal(config.services['geops-migrate'].image, exampleApi);
  assert.equal(config.services['geops-api'].environment.MDM_ENABLED, 'true');
  assert.equal(config.services['geops-web'].build.args.MDM_ENABLED, 'true');
  assert.equal(config.services['geops-api'].environment.GEOPS_MDM_TEST_TENANT, '1');
  return {
    sourceSchema: 23,
    targetSchema: 30,
    sourceSqlListSha256: candidate.database.b23PrefixSha256,
    targetSqlListSha256: B30,
    composeDigestOverridesVerified: true,
    mdmEnabled: true,
    existingPrivilegedControllerMaxSchema: 23,
    stagingController: 'B30_ADAPTATION_PENDING',
  };
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
  const controller = digestArchive('controller-b30-lab.tar.gz');
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
      ...controller,
      scope: 'LAB_ONLY',
      signature: verifyLabSignature(controller.sha256),
    },
    stagingCompatibility: stagingCompatibility(),
    stagingEd25519TrustKey: 'PENDING_OPERATOR_VERIFICATION',
    stagingBundleSignature: 'PENDING',
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
