import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function selectSuccessfulRun(payload, sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'Full source SHA required');
  const run = payload?.workflow_runs?.find(
    (item) =>
      item.head_sha === sha &&
      item.head_branch === 'main' &&
      item.event === 'push' &&
      item.status === 'completed' &&
      item.conclusion === 'success' &&
      /^https:\/\/github\.com\/Kmena\/Geops\/actions\/runs\/\d+$/.test(item.html_url ?? ''),
  );
  assert.ok(run, 'Successful SPEC-02 main CI for this exact SHA is required');
  return run.html_url;
}

async function main() {
  const sha = process.env.GITHUB_SHA;
  assert.equal(process.env.GITHUB_REPOSITORY, 'Kmena/Geops', 'Unexpected repository');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Main ref required');
  assert.ok(process.env.GITHUB_TOKEN, 'GitHub Actions read token required');
  assert.ok(process.env.GITHUB_OUTPUT, 'GitHub output path required');
  const url = new URL(
    'https://api.github.com/repos/Kmena/Geops/actions/workflows/spec-02.yml/runs',
  );
  url.searchParams.set('head_sha', sha);
  url.searchParams.set('per_page', '30');
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, 'Cannot verify source CI');
  const ciRun = selectSuccessfulRun(await response.json(), sha);
  appendFileSync(process.env.GITHUB_OUTPUT, `ci_run=${ciRun}\n`);
  console.log('Exact main source CI verified');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Source CI verification blocked; details withheld');
    process.exitCode = 1;
  });
}
