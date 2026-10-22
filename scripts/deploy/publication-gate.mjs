import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function authorizePublication(env) {
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Manual invocation required');
  if (env.PUBLISH !== 'true') return { publish: false };
  assert.equal(env.GITHUB_REPOSITORY, 'Kmena/Geops', 'Unexpected repository');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Publishing requires main');
  assert.match(env.APPROVED_SHA ?? '', /^[a-f0-9]{40}$/, 'Full approved SHA required');
  assert.equal(env.GITHUB_SHA, env.APPROVED_SHA, 'Approved SHA differs from checkout');
  return { publish: true, commit: env.GITHUB_SHA };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = authorizePublication(process.env);
    console.log(JSON.stringify({ result: 'PUBLICATION_AUTHORIZED', ...result }));
  } catch (error) {
    console.error(`Publication BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
