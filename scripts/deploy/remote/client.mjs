#!/usr/bin/env node
// SSH client for the fixed root-owned Staging controller. Never accepts commands or hosts.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const id = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const operations = { status: 0, verify: 0, preflight: 1, prepare: 1, deploy: 2, rollback: 1 };
const [operation, ...args] = process.argv.slice(2);

function run(program, command, timeout) {
  const result = spawnSync(program, command, { stdio: 'inherit', timeout,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE } });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

if (operation === 'stage-release' || operation === 'stage-approval') {
  const [identity, document, signature] = args;
  if (args.length !== 3 || !id.test(identity)) throw new Error('Invalid signed document input');
  const data = JSON.parse(readFileSync(document, 'utf8'));
  if (data.id !== identity) throw new Error('Signed document ID differs from filename');
  const kind = operation === 'stage-release' ? 'release' : 'approval';
  // The server verifies the signature; these files are untrusted data in a writable inbox.
  const remote = `geops-staging:/var/lib/geops-deploy/inbox/${identity}.${kind}`;
  run('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    resolve(document), `${remote}.json`], 60_000);
  run('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    resolve(signature), `${remote}.sig`], 60_000);
} else if (Object.hasOwn(operations, operation)) {
  if (args.length !== operations[operation] || !args.every((item) => id.test(item))) {
    throw new Error('Invalid operation arguments');
  }
  const remote = ['sudo', '-n', '/usr/local/sbin/geops-deploy', operation, ...args].join(' ');
  run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    'geops-staging', remote],
  operation === 'deploy' || operation === 'rollback' ? 20 * 60_000 :
    operation === 'prepare' ? 8 * 60_000 : 4 * 60_000);
} else {
  throw new Error('Allowed: status, preflight, prepare, deploy, rollback, verify, stage-release, stage-approval');
}
