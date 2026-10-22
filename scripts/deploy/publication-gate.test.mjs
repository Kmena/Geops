import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizePublication } from './publication-gate.mjs';

const valid = {
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'Kmena/Geops',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  APPROVED_SHA: 'a'.repeat(40),
  PUBLISH: 'true',
};

test('publication requires reviewed main SHA in the expected repository', () => {
  assert.deepEqual(authorizePublication(valid), { publish: true, commit: valid.GITHUB_SHA });
  for (const change of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'attacker/Geops' },
    { GITHUB_REF: 'refs/heads/codex/deploy-p0' },
    { APPROVED_SHA: 'b'.repeat(40) },
    { APPROVED_SHA: `${'a'.repeat(40)}; exit 0` },
  ])
    assert.throws(() => authorizePublication({ ...valid, ...change }));
});

test('validation mode has no publication authorization', () => {
  assert.deepEqual(authorizePublication({ ...valid, PUBLISH: 'false', APPROVED_SHA: '' }), {
    publish: false,
  });
});
