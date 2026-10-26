#!/usr/bin/env node
/** Installs a pinned, signed local launcher. This never installs sudoers or contacts a host. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const target = resolve(process.argv[2] ?? '');
if (
  dirname(target) !== join(root, 'artifacts') ||
  !/^b30-controller-install-[a-z0-9-]+$/.test(target.split(/[\\/]/).at(-1))
)
  throw new Error('Only a direct artifacts/b30-controller-install-* target is allowed');
const paths = [
  'package.json',
  'package-lock.json',
  'scripts/deploy/b30-lab/controller.mjs',
  'scripts/deploy/b30-lab/seed-b23.mjs',
  'scripts/deploy/spec03-upgrade-supervisor.mjs',
  'infrastructure/compose/compose.b30-deployment-lab.yaml',
  'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  schemaVersion: 1,
  kind: 'B30_LOCAL_CONTROLLER_INSTALL',
  root,
  installedAt: new Date().toISOString(),
  files: paths.map((path) => ({ path, sha256: sha(readFileSync(join(root, path))) })),
};
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const signature = sign(null, bytes, privateKey).toString('base64');
const launcher = `#!/usr/bin/env node
import { createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const installed = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(installed, 'manifest.json'));
const publicKey = ${JSON.stringify(publicPem)};
const signature = Buffer.from(${JSON.stringify(signature)}, 'base64');
if (!verify(null, bytes, publicKey, signature)) throw Error('Installed B30 bundle signature mismatch');
const manifest = JSON.parse(bytes);
if (manifest.schemaVersion !== 1 || manifest.kind !== 'B30_LOCAL_CONTROLLER_INSTALL' ||
    !Array.isArray(manifest.files) || manifest.files.length !== ${paths.length})
  throw Error('Installed B30 bundle inventory invalid');
for (const item of manifest.files) {
  if (item.path.includes('..') || !/^[a-f0-9]{64}$/.test(item.sha256) ||
      createHash('sha256').update(readFileSync(join(manifest.root, item.path))).digest('hex') !== item.sha256)
    throw Error('Installed B30 bundle checksum mismatch');
}
const result = spawnSync(process.execPath,
  [join(manifest.root, 'scripts/deploy/b30-lab/controller.mjs'), ...process.argv.slice(2)],
  { cwd: manifest.root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`;
mkdirSync(target, { recursive: false });
writeFileSync(join(target, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
writeFileSync(join(target, 'launcher.mjs'), launcher, { flag: 'wx', mode: 0o500 });
console.log(
  JSON.stringify({
    result: 'LOCAL_CONTROLLER_INSTALLED',
    target,
    manifestSha256: sha(bytes),
    publicKeySha256: sha(Buffer.from(publicPem)),
  }),
);
