import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('staging trust verifier requires the approved hash and an Ed25519 public key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geops-b30-key-'));
  try {
    const keyPath = join(dir, 'public.pem');
    const run = (sha) =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./verify-trust-key.mjs', import.meta.url)), keyPath, sha],
        { encoding: 'utf8' },
      );
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(keyPath, ed);
    const sha = createHash('sha256').update(ed).digest('hex');
    assert.equal(run(sha).status, 0);
    assert.equal(run('0'.repeat(64)).status, 1);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    writeFileSync(keyPath, rsa);
    const rsaSha = createHash('sha256').update(rsa).digest('hex');
    assert.equal(run(rsaSha).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
