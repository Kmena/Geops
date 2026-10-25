import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const generator = fileURLToPath(new URL('./remote/create-policy-v2.mjs', import.meta.url));
const a21 = '03e582fba66c0d29eab885e109d3404e86b140a3';

test('MDM customer and edition are discovered after OAuth, never required by policy', () => {
  const folder = mkdtempSync(join(tmpdir(), 'geops-policy-v2-'));
  try {
    const output = join(folder, 'policy.json');
    const generated = spawnSync(process.execPath, [generator, output, a21, 'com'], {
      encoding: 'utf8',
    });
    assert.equal(generated.status, 0, generated.stderr);
    const policy = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(policy.mdm, { region: 'com' });
    assert.equal(policy.profiles['B22-safe'].sqlCount, 22);
    assert.equal(policy.profiles['B22-mdm'].sqlCount, 22);
    const preloaded = spawnSync(
      process.execPath,
      [generator, join(folder, 'preloaded.json'), a21, 'com', 'TRIAL', '12345'],
      { encoding: 'utf8' },
    );
    assert.notEqual(preloaded.status, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
