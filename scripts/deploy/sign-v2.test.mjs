import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createManifestV2 } from './create-manifest-v2.mjs';

const signer = fileURLToPath(new URL('./remote/sign-v2.mjs', import.meta.url));
const policy = {
  schemaVersion: 2,
  environment: 'geops-spec02-staging',
  profiles: {
    A21: {
      sqlCount: 21,
      sqlListSha256: 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e',
      variant: 'gps-base',
      mdmEnabled: false,
    },
    'B22-safe': {
      sqlCount: 22,
      sqlListSha256: 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2',
      variant: 'gps-base',
      mdmEnabled: false,
    },
    'B22-mdm': {
      sqlCount: 22,
      sqlListSha256: 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2',
      variant: 'mdm-qa',
      mdmEnabled: true,
    },
  },
};

test('v2 release signature binds exact policy, catalog and profile', () => {
  const folder = mkdtempSync(join(tmpdir(), 'geops-v2-sign-'));
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  try {
    const key = generateKeyPairSync('ed25519');
    const keyPath = join(folder, 'private.pem');
    const publicKeyPath = join(folder, 'public.pem');
    const policyPath = join(folder, 'policy.json');
    const manifestPath = join(folder, 'manifest.json');
    const output = join(folder, 'signed');
    writeFileSync(keyPath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicKeyPath, key.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
    const manifest = createManifestV2({
      commit: 'a'.repeat(40),
      apiSafe: `ghcr.io/kmena/geops-api@sha256:${'1'.repeat(64)}`,
      apiMdm: `ghcr.io/kmena/geops-api@sha256:${'2'.repeat(64)}`,
      webGps: `ghcr.io/kmena/geops-web@sha256:${'3'.repeat(64)}`,
      webMdm: `ghcr.io/kmena/geops-web@sha256:${'4'.repeat(64)}`,
      ciRun: 'https://github.com/kmena/geops/actions/runs/123',
      publicationRun: 'https://github.com/kmena/geops/actions/runs/124',
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const args = [
      signer,
      'release',
      '--id',
      'synthetic_release_001',
      '--key',
      keyPath,
      '--out',
      output,
      '--policy',
      policyPath,
      '--profile',
      'B22-mdm',
      '--manifest',
      manifestPath,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const document = readFileSync(`${output}.release.json`);
    const signature = readFileSync(`${output}.release.sig`);
    assert.equal(verify(null, document, key.publicKey, signature), true);
    const openssl = spawnSync(
      process.env.GEOPS_TEST_OPENSSL ?? 'openssl',
      [
        'pkeyutl',
        '-verify',
        '-pubin',
        '-inkey',
        publicKeyPath,
        '-rawin',
        '-in',
        `${output}.release.json`,
        '-sigfile',
        `${output}.release.sig`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(openssl.status, 0, openssl.stderr);
    const parsed = JSON.parse(document);
    assert.equal(parsed.profile, 'B22-mdm');
    assert.equal(parsed.sqlCount, 22);
    assert.equal(parsed.api, manifest.images.api.mdm);
    assert.equal(parsed.web, manifest.images.web.mdmQa);
    assert.equal(
      verify(
        null,
        Buffer.from(document.toString().replace('B22-mdm', 'B22-safe')),
        key.publicKey,
        signature,
      ),
      false,
    );
    const originalSqlSha = manifest.migrations[21].sha256;
    manifest.migrations[21].sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const rejected = spawnSync(
      process.execPath,
      [...args.slice(0, 7), join(folder, 'rejected'), ...args.slice(8)],
      { encoding: 'utf8' },
    );
    assert.notEqual(rejected.status, 0);
    manifest.migrations[21].sha256 = originalSqlSha;
    manifest.apiBuild.mdm.mdmEnabled = false;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const mislabeled = spawnSync(
      process.execPath,
      [...args.slice(0, 7), join(folder, 'mislabeled'), ...args.slice(8)],
      { encoding: 'utf8' },
    );
    assert.notEqual(mislabeled.status, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
