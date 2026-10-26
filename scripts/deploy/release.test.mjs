import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { createManifest, migrationChecksums } from './create-manifest.mjs';
import { createPlan } from './create-plan.mjs';
import {
  assertDatabaseMigrations,
  assertImageMigrations,
  embeddedMigrationScript,
  parseReleaseArgs,
} from './release.mjs';

const ref = (service, digit) => `localhost:5000/geops-${service}@sha256:${digit.repeat(64)}`;
// The installed v1 policy remains A21; the integrated source already contains 0022.
const migrations = migrationChecksums().slice(0, 21);

test('embedded API migrations must match the approved manifest', () => {
  assert.doesNotThrow(() => assertImageMigrations(migrations, migrations));
  assert.throws(() =>
    assertImageMigrations(
      [{ ...migrations[0], sha256: 'f'.repeat(64) }, ...migrations.slice(1)],
      migrations,
    ),
  );
  const actual = JSON.parse(
    execFileSync('node', ['-e', embeddedMigrationScript(resolve('apps/api/src/db/migrations/'))], {
      encoding: 'utf8',
    }),
  );
  assert.equal(actual.length, 23);
  assert.throws(() => assertImageMigrations(actual, migrations));
});

test('database ledger must match all approved SQL versions and checksums before switching', () => {
  assert.doesNotThrow(() => assertDatabaseMigrations(migrations, migrations));
  assert.throws(() => assertDatabaseMigrations(migrations.slice(0, 18), migrations));
  assert.throws(() =>
    assertDatabaseMigrations(
      [...migrations.slice(0, 20), { ...migrations[20], sha256: 'f'.repeat(64) }],
      migrations,
    ),
  );
});
const manifest = (commit, digit, migration = 'none', set = migrations) =>
  createManifest({
    commit: commit.repeat(40),
    api: ref('api', digit),
    webGps: ref('web-gps', digit),
    webMdm: ref('web-mdm', digit === 'a' ? 'e' : 'f'),
    ciRun: 'https://github.com/example/geops/actions/runs/123',
    ciResult: 'success',
    migration,
    migrations: set,
  });
const makePlan = (candidate, previous, variant = 'gps-base') =>
  createPlan(candidate, previous, variant);

test('immutable manifests retain real SQL checksums and compose a rollback plan', () => {
  assert.equal(migrations.length, 21);
  const plan = makePlan(manifest('b', 'b'), manifest('a', 'a'));
  assert.equal(plan.migration, 'none');
  assert.equal(plan.qaVariant, 'gps-base');
  assert.equal(plan.candidate.api, ref('api', 'b'));
  assert.equal(plan.previous.web, ref('web-gps', 'a'));
  assert.equal(plan.provenance.previousCommit, 'a'.repeat(40));
  const mdmPlan = makePlan(manifest('b', 'b'), manifest('a', 'a'), 'mdm-qa');
  assert.equal(mdmPlan.candidate.web, ref('web-mdm', 'f'));
  assert.throws(() =>
    createManifest({
      commit: 'b'.repeat(40),
      api: ref('api', 'b'),
      webGps: ref('web-gps', 'c'),
      webMdm: ref('web-mdm', 'c'),
      ciRun: 'https://github.com/example/geops/actions/runs/123',
      ciResult: 'success',
      migration: 'none',
      migrations,
    }),
  );
  assert.throws(() => createPlan(manifest('b', 'b'), manifest('a', 'a')));
  assert.throws(() => makePlan(manifest('b', 'b'), manifest('a', 'a'), 'unknown'));
  assert.throws(() =>
    makePlan({ ...manifest('b', 'b'), schemaVersion: 2 }, manifest('a', 'a'), 'mdm-qa'),
  );
  const mislabeled = manifest('b', 'b');
  mislabeled.webBuild.mdmQa.mdmEnabled = false;
  assert.throws(() => makePlan(mislabeled, manifest('a', 'a'), 'mdm-qa'));
});

test('SQL rewrites and contract changes block image rollback', () => {
  assert.throws(() =>
    makePlan(manifest('b', 'b', 'none', migrations.slice(0, -1)), manifest('a', 'a')),
  );
  assert.throws(() =>
    makePlan(
      manifest('b', 'b', 'none', [
        { ...migrations[0], sha256: 'f'.repeat(64) },
        ...migrations.slice(1),
      ]),
      manifest('a', 'a'),
    ),
  );
  assert.throws(() => makePlan(manifest('b', 'b', 'contract'), manifest('a', 'a')));
});

test('expand must be explicitly classified and is not automatic deploy', () => {
  const addition = { version: '0016_example.sql', sha256: 'f'.repeat(64) };
  assert.throws(() =>
    makePlan(manifest('b', 'b', 'none', [...migrations, addition]), manifest('a', 'a')),
  );
  assert.equal(
    makePlan(manifest('b', 'b', 'expand', [...migrations, addition]), manifest('a', 'a')).migration,
    'expand',
  );
});

test('0019 and 0021 require supervised migration review before a digest rollout', () => {
  assert.throws(
    () =>
      makePlan(
        manifest('b', 'b', 'expand', migrations),
        manifest('a', 'a', 'none', migrations.slice(0, 18)),
      ),
    /supervised migration strategy/,
  );
  assert.throws(
    () =>
      makePlan(
        manifest('b', 'b', 'expand', migrations),
        manifest('a', 'a', 'none', migrations.slice(0, 20)),
      ),
    /supervised migration strategy/,
  );
  assert.equal(
    makePlan(
      manifest('b', 'b', 'expand', migrations.slice(0, 18)),
      manifest('a', 'a', 'none', migrations.slice(0, 15)),
    ).migration,
    'expand',
  );
});

test('release execution requires explicit operator flag and paths', () => {
  assert.throws(() =>
    parseReleaseArgs(['deploy', '--plan', 'p', '--env-file', 'e', '--log', 'l', '--state', 's']),
  );
  assert.equal(
    parseReleaseArgs([
      'rollback',
      '--plan',
      'p',
      '--env-file',
      'e',
      '--log',
      'l',
      '--state',
      's',
      '--execute',
    ]).command,
    'rollback',
  );
});
