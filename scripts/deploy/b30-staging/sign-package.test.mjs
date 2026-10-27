import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sha = (body) => createHash('sha256').update(body).digest('hex');
const signer = fileURLToPath(new URL('./sign-package.mjs', import.meta.url));
const candidate = fileURLToPath(
  new URL(
    '../../../specs/spec-03-clients-geofences-routes/b30-staging-candidate.json',
    import.meta.url,
  ),
);

test('offline signer accepts an exact READY fixture and rejects changed content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geops-b30-sign-test-'));
  try {
    const src = join(dir, 'source');
    mkdirSync(src);
    const keys = generateKeyPairSync('ed25519');
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const publicPath = join(dir, 'public.pem');
    const privatePath = join(dir, 'private.pem');
    writeFileSync(publicPath, publicPem);
    writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    const names = [
      'public.pem',
      'scripts/deploy/b30-staging/controller.py',
      'scripts/deploy/b30-staging/guard.py',
      'scripts/deploy/b30-staging/install.py',
      'scripts/deploy/b30-staging/sudoers-ready',
      'specs/spec-03-clients-geofences-routes/b30-staging-candidate.json',
    ];
    const files = {};
    for (const name of names) {
      const path = join(src, name);
      mkdirSync(dirname(path), { recursive: true });
      if (name === 'public.pem') writeFileSync(path, publicPem);
      else if (name.endsWith('b30-staging-candidate.json')) copyFileSync(candidate, path);
      else writeFileSync(path, 'synthetic fixture only\n');
      files[name] = sha(readFileSync(path));
    }
    const policy = {
      kind: 'B30_STAGING_READY',
      activation: 'READY',
      publicationReady: true,
      trustKeySha256: sha(publicPem),
      applicationCommit: '2f89b87f1f636feb7e21d7e09af03959ee95f68d',
      candidateManifestSha256: '3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b',
      migrations: {
        sourceCount: 23,
        sourceListSha256: '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
        targetCount: 30,
        targetListSha256: '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
      },
      sourceB23: { wrapperSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64) },
      registryDigests: {
        api: `ghcr.io/kmena/geops-api@sha256:${'c'.repeat(64)}`,
        web: `ghcr.io/kmena/geops-web@sha256:${'d'.repeat(64)}`,
      },
      files,
    };
    writeFileSync(join(src, 'policy.json'), JSON.stringify(policy));
    const archive = join(dir, 'ready.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'policy.json', ...names]);
    const signature = join(dir, 'ready.sig');
    const run = (a, s) =>
      spawnSync(process.execPath, [signer, a, publicPath, privatePath, sha(publicPem), s], {
        encoding: 'utf8',
      });
    assert.equal(run(archive, signature).status, 0);
    const message = Buffer.from(
      `GEOPS-B30-STAGING-PACKAGE-SHA256\n${sha(readFileSync(archive))}\n`,
    );
    assert.ok(verify(null, message, keys.publicKey, readFileSync(signature)));
    writeFileSync(join(src, 'scripts/deploy/b30-staging/controller.py'), 'altered\n');
    const altered = join(dir, 'altered.tar.gz');
    execFileSync('tar', ['-czf', altered, '-C', src, 'policy.json', ...names]);
    assert.equal(run(altered, join(dir, 'altered.sig')).status, 1);
  } finally {
    const resolved = realpathSync(dir);
    const temp = realpathSync(tmpdir());
    assert.ok(
      resolved.startsWith(`${temp}${sep}`) && basename(resolved).startsWith('geops-b30-sign-test-'),
    );
    rmSync(resolved, { recursive: true, force: true });
  }
});
