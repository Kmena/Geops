#!/usr/bin/env node
/** Actual Docker/Compose failure matrix; each case owns a new disposable project. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const controller = join(root, 'scripts/deploy/b30-lab/controller.mjs');
const primary = join(root, 'artifacts/b30-lab-primary');
const cases = [
  ['preflight', 'before-preflight', 23],
  ['bundle', 'before-prepare', 23],
  ['backup', 'after-backup', 23],
  ['before-api', 'before-api', 30],
  ['after-api', 'after-api', 30],
  ['before-web', 'before-web', 30],
  ['after-web', 'after-web', 30],
  ['during-health', 'before-health', 30],
  ['after-health', 'after-health', 30],
  ['before-ledger', 'before-confirm', 30],
  ['during-recovery', 'before-api', 30],
];
function call(action, dir, extra, expected = 0) {
  const args = [controller, action, dir, ...(extra ? [extra] : [])];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== expected)
    throw new Error(`${action} ${dir}: ${result.stderr || result.stdout}`);
  return result;
}
const summary = [];
try {
  for (const [name, fault, expectedSchema] of cases) {
    const dir = join(root, 'artifacts', `b30-lab-case-${name}`);
    if (existsSync(dir)) throw new Error(`Existing lab case: ${name}`);
    const started = Date.now();
    let projectStarted = false;
    try {
      const baseline = JSON.parse(call('clone', dir, primary).stdout);
      projectStarted = true;
      assert.equal(baseline.observed.schema, 23);
      const failed = call('upgrade', dir, fault, 1);
      assert.match(failed.stderr, /INJECTED_FAILURE/);
      const intermediate = JSON.parse(call('status', dir).stdout);
      assert.equal(intermediate.observed.schema, expectedSchema);
      if (name === 'during-recovery') {
        const again = call('recover', dir, 'during-recovery', 1);
        assert.match(again.stderr, /INJECTED_FAILURE:during-recovery/);
      }
      const recovered = JSON.parse(call('recover', dir).stdout);
      assert.equal(recovered.observed.schema, expectedSchema);
      assert.equal(recovered.observed.api, expectedSchema === 23 ? 'B23' : 'B30');
      assert.equal(recovered.observed.web, expectedSchema === 23 ? 'B23' : 'B30');
      assert.equal(recovered.observed.gate, 'open');
      call('recover', dir); // idempotent reexecution of the recovered state
      const row = {
        case: name,
        fault,
        schema: expectedSchema,
        result: 'PASS',
        durationMs: Date.now() - started,
        project: baseline.project,
      };
      summary.push(row);
      console.log(JSON.stringify(row));
    } finally {
      if (projectStarted) call('down', dir);
    }
  }
} finally {
  writeFileSync(
    join(root, 'artifacts/b30-lab-matrix-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
}
