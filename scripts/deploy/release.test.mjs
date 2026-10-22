import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { createManifest, migrationChecksums } from './create-manifest.mjs';
import { createPlan } from './create-plan.mjs';
import { assertImageMigrations, embeddedMigrationScript, parseReleaseArgs } from './release.mjs';

const ref = (service, digit) => `localhost:5000/geops-${service}@sha256:${digit.repeat(64)}`;
const migrations = migrationChecksums();

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
  assertImageMigrations(actual, migrations);
});
const manifest = (commit, digit, migration = 'none', set = migrations) =>
  createManifest({
    commit: commit.repeat(40),
    api: ref('api', digit),
    web: ref('web', digit),
    ciRun: 'https://github.com/example/geops/actions/runs/123',
    ciResult: 'success',
    migration,
    migrations: set,
  });

test('immutable manifests retain real SQL checksums and compose a rollback plan', () => {
  assert.equal(migrations.length, 21);
  const plan = createPlan(manifest('b', 'b'), manifest('a', 'a'));
  assert.equal(plan.migration, 'none');
  assert.equal(plan.candidate.api, ref('api', 'b'));
  assert.equal(plan.previous.web, ref('web', 'a'));
  assert.equal(plan.provenance.previousCommit, 'a'.repeat(40));
});

test('SQL rewrites and contract changes block image rollback', () => {
  assert.throws(() =>
    createPlan(manifest('b', 'b', 'none', migrations.slice(0, -1)), manifest('a', 'a')),
  );
  assert.throws(() =>
    createPlan(
      manifest('b', 'b', 'none', [
        { ...migrations[0], sha256: 'f'.repeat(64) },
        ...migrations.slice(1),
      ]),
      manifest('a', 'a'),
    ),
  );
  assert.throws(() => createPlan(manifest('b', 'b', 'contract'), manifest('a', 'a')));
});

test('expand must be explicitly classified and is not automatic deploy', () => {
  const addition = { version: '0016_example.sql', sha256: 'f'.repeat(64) };
  assert.throws(() =>
    createPlan(manifest('b', 'b', 'none', [...migrations, addition]), manifest('a', 'a')),
  );
  assert.equal(
    createPlan(manifest('b', 'b', 'expand', [...migrations, addition]), manifest('a', 'a'))
      .migration,
    'expand',
  );
});

test('0019 and 0021 require supervised migration review before a digest rollout', () => {
  assert.throws(
    () =>
      createPlan(
        manifest('b', 'b', 'expand', migrations),
        manifest('a', 'a', 'none', migrations.slice(0, 18)),
      ),
    /supervised migration strategy/,
  );
  assert.throws(
    () =>
      createPlan(
        manifest('b', 'b', 'expand', migrations),
        manifest('a', 'a', 'none', migrations.slice(0, 20)),
      ),
    /supervised migration strategy/,
  );
  assert.equal(
    createPlan(
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
