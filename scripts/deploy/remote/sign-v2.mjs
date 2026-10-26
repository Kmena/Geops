#!/usr/bin/env node
// Offline approver only. Private Ed25519 key never goes to Staging.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [kind, ...rest] = process.argv.slice(2);
const options = {};
for (let index = 0; index < rest.length; index += 2) {
  if (!rest[index]?.startsWith('--') || !rest[index + 1]) throw Error('Named options required');
  const name = rest[index].slice(2);
  if (Object.hasOwn(options, name)) throw Error('Duplicate option');
  options[name] = rest[index + 1];
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const hex64 = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const registry = (service) => new RegExp(`^ghcr\\.io/kmena/geops-${service}@sha256:[a-f0-9]{64}$`);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const A21 = 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e';
const B22 = 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2';
const B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d';
const profiles = {
  A21: { sqlCount: 21, sqlListSha256: A21, variant: 'gps-base', mdmEnabled: false },
  'B22-safe': { sqlCount: 22, sqlListSha256: B22, variant: 'gps-base', mdmEnabled: false },
  'B22-mdm': { sqlCount: 22, sqlListSha256: B22, variant: 'mdm-qa', mdmEnabled: true },
  'B23-safe': { sqlCount: 23, sqlListSha256: B23, variant: 'gps-base', mdmEnabled: false },
  'B23-mdm': { sqlCount: 23, sqlListSha256: B23, variant: 'mdm-qa', mdmEnabled: true },
};
if (!idPattern.test(options.id ?? '') || !options.key || !options.out || !options.policy)
  throw Error('id, key, out and policy required');
const policyBytes = Buffer.from(readFileSync(options.policy, 'utf8').replace(/\r\n/g, '\n'));
const policy = JSON.parse(policyBytes.toString());
if (
  policy.schemaVersion !== 2 ||
  policy.environment !== 'geops-spec02-staging' ||
  JSON.stringify(policy.profiles) !== JSON.stringify(profiles) ||
  !policy.mdm ||
  Object.keys(policy.mdm).sort().join(',') !== 'region' ||
  !['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk'].includes(policy.mdm.region)
)
  throw Error('V2 policy required');
const policySha256 = sha(policyBytes);
const now = new Date();
const expiry = new Date(now.getTime() + (kind === 'release' ? 7 * 86400_000 : 20 * 60_000));
const common = {
  schemaVersion: 2,
  id: options.id,
  environment: policy.environment,
  notBefore: new Date(now.getTime() - 60_000).toISOString().replace('.000Z', 'Z'),
  expiresAt: expiry.toISOString().replace('.000Z', 'Z'),
};
let document;
if (kind === 'release') {
  if (!['B23-safe', 'B23-mdm'].includes(options.profile) || !options.manifest)
    throw Error('B23 profile and published manifest required');
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const entries = manifest.migrations;
  if (
    !Array.isArray(entries) ||
    entries.length !== 23 ||
    entries.some(
      (entry) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.version) || !hex64.test(entry.sha256),
    ) ||
    sha(entries.map((entry) => `${entry.version}|${entry.sha256}`).join('\n')) !== B23 ||
    sha(
      entries
        .slice(0, 22)
        .map((entry) => `${entry.version}|${entry.sha256}`)
        .join('\n'),
    ) !== B22 ||
    sha(
      entries
        .slice(0, 21)
        .map((entry) => `${entry.version}|${entry.sha256}`)
        .join('\n'),
    ) !== A21 ||
    manifest.schemaVersion !== 4 ||
    manifest.migration !== 'expand' ||
    manifest.ci?.result !== 'success' ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(manifest.ci?.run ?? '') ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(
      manifest.publication?.run ?? '',
    ) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit)
  )
    throw Error('Manifest provenance or SQL mismatch');
  const key = options.profile === 'B23-safe' ? 'safe' : 'mdm';
  const api = manifest.images?.api?.[key];
  const web = manifest.images?.web?.[key === 'safe' ? 'gpsBase' : 'mdmQa'];
  if (
    !registry('api').test(api ?? '') ||
    !registry('web').test(web ?? '') ||
    manifest.images.api.safe === manifest.images.api.mdm ||
    manifest.images.web.gpsBase === manifest.images.web.mdmQa ||
    manifest.apiBuild?.[key]?.variant !== options.profile ||
    manifest.apiBuild?.[key]?.mdmEnabled !== profiles[options.profile].mdmEnabled ||
    manifest.webBuild?.[key === 'safe' ? 'gpsBase' : 'mdmQa']?.variant !==
      profiles[options.profile].variant ||
    manifest.webBuild?.[key === 'safe' ? 'gpsBase' : 'mdmQa']?.mdmEnabled !==
      profiles[options.profile].mdmEnabled
  )
    throw Error('Image profile mismatch');
  document = {
    ...common,
    commit: manifest.commit,
    api,
    web,
    profile: options.profile,
    sqlCount: 23,
    sqlListSha256: B23,
    policySha256,
  };
} else if (kind === 'restore') {
  if (!options.evidence) throw Error('Isolated restore evidence required');
  const evidenceBytes = readFileSync(options.evidence);
  const evidence = JSON.parse(evidenceBytes.toString());
  if (
    evidence.result !== 'PASS' ||
    !hex64.test(evidence.backupSha256 ?? '') ||
    ![21, 22].includes(evidence.sqlCount) ||
    evidence.sqlListSha256 !== (evidence.sqlCount === 21 ? A21 : B22) ||
    !Number.isFinite(Date.parse(evidence.restoredAt ?? '')) ||
    !evidence.isolatedDatabase ||
    !/^geops_verify_[0-9]+_restore$/.test(evidence.isolatedDatabase)
  )
    throw Error('Restore evidence is incomplete');
  document = {
    ...common,
    backupSha256: evidence.backupSha256,
    sqlCount: evidence.sqlCount,
    sqlListSha256: evidence.sqlListSha256,
    restoredAt: evidence.restoredAt,
    result: 'PASS',
    evidenceSha256: sha(evidenceBytes),
    policySha256,
  };
} else if (kind === 'approval') {
  const action = options.action;
  const transitions = {
    deploy: [
      ['B22-safe', 'B22-mdm'],
      ['B23-safe', 'B23-mdm'],
    ],
    rollback: [
      ['B22-mdm', 'B22-safe'],
      ['B23-mdm', 'B23-safe'],
    ],
    'promote22-begin': [['A21', 'B22-safe']],
    'promote22-resume': [['A21', 'B22-safe']],
    'promote22-complete': [['A21', 'B22-safe']],
    'promote22-abort21': [['A21', 'A21']],
    'promote23-begin': [['B22-mdm', 'B23-safe']],
    'promote23-resume': [['B22-mdm', 'B23-safe']],
    'promote23-complete': [['B22-mdm', 'B23-safe']],
    'promote23-abort22': [['B22-mdm', 'B22-mdm']],
  };
  if (
    !Object.hasOwn(transitions, action) ||
    !transitions[action].some(
      ([source, target]) =>
        source === options['source-profile'] && target === options['target-profile'],
    ) ||
    ![
      options['source-api-id'],
      options['source-web-id'],
      options['target-api-id'],
      options['target-web-id'],
    ].every((value) => imageId.test(value ?? ''))
  )
    throw Error('Invalid action, profile transition or image IDs');
  const promotion = action.startsWith('promote22-') || action.startsWith('promote23-');
  let releaseSha256 = null;
  let release;
  if (action !== 'promote22-abort21') {
    if (!options['release-document'] || !hex64.test(options['release-sha'] ?? ''))
      throw Error('Signed release bytes and SHA required');
    const releaseBytes = readFileSync(options['release-document']);
    releaseSha256 = sha(releaseBytes);
    if (releaseSha256 !== options['release-sha']) throw Error('Release SHA mismatch');
    release = JSON.parse(releaseBytes.toString());
    if (release.schemaVersion !== 2 || release.profile !== options['target-profile'])
      throw Error('Release profile mismatch');
    if (release.policySha256 !== policySha256) {
      if (
        !['rollback', 'promote23-abort22'].includes(action) ||
        !options['previous-policy'] ||
        !options['release-signature']
      )
        throw Error('Release policy mismatch');
      const previousPolicyBytes = Buffer.from(
        readFileSync(options['previous-policy'], 'utf8').replace(/\r\n/g, '\n'),
      );
      const previousPolicy = JSON.parse(previousPolicyBytes.toString());
      if (
        sha(previousPolicyBytes) !== release.policySha256 ||
        previousPolicy.schemaVersion !== 2 ||
        previousPolicy.environment !== policy.environment ||
        !['B22-safe', 'B22-mdm'].every(
          (name) =>
            JSON.stringify(previousPolicy.profiles?.[name]) === JSON.stringify(profiles[name]),
        ) ||
        previousPolicy.origin !== policy.origin
      )
        throw Error('Previous release policy mismatch');
      const releaseSigner = createPublicKey(createPrivateKey(readFileSync(options.key)));
      if (!verify(null, releaseBytes, releaseSigner, readFileSync(options['release-signature'])))
        throw Error('Previous release signature mismatch');
    }
  } else {
    release = {
      commit: options['target-commit'],
      api: options['target-api-ref'],
      web: options['target-web-ref'],
    };
    if (
      !/^[a-f0-9]{40}$/.test(release.commit ?? '') ||
      !/^geops-spec02-api:[a-f0-9]{40}$/.test(release.api ?? '') ||
      !/^geops-spec02-web:[a-f0-9]{40}$/.test(release.web ?? '')
    )
      throw Error('Exact A21 target required');
  }
  const backupSha256 = promotion ? options['backup-sha'] : null;
  const restoreSha256 = promotion ? options['restore-sha'] : null;
  const epoch = promotion ? options.epoch : null;
  if (
    promotion &&
    (!hex64.test(backupSha256 ?? '') ||
      !hex64.test(restoreSha256 ?? '') ||
      !/^[a-f0-9-]{36}$/.test(epoch ?? ''))
  )
    throw Error('Promotion evidence binding required');
  document = {
    ...common,
    action,
    releaseSha256,
    releaseCommit: release.commit,
    apiDigest: release.api,
    webDigest: release.web,
    policySha256,
    sourceApiId: options['source-api-id'],
    sourceWebId: options['source-web-id'],
    targetApiId: options['target-api-id'],
    targetWebId: options['target-web-id'],
    sourceProfile: options['source-profile'],
    targetProfile: options['target-profile'],
    backupSha256,
    restoreSha256,
    epoch,
  };
} else throw Error('Allowed: release, restore, approval');

const key = createPrivateKey(readFileSync(options.key));
if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 key required');
const body = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
const signature = sign(null, body, key);
writeFileSync(`${options.out}.${kind}.json`, body, { flag: 'wx', mode: 0o600 });
writeFileSync(`${options.out}.${kind}.sig`, signature, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    id: document.id,
    action: kind === 'approval' ? document.action : kind,
    documentSha256: sha(body),
    expiresAt: document.expiresAt,
  }),
);
