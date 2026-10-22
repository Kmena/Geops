import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCompose, validatePlan } from './preflight.mjs';

const ref = (name, hex) => `registry.geops.internal/${name}@sha256:${hex.repeat(64)}`;
const plan = {
  schemaVersion: 1,
  commit: '1'.repeat(40),
  qaVariant: 'gps-base',
  migration: 'none',
  candidate: { api: ref('api', 'a'), web: ref('web', 'b') },
  previous: { api: ref('api', 'c'), web: ref('web', 'd') },
};

test('requires pinned, distinct rollback artifacts and blocks contract migrations', () => {
  assert.equal(validatePlan(plan), plan);
  assert.throws(() =>
    validatePlan({ ...plan, candidate: { ...plan.candidate, api: 'geops-api:latest' } }),
  );
  assert.throws(() =>
    validatePlan({ ...plan, previous: { ...plan.previous, api: plan.candidate.api } }),
  );
  assert.throws(() => validatePlan({ ...plan, migration: 'contract' }));
  assert.throws(() => validatePlan({ ...plan, qaVariant: undefined }));
});

test('digest overlay may change only API and Web images', () => {
  const before = {
    name: 'geops-spec02-staging',
    services: {
      'geops-api': {
        image: 'geops-api:old',
        volumes: ['security'],
        environment: { MDM_ENABLED: 'false' },
      },
      'geops-web': { image: 'geops-web:old', build: { args: { MDM_ENABLED: 'false' } } },
      'geops-db': { image: 'postgis:18' },
    },
    volumes: { stage_pgdata: {} },
  };
  const after = structuredClone(before);
  after.services['geops-api'].image = plan.candidate.api;
  after.services['geops-web'].image = plan.candidate.web;
  compareCompose(before, after, plan);
  after.services['geops-api'].image = plan.previous.api;
  after.services['geops-web'].image = plan.previous.web;
  compareCompose(before, after, plan, 'previous');
  after.services['geops-db'].image = 'postgis:latest';
  assert.throws(() => compareCompose(before, after, plan, 'previous'));
  const mdmBefore = structuredClone(before);
  mdmBefore.services['geops-api'].environment.MDM_ENABLED = 'true';
  mdmBefore.services['geops-web'].build.args.MDM_ENABLED = 'true';
  const mdmAfter = structuredClone(mdmBefore);
  mdmAfter.services['geops-api'].image = plan.candidate.api;
  mdmAfter.services['geops-web'].image = plan.candidate.web;
  compareCompose(mdmBefore, mdmAfter, { ...plan, qaVariant: 'mdm-qa' });
  assert.throws(() => compareCompose(mdmBefore, mdmAfter, plan));
});
