import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSuccessfulRun } from './verify-source-ci.mjs';

const sha = 'a'.repeat(40);
const run = (overrides = {}) => ({
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/Kmena/Geops/actions/runs/123',
  ...overrides,
});

test('publication requires successful CI of the exact main commit', () => {
  assert.equal(selectSuccessfulRun({ workflow_runs: [run()] }, sha), run().html_url);
  for (const altered of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'codex/feature' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { html_url: 'https://example.invalid/run/123' },
  ]) {
    assert.throws(() => selectSuccessfulRun({ workflow_runs: [run(altered)] }, sha));
  }
});
