import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GEOPS_RESTORE_ROOT, prepareRestore, reopenRestore } from './restore-synthetic.mjs';

const epoch = '11111111-1111-4111-8111-111111111111';
test('restore order, failure closure, retry and explicit reopen', async () => {
  const target = `geops_verify_${Date.now()}${randomInt(100000)}_restore`;
  const local = join(GEOPS_RESTORE_ROOT, 'infrastructure', 'compose', '.local');
  const backupDir = join(local, 'backups');
  const backup = join(backupDir, `${target}.dump`);
  const evidence = join(local, `restore-${target}.jsonl`);
  await mkdir(backupDir, { recursive: true });
  const bytes = Buffer.from('SYNTHETIC_GEOPS_BACKUP_ONLY');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(backup, bytes);
  let exists = false;
  let active = 'geops_dev';
  let failAt = 'pg_restore';
  const calls = [];
  const runner = {
    readComposeDatabase: () => active,
    gate: (mode) => {
      calls.push(`gate:${mode}`);
      return `phase=closed; epoch=${epoch}`;
    },
    composeRun: (args) => {
      calls.push(`compose:${args.join(' ')}`);
      if (args.includes('pg_restore') && failAt === 'pg_restore')
        throw new Error('simulated restore failure');
      if (args.includes('sha256sum')) return `${sha256}  /tmp/synthetic.dump`;
      return '';
    },
    docker: (args) => calls.push(`docker:${args[0]}`),
    dbSql: (sql) => {
      calls.push(`db:${sql.split(' ')[0]}`);
      if (sql.startsWith('SELECT')) return exists ? '1' : '0';
      if (sql.startsWith('CREATE')) exists = true;
      if (sql.startsWith('DROP')) exists = false;
      return '';
    },
    apiCommand: (name) => {
      calls.push(`api:${name}`);
      if (failAt === 'quarantine') throw new Error('simulated quarantine failure');
    },
    assertStopped: () => calls.push('stopped'),
    assertNoConnections: () => calls.push('drained'),
    readiness: async () => true,
  };
  try {
    await assert.rejects(prepareRestore({ target, backup, sha256 }, runner));
    assert.deepEqual(calls.slice(0, 4), [
      'gate:close',
      'compose:stop -t 30 geops-web geops-api geops-migrate',
      'stopped',
      'drained',
    ]);
    assert.ok(!calls.some((call) => call === 'gate:open'));
    calls.length = 0;
    failAt = 'quarantine';
    await assert.rejects(prepareRestore({ target, backup, sha256, resetTarget: target }, runner));
    assert.ok(calls.some((call) => call.startsWith('db:DROP')));
    assert.ok(!calls.some((call) => call === 'gate:open'));
    calls.length = 0;
    failAt = '';
    const result = await prepareRestore({ target, backup, sha256, resetTarget: target }, runner);
    assert.equal(result.epoch, epoch);
    assert.ok(calls.indexOf('api:quarantine-restored-db') < calls.indexOf('gate:verify'));
    assert.ok(!calls.some((call) => call === 'gate:open'));
    await assert.rejects(
      reopenRestore({ target, authorizedEpoch: '22222222-2222-4222-8222-222222222222' }, runner),
    );
    active = target;
    await reopenRestore({ target, authorizedEpoch: epoch }, runner);
    assert.ok(calls.some((call) => call === 'gate:open'));
  } finally {
    await rm(backup, { force: true });
    await rm(evidence, { force: true });
  }
});
