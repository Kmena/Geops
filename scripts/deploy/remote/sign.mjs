#!/usr/bin/env node
// Runs only on the approver's trusted machine; never copy the private key to Staging.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [kind, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith('--') || !rest[i + 1]) throw new Error('Named options required');
  const name = rest[i].slice(2);
  if (Object.hasOwn(options, name)) throw new Error('Duplicate option');
  options[name] = rest[i + 1];
}
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{64}$/;
if (!id.test(options.id ?? '') || !options.key || !options.out || !options.policy) {
  throw new Error('id, key, out and policy required');
}
const policyBytes = Buffer.from(readFileSync(options.policy, 'utf8').replace(/\r\n/g, '\n'));
const policy = JSON.parse(policyBytes.toString());
if (policy.environment !== 'geops-spec02-staging') throw new Error('Wrong environment');
const policySha256 = createHash('sha256').update(policyBytes).digest('hex');
const now = new Date();
const expiry = new Date(now.getTime() + (kind === 'release' ? 7 * 86400_000 : 20 * 60_000));
const common = { schemaVersion: 1, id: options.id, environment: policy.environment,
  notBefore: new Date(now.getTime() - 60_000).toISOString().replace('.000Z', 'Z'),
  expiresAt: expiry.toISOString().replace('.000Z', 'Z') };

let document;
if (kind === 'release') {
  if (!options.manifest) throw new Error('Published manifest required');
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const canonicalSql = manifest.migrations.map((item) => `${item.version}|${item.sha256}`).join('\n');
  const sqlHash = createHash('sha256').update(canonicalSql).digest('hex');
  if (manifest.schemaVersion !== 3 || manifest.ci?.result !== 'success' ||
      manifest.migration !== 'none' || manifest.migrations.length !== policy.sqlCount ||
      sqlHash !== policy.sqlListSha256 || policy.variant !== 'gps-base' ||
      manifest.webBuild?.gpsBase?.variant !== 'gps-base' ||
      manifest.webBuild.gpsBase.mdmEnabled !== false ||
      !/^[a-f0-9]{40}$/.test(manifest.commit)) throw new Error('Manifest differs from policy');
  document = { ...common, commit: manifest.commit, api: manifest.images.api,
    web: manifest.images.web.gpsBase, variant: 'gps-base', sqlCount: policy.sqlCount,
    sqlListSha256: policy.sqlListSha256, policySha256 };
} else if (kind === 'approval') {
  if (!['deploy', 'rollback'].includes(options.action) ||
      !sha.test(options['release-sha'] ?? '') ||
      ![options['source-api-id'], options['source-web-id'],
        options['target-api-id'], options['target-web-id']].every((item) => imageId.test(item ?? ''))) {
    throw new Error('Action, release SHA and four exact image IDs required');
  }
  document = { ...common, action: options.action, releaseSha256: options['release-sha'],
    policySha256, sourceApiId: options['source-api-id'],
    sourceWebId: options['source-web-id'], targetApiId: options['target-api-id'],
    targetWebId: options['target-web-id'] };
} else {
  throw new Error('Allowed: release or approval');
}

const key = createPrivateKey(readFileSync(options.key));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required');
const body = Buffer.from(JSON.stringify(document, null, 2) + '\n');
const signature = sign(null, body, key);
writeFileSync(`${options.out}.${kind}.json`, body, { flag: 'wx', mode: 0o600 });
writeFileSync(`${options.out}.${kind}.sig`, signature, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ id: document.id, action: kind === 'approval' ? document.action : 'release',
  documentSha256: createHash('sha256').update(body).digest('hex'),
  expiresAt: document.expiresAt }));
