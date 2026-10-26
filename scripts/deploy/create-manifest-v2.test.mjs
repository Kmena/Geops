import assert from 'node:assert/strict';
import test from 'node:test';
import { createManifestV2 } from './create-manifest-v2.mjs';
import { migrationChecksums } from './create-manifest.mjs';

const input = {
  commit: 'a'.repeat(40),
  apiSafe: `ghcr.io/kmena/geops-api@sha256:${'1'.repeat(64)}`,
  apiMdm: `ghcr.io/kmena/geops-api@sha256:${'2'.repeat(64)}`,
  webGps: `ghcr.io/kmena/geops-web@sha256:${'3'.repeat(64)}`,
  webMdm: `ghcr.io/kmena/geops-web@sha256:${'4'.repeat(64)}`,
  ciRun: 'https://github.com/kmena/geops/actions/runs/123',
  publicationRun: 'https://github.com/kmena/geops/actions/runs/124',
};

test('v2 manifest pins two API and two Web digests to the exact 23 SQL catalog', () => {
  const manifest = createManifestV2(input);
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.migrations.length, 23);
  assert.deepEqual(manifest.migrations, migrationChecksums());
  assert.notEqual(manifest.images.api.safe, manifest.images.api.mdm);
  assert.equal(manifest.apiBuild.safe.mdmEnabled, false);
  assert.equal(manifest.apiBuild.mdm.mdmEnabled, true);
});

test('v2 manifest rejects accidental A21 and profile digest reuse', () => {
  assert.throws(() => createManifestV2({ ...input, apiMdm: input.apiSafe }));
  assert.throws(() =>
    createManifestV2({ ...input, migrations: migrationChecksums().slice(0, 21) }),
  );
  const migrations = migrationChecksums();
  migrations[21] = { ...migrations[21], sha256: '0'.repeat(64) };
  assert.throws(() => createManifestV2({ ...input, migrations }));
});
