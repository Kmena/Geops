#!/usr/bin/env node
/** Mutates one ignored laboratory file at a time and restores its original bytes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dir = resolve(process.argv[2] ?? '');
if (
  dirname(dir) !== join(root, 'artifacts') ||
  !/^b30-lab-[a-z0-9-]+$/.test(dir.split(/[\\/]/).at(-1))
)
  throw new Error('Isolated lab required');
const controller = join(root, 'scripts/deploy/b30-lab/controller.mjs');
const cases = [
  {
    name: 'tampered-manifest',
    file: 'lab-manifest.json',
    action: 'verify',
    change: (bytes) =>
      Buffer.from(bytes.toString().replace('"targetSchema": 30', '"targetSchema": 29')),
  },
  {
    name: 'invalid-signature',
    file: 'lab-manifest.sig',
    action: 'verify',
    change: (bytes) => {
      const changed = Buffer.from(bytes);
      changed[0] ^= 0xff;
      return changed;
    },
  },
  {
    name: 'unexpected-image',
    file: 'context.json',
    action: 'verify',
    change: (bytes) =>
      Buffer.from(bytes.toString().replace(/sha256:[a-f0-9]{64}/, `sha256:${'0'.repeat(64)}`)),
  },
  {
    name: 'missing-secret',
    file: '.env',
    action: 'verify',
    change: (bytes) => Buffer.from(bytes.toString().replace(/^GEOPS_LAB_ADMIN_CSRF_KEY=.*\n/m, '')),
  },
  {
    name: 'incomplete-journal',
    file: 'journal.json',
    action: 'upgrade',
    change: (bytes) =>
      Buffer.from(
        bytes.toString().replace('"lastCompleted": "confirm"', '"lastCompleted": "unknown"'),
      ),
  },
];
for (const item of cases) {
  const file = join(dir, item.file);
  const original = readFileSync(file);
  const altered = item.change(original);
  assert.notDeepEqual(altered, original, `Fixture did not alter ${item.name}`);
  try {
    writeFileSync(file, altered);
    const result = spawnSync(process.execPath, [controller, item.action, dir], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 1, `${item.name} was accepted`);
    assert.match(result.stderr, /"result":"BLOCKED"/);
    console.log(JSON.stringify({ check: item.name, result: 'REJECTED' }));
  } finally {
    writeFileSync(file, original);
  }
}
const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
const compose = join(root, 'infrastructure/compose/compose.b30-deployment-lab.yaml');
const dbPort = spawnSync(
  'docker',
  [
    'compose',
    '-p',
    ctx.project,
    '-f',
    compose,
    '--env-file',
    join(dir, '.env'),
    'port',
    'db',
    '5432',
  ],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(dbPort.status, 0);
const port = /127\.0\.0\.1:(\d+)$/.exec(dbPort.stdout.trim())?.[1];
assert.ok(port);
const pass = /^GEOPS_LAB_DB_PASSWORD=(.+)$/m.exec(readFileSync(join(dir, '.env'), 'utf8'))?.[1];
assert.match(pass, /^[a-f0-9]{64}$/);
const pool = new pg.Pool({
  connectionString: `postgres://postgres:${pass}@127.0.0.1:${port}/geops_dev`,
});
const version = '0030_gps_continuity_geops_owner.sql';
try {
  const original = (
    await pool.query('SELECT checksum FROM geops_schema_migrations WHERE version=$1', [version])
  ).rows[0]?.checksum;
  assert.match(original, /^[a-f0-9]{64}$/);
  try {
    await pool.query('UPDATE geops_schema_migrations SET checksum=$1 WHERE version=$2', [
      '0'.repeat(64),
      version,
    ]);
    const result = spawnSync(process.execPath, [controller, 'upgrade', dir], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 1, 'Altered migration ledger was accepted');
    assert.match(result.stderr, /Completed B30 journal differs from live state/);
    console.log(JSON.stringify({ check: 'altered-ledger', result: 'REJECTED' }));
  } finally {
    await pool.query('UPDATE geops_schema_migrations SET checksum=$1 WHERE version=$2', [
      original,
      version,
    ]);
  }
} finally {
  await pool.end();
}
const downgrade = spawnSync(process.execPath, [controller, 'rollback', dir], {
  cwd: root,
  encoding: 'utf8',
  timeout: 30_000,
});
assert.equal(downgrade.status, 1);
console.log(JSON.stringify({ check: 'unsupported-downgrade', result: 'REJECTED' }));
