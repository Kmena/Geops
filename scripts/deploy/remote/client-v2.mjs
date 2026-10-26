#!/usr/bin/env node
// Fixed host and command inventory; this path is not installed or authorized yet.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const id = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const operations = {
  status: 0,
  'inspect-evidence': 0,
  verify: 0,
  recover: 0,
  prepare: 1,
  deploy: 2,
  rollback: 1,
  'promote22-begin': 3,
  'promote22-resume': 1,
  'promote22-complete': 1,
  'promote22-abort21': 1,
  'promote23-begin': 3,
  'promote23-resume': 1,
  'promote23-complete': 1,
  'promote23-abort22': 1,
};
const [operation, ...args] = process.argv.slice(2);
function run(program, command, timeout) {
  const result = spawnSync(program, command, {
    stdio: 'inherit',
    timeout,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    },
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
if (['stage-release', 'stage-approval', 'stage-restore'].includes(operation)) {
  const [identity, document, signature] = args;
  if (args.length !== 3 || !id.test(identity)) throw Error('Invalid signed document input');
  const data = JSON.parse(readFileSync(document, 'utf8'));
  if (data.id !== identity || data.schemaVersion !== 2) throw Error('Wrong v2 document identity');
  const kind = operation.slice('stage-'.length);
  const remote = `geops-staging:/var/lib/geops-deploy/inbox/${identity}.${kind}`;
  for (const [source, suffix] of [
    [document, '.json'],
    [signature, '.sig'],
  ])
    run(
      'scp',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        resolve(source),
        `${remote}${suffix}`,
      ],
      60_000,
    );
} else if (Object.hasOwn(operations, operation)) {
  if (args.length !== operations[operation] || !args.every((item) => id.test(item)))
    throw Error('Invalid operation arguments');
  const remote = ['sudo', '-n', '/usr/local/sbin/geops-deploy-v2', operation, ...args].join(' ');
  run(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'geops-staging', remote],
    operation === 'deploy' ||
      operation === 'rollback' ||
      operation.startsWith('promote22-') ||
      operation.startsWith('promote23-')
      ? 20 * 60_000
      : operation === 'prepare'
        ? 8 * 60_000
        : 4 * 60_000,
  );
} else throw Error('Unknown fixed v2 operation');
