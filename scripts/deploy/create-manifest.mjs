import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digestRef = /^[a-z0-9][a-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function migrationChecksums(directory = resolve(root, 'apps/api/src/db/migrations')) {
  return readdirSync(directory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: name,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(directory, name)))
        .digest('hex'),
    }));
}

export function createManifest(input) {
  assert.match(input.commit ?? '', /^[a-f0-9]{40}$/, 'Full commit SHA required');
  for (const service of ['api', 'web'])
    assert.match(input[service] ?? '', digestRef, `${service} registry digest required`);
  assert.match(
    input.ciRun ?? '',
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/,
    'GitHub run URL required',
  );
  assert.equal(input.ciResult, 'success', 'Successful CI required');
  if (input.publicationRun)
    assert.match(
      input.publicationRun,
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/,
      'Publication run URL required',
    );
  assert.ok(['none', 'expand', 'contract'].includes(input.migration), 'Migration class required');
  return {
    schemaVersion: 2,
    commit: input.commit,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ci: { run: input.ciRun, result: input.ciResult },
    publication: input.publicationRun ? { run: input.publicationRun } : undefined,
    webBuild: {
      base: '/',
      mdmEnabled: false,
      gpsTimeZone: 'America/Costa_Rica',
      gpsTileUrl: null,
    },
    migration: input.migration,
    migrations: input.migrations ?? migrationChecksums(),
    images: { api: input.api, web: input.web },
  };
}

if (process.argv[1]?.endsWith('create-manifest.mjs')) {
  try {
    const [output, commit, api, web, ciRun, migration, publicationRun] = process.argv.slice(2);
    assert.ok(
      output && migration,
      'Usage: create-manifest.mjs OUTPUT COMMIT API_REF WEB_REF CI_RUN MIGRATION',
    );
    const manifest = createManifest({
      commit,
      api,
      web,
      ciRun,
      ciResult: 'success',
      migration,
      publicationRun,
    });
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ result: 'MANIFEST_CREATED', path: output, commit }));
  } catch (error) {
    console.error(`Manifest BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
