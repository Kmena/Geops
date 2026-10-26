import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationChecksums } from './create-manifest.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d';
const excluded = new Set([
  'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json',
  'specs/spec-03-clients-geofences-routes/release-readiness-report.md',
]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const listHash = (entries) =>
  sha256(entries.map((entry) => `${entry.version}|${entry.sha256}`).join('\n'));

function sourceFiles() {
  const names = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
    },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((name) => name.replaceAll('\\', '/'));
  return [...new Set(names)]
    .filter((name) => !excluded.has(name) && existsSync(resolve(root, name)))
    .sort()
    .map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
}

export function createSpec03CandidateManifest() {
  const migrations = migrationChecksums();
  assert.equal(migrations.length, 30, 'Exactly 30 ordered SQL migrations required');
  migrations.forEach((entry, index) => {
    assert.equal(Number(entry.version.slice(0, 4)), index + 1, 'Migration sequence has a gap');
  });
  assert.equal(listHash(migrations.slice(0, 23)), B23, 'Applied B23 prefix changed');
  const files = sourceFiles();
  const sourceSha256 = sha256(files.map((entry) => `${entry.path}|${entry.sha256}`).join('\n'));
  return {
    schemaVersion: 1,
    kind: 'SPEC03_RELEASE_CANDIDATE_DRAFT',
    identity: `spec03-b30-${sourceSha256.slice(0, 20)}`,
    sourceSha256,
    files,
    database: {
      minimumSourceSchema: 23,
      targetSchema: 30,
      b23PrefixSha256: B23,
      targetListSha256: listHash(migrations),
      migrations,
      classification: 'supervised_nonrollbackable_schema_upgrade',
    },
    compatibility: {
      apiBeforeMigration: 'B23_API_ONLY_WHILE_SCHEMA_23',
      apiDuringMigration: 'STOPPED',
      apiAfterMigration: 'SPEC03_API_SCHEMA_30_ONLY',
      webDuringMigration: 'STOPPED',
      rollback: 'NO_DATABASE_DOWNGRADE; RECOVER_FORWARD_TO_SCHEMA_30',
    },
    artifactReferences: { api: null, web: null },
    publication: { status: 'PENDING', ciRun: null, publicationRun: null, signature: null },
  };
}

export function verifySpec03CandidateManifest(manifest) {
  const expected = createSpec03CandidateManifest();
  assert.deepEqual(manifest, expected, 'Candidate file, migration or compatibility hash mismatch');
  return { identity: manifest.identity, files: manifest.files.length, migrations: 30 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path] = process.argv.slice(2);
  assert.ok(['create', 'verify'].includes(command) && path, 'Usage: create|verify PATH');
  if (command === 'create') {
    const manifest = createSpec03CandidateManifest();
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ result: 'CREATED', identity: manifest.identity }));
  } else {
    console.log(
      JSON.stringify({
        result: 'VERIFIED',
        ...verifySpec03CandidateManifest(JSON.parse(readFileSync(path, 'utf8'))),
      }),
    );
  }
}
