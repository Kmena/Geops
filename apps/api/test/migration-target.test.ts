import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveMigrationTarget } from '../src/db/migration-target.js';

const base = {
  GEOPS_DATA_MODE: 'synthetic',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/geops_verify_123_restore',
  GEOPS_TEST_DB: 'geops_verify_123_restore',
  GEOPS_MIGRATION_TARGET: 'geops_verify_123_restore',
  GEOPS_CONFIRM_MIGRATION_TARGET: 'geops_verify_123_restore',
};
test('migration destination is explicit and never rewritten', () => {
  assert.equal(resolveMigrationTarget(base).name, 'geops_verify_123_restore');
  for (const patch of [
    { GEOPS_DATA_MODE: 'production' },
    { DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/geops_dev' },
    { DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/geops_verify_999_restore' },
    {
      DATABASE_URL:
        'postgresql://synthetic:synthetic@localhost:5432/geops_verify_123_restore?sslmode=disable',
    },
    { GEOPS_TEST_DB: 'geops_verify_999_restore' },
    { GEOPS_TEST_DB: 'geops_dev' },
    { GEOPS_MIGRATION_TARGET: 'geops_verify_999_restore' },
    { GEOPS_CONFIRM_MIGRATION_TARGET: undefined },
  ]) {
    assert.throws(() => resolveMigrationTarget({ ...base, ...patch }));
  }
});
test('non-disposable synthetic development database requires separate acknowledgement', () => {
  const dev = {
    ...base,
    DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/geops_dev',
    GEOPS_TEST_DB: undefined,
    GEOPS_MIGRATION_TARGET: 'geops_dev',
    GEOPS_CONFIRM_MIGRATION_TARGET: 'geops_dev',
  };
  assert.throws(() => resolveMigrationTarget(dev));
  assert.equal(
    resolveMigrationTarget({ ...dev, GEOPS_ALLOW_NONDISPOSABLE_MIGRATION: 'YES' }).name,
    'geops_dev',
  );
});
