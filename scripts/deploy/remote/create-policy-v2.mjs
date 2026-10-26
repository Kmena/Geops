#!/usr/bin/env node
// Creates a review candidate only. It never installs policy or contacts a host.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const files = [
  'infrastructure/compose/compose.staging.yaml',
  'infrastructure/compose/compose.staging.digest.override.yaml',
  'infrastructure/nginx/geops-staging-web.conf',
  'infrastructure/staging/api-entrypoint.sh',
  'infrastructure/staging/backup.sh',
  'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
  'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const [output, aTag, region, extra] = process.argv.slice(2);
if (
  !output ||
  !/^[a-f0-9]{40}$/.test(aTag ?? '') ||
  !['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk'].includes(region) ||
  extra !== undefined
)
  throw Error('Usage: create-policy-v2.mjs OUTPUT A21_TAG REGION');
const profiles = {
  A21: {
    sqlCount: 21,
    sqlListSha256: 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e',
    variant: 'gps-base',
    mdmEnabled: false,
  },
  'B22-safe': {
    sqlCount: 22,
    sqlListSha256: 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2',
    variant: 'gps-base',
    mdmEnabled: false,
  },
  'B22-mdm': {
    sqlCount: 22,
    sqlListSha256: 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2',
    variant: 'mdm-qa',
    mdmEnabled: true,
  },
  'B23-safe': {
    sqlCount: 23,
    sqlListSha256: '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
    variant: 'gps-base',
    mdmEnabled: false,
  },
  'B23-mdm': {
    sqlCount: 23,
    sqlListSha256: '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
    variant: 'mdm-qa',
    mdmEnabled: true,
  },
};
const bundle = Object.fromEntries(
  files.map((name) => [
    name,
    hash(Buffer.from(readFileSync(resolve(root, name), 'utf8').replace(/\r\n/g, '\n'))),
  ]),
);
const controllers = Object.fromEntries(
  ['geops_deploy.py', 'geops_deploy_v2.py'].map((name) => [
    name,
    hash(
      Buffer.from(
        readFileSync(resolve(root, 'scripts/deploy/remote', name), 'utf8').replace(/\r\n/g, '\n'),
      ),
    ),
  ]),
);
const policy = {
  schemaVersion: 2,
  environment: 'geops-spec02-staging',
  origin: 'https://geops-staging.duckdns.org',
  secretGid: '24001',
  imageTag: aTag,
  backupMaxAgeSeconds: 86400,
  profiles,
  mdm: { region },
  files: bundle,
  controllers,
};
writeFileSync(output, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ result: 'V2_POLICY_CANDIDATE', sha256: hash(readFileSync(output)) }));
