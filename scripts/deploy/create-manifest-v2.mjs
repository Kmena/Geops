import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { migrationChecksums } from './create-manifest.mjs';

const repo = (service) => new RegExp(`^ghcr\\.io/kmena/geops-${service}@sha256:[a-f0-9]{64}$`);
const hash = (items) =>
  createHash('sha256')
    .update(items.map((item) => `${item.version}|${item.sha256}`).join('\n'))
    .digest('hex');
const A21 = 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e';
const B22 = 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2';
const B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d';

export function createManifestV2(input) {
  assert.match(input.commit ?? '', /^[a-f0-9]{40}$/, 'Full reviewed commit required');
  for (const key of ['apiSafe', 'apiMdm']) assert.match(input[key] ?? '', repo('api'));
  for (const key of ['webGps', 'webMdm']) assert.match(input[key] ?? '', repo('web'));
  assert.notEqual(input.apiSafe, input.apiMdm, 'API profiles require distinct digests');
  assert.notEqual(input.webGps, input.webMdm, 'Web variants require distinct digests');
  assert.match(input.ciRun ?? '', /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/);
  assert.match(
    input.publicationRun ?? '',
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/,
  );
  const migrations = input.migrations ?? migrationChecksums();
  assert.equal(migrations.length, 23);
  assert.equal(hash(migrations.slice(0, 21)), A21, 'A21 SQL prefix changed');
  assert.equal(hash(migrations.slice(0, 22)), B22, 'B22 SQL prefix changed');
  assert.equal(hash(migrations), B23, 'B23 SQL changed');
  return {
    schemaVersion: 4,
    commit: input.commit,
    createdAt: new Date().toISOString(),
    ci: { run: input.ciRun, result: 'success' },
    publication: { run: input.publicationRun },
    migration: 'expand',
    migrations,
    apiBuild: {
      safe: { variant: 'B23-safe', mdmEnabled: false },
      mdm: { variant: 'B23-mdm', mdmEnabled: true },
    },
    webBuild: {
      gpsBase: { variant: 'gps-base', mdmEnabled: false },
      mdmQa: { variant: 'mdm-qa', mdmEnabled: true },
    },
    images: {
      api: { safe: input.apiSafe, mdm: input.apiMdm },
      web: { gpsBase: input.webGps, mdmQa: input.webMdm },
    },
  };
}

if (process.argv[1]?.endsWith('create-manifest-v2.mjs')) {
  try {
    const [output, commit, apiSafe, apiMdm, webGps, webMdm, ciRun, publicationRun] =
      process.argv.slice(2);
    assert.ok(output, 'Output path required');
    const manifest = createManifestV2({
      commit,
      apiSafe,
      apiMdm,
      webGps,
      webMdm,
      ciRun,
      publicationRun,
    });
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ result: 'V2_MANIFEST_CREATED', commit }));
  } catch (error) {
    console.error(`V2 manifest BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
