import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GEOPS_RESTORE_ROOT = root;
const compose = [
  'compose',
  '--env-file',
  'infrastructure/compose/.env.local',
  '-f',
  'infrastructure/compose/compose.dev.yaml',
  '--profile',
  'maintenance',
];
const targetPattern = /^geops_verify_[0-9]+_restore$/;
const dbPattern = /^(geops_dev|geops_verify_[0-9]+(_restore)?)$/;
const epochPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function docker(args, env = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) throw new Error('Docker stage failed');
  return result.stdout.trim();
}
function composeRun(args, env = {}) {
  return docker([...compose, ...args], env);
}
function apiCommand(command, target, extraEnv = {}) {
  const env = target ? { GEOPS_ACTIVE_DB: target } : {};
  const flags = Object.entries(extraEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return composeRun(
    [
      'run',
      '--rm',
      '--no-deps',
      ...flags,
      'geops-api',
      'node',
      `apps/api/dist/db/${command}.js`,
      ...(command === 'security-gate-cli' ? [extraEnv.GEOPS_GATE_MODE ?? 'verify'] : []),
    ],
    env,
  );
}
function gate(mode, target, extra = {}) {
  const vars = { ...extra, GEOPS_GATE_MODE: mode };
  if (target) vars.GEOPS_TEST_DB = target;
  return apiCommand('security-gate-cli', target, vars);
}
function dbSql(sql) {
  return composeRun([
    'exec',
    '-T',
    'geops-db',
    'psql',
    '-U',
    'geops_dev',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    sql,
  ]);
}
function readComposeDatabase() {
  const config = JSON.parse(composeRun(['config', '--format', 'json']));
  if (config.name !== 'geops-wave0a') throw new Error('Unexpected Compose project');
  const value = config.services?.['geops-api']?.environment?.DATABASE_URL;
  if (typeof value !== 'string') throw new Error('GEOPS API database is not configured');
  const name = new URL(value).pathname.slice(1);
  if (!dbPattern.test(name)) throw new Error('Unexpected GEOPS API database');
  return name;
}
async function backupDigest(path) {
  const stream = createReadStream(path);
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
async function evidence(target, event, fields = {}) {
  const dir = join(root, 'infrastructure', 'compose', '.local');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `restore-${target}.jsonl`);
  const file = await open(path, 'a', 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify({ at: new Date().toISOString(), event, target, ...fields })}\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
}
async function latestEvidence(target) {
  const path = join(root, 'infrastructure', 'compose', '.local', `restore-${target}.jsonl`);
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  return JSON.parse(lines.at(-1));
}
function assertStopped() {
  const running = docker([
    'ps',
    '--filter',
    'label=com.docker.compose.project=geops-wave0a',
    '--format',
    '{{.Names}}',
  ])
    .split('\n')
    .filter(Boolean);
  if (running.some((name) => name !== 'geops-wave0a-db'))
    throw new Error('GEOPS application or worker is still running');
}
function assertNoConnections(source, target) {
  const count = Number(
    dbSql(`SELECT count(*) FROM pg_stat_activity WHERE datname IN ('${source}','${target}')`),
  );
  if (!Number.isSafeInteger(count) || count !== 0)
    throw new Error('GEOPS application connections remain');
}
function verifyEpoch(output) {
  const match = /epoch=([0-9a-f-]{36})/.exec(output);
  if (!match || !epochPattern.test(match[1])) throw new Error('Verified external epoch missing');
  return match[1];
}
export async function prepareRestore(
  { target, backup, sha256, resetTarget },
  runner = {
    composeRun,
    docker,
    dbSql,
    gate,
    apiCommand,
    readComposeDatabase,
    assertStopped,
    assertNoConnections,
  },
) {
  if (!targetPattern.test(target) || !/^[0-9a-f]{64}$/.test(sha256 ?? ''))
    throw new Error('Exact isolated target and backup SHA-256 required');
  const backupRoot = await realpath(join(root, 'infrastructure', 'compose', '.local', 'backups'));
  if (!isAbsolute(backup ?? '') || !backup.endsWith('.dump'))
    throw new Error('Local GEOPS dump required');
  const actual = await realpath(backup);
  const stat = await lstat(backup);
  if (
    !actual.startsWith(`${backupRoot}${sep}`) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0
  )
    throw new Error('Dump must be a regular file in GEOPS local backups');
  if ((await backupDigest(actual)) !== sha256) throw new Error('Backup SHA-256 mismatch');
  const source = runner.readComposeDatabase();
  if (source === target) throw new Error('Restore target is the active API database');
  await evidence(target, 'prepare.start', { source, backupSha256: sha256 });
  let closed = false;
  try {
    runner.gate('close');
    closed = true;
    await evidence(target, 'gate.closed');
    runner.composeRun(['stop', '-t', '30', 'geops-web', 'geops-api', 'geops-migrate']);
    runner.assertStopped();
    runner.assertNoConnections(source, target);
    await evidence(target, 'traffic.drained');
    const exists = Number(
      runner.dbSql(`SELECT count(*) FROM pg_database WHERE datname='${target}'`),
    );
    if (exists !== 0 && exists !== 1) throw new Error('Cannot establish restore target state');
    if (exists) {
      if (resetTarget !== target)
        throw new Error('Existing target requires explicit reset confirmation');
      runner.dbSql(`DROP DATABASE ${target} WITH (FORCE)`);
      await evidence(target, 'target.reset');
    }
    runner.dbSql(`CREATE DATABASE ${target}`);
    const containerPath = `/tmp/geops-${target}.dump`;
    runner.docker(['cp', actual, `geops-wave0a-db:${containerPath}`]);
    const copied = runner
      .composeRun(['exec', '-T', 'geops-db', 'sha256sum', containerPath])
      .split(' ')[0];
    if (copied !== sha256) throw new Error('Container backup SHA-256 mismatch');
    runner.composeRun([
      'exec',
      '-T',
      'geops-db',
      'pg_restore',
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '-U',
      'geops_dev',
      '-d',
      target,
      containerPath,
    ]);
    await evidence(target, 'database.restored');
    runner.composeRun(['run', '--rm', '--no-deps', 'geops-migrate'], {
      GEOPS_ACTIVE_DB: target,
      GEOPS_MIGRATION_TARGET: target,
      GEOPS_CONFIRM_MIGRATION_TARGET: target,
      GEOPS_TEST_DB: target,
    });
    await evidence(target, 'database.migrated');
    runner.apiCommand('quarantine-restored-db', target, {
      GEOPS_TEST_DB: target,
      GEOPS_CONFIRM_RESTORE_QUARANTINE: 'YES',
    });
    await evidence(target, 'credentials.quarantined');
    const epoch = verifyEpoch(runner.gate('verify', target));
    runner.assertStopped();
    runner.assertNoConnections(source, target);
    await evidence(target, 'restore.verified', { epoch, backupSha256: sha256 });
    return { target, epoch, backupSha256: sha256 };
  } catch (error) {
    await evidence(target, 'restore.failed_closed', {
      stage: closed ? 'after_gate_close' : 'before_gate_close',
    });
    throw error;
  }
}
export async function reopenRestore(
  { target, authorizedEpoch },
  runner = {
    composeRun,
    gate,
    readComposeDatabase,
    assertStopped,
    assertNoConnections,
  },
) {
  if (!targetPattern.test(target) || !epochPattern.test(authorizedEpoch ?? ''))
    throw new Error('Exact restore target and epoch authorization required');
  const last = await latestEvidence(target);
  if (last.event !== 'restore.verified' || last.epoch !== authorizedEpoch)
    throw new Error('Verified restore evidence required');
  if (runner.readComposeDatabase() !== target)
    throw new Error('GEOPS_ACTIVE_DB must match verified target');
  runner.assertStopped();
  runner.assertNoConnections(target, target);
  if (verifyEpoch(runner.gate('verify', target)) !== authorizedEpoch)
    throw new Error('External epoch changed');
  await evidence(target, 'reopen.authorized', { epoch: authorizedEpoch });
  try {
    runner.gate('open', target, {
      GEOPS_CONFIRM_REOPEN_TARGET: target,
      GEOPS_CONFIRM_REOPEN_EPOCH: authorizedEpoch,
    });
    runner.composeRun(['up', '-d', '--no-deps', 'geops-api', 'geops-web']);
    let ready = false;
    for (let attempt = 0; attempt < 12 && !ready; attempt++) {
      try {
        ready = runner.readiness
          ? await runner.readiness()
          : (
              await fetch('http://127.0.0.1:3500/health/ready', {
                signal: AbortSignal.timeout(3000),
              })
            ).ok;
      } catch {
        // API may still be starting; remain closed on timeout below.
      }
      if (!ready) await new Promise((done) => setTimeout(done, 1000));
    }
    if (!ready) throw new Error('GEOPS API failed readiness after reopen');
    if (!runner.readiness) {
      const web = await fetch('http://127.0.0.1:3501/health', {
        signal: AbortSignal.timeout(5000),
      });
      if (!web.ok) throw new Error('GEOPS Web failed health after reopen');
    }
    await evidence(target, 'reopen.healthy', { epoch: authorizedEpoch });
  } catch (error) {
    let rollbackFailed = false;
    try {
      runner.gate('close', target);
    } catch {
      rollbackFailed = true;
    }
    try {
      runner.composeRun(['stop', '-t', '30', 'geops-web', 'geops-api']);
    } catch {
      rollbackFailed = true;
    }
    await evidence(target, rollbackFailed ? 'reopen.rollback_failed' : 'reopen.failed_closed', {
      epoch: authorizedEpoch,
    });
    if (rollbackFailed) throw new Error('GEOPS restore rollback requires manual isolation');
    throw error;
  }
}
async function withRestoreLock(action) {
  const dir = join(root, 'infrastructure', 'compose', '.local');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'restore-operation.lock');
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), pid: process.pid })}\n`);
    await file.sync();
    return await action();
  } finally {
    await file.close();
    await unlink(path);
  }
}
function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined)
      throw new Error('Invalid restore arguments');
    values[rest[i].slice(2)] = rest[i + 1];
  }
  return { mode, values };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { mode, values } = parseArgs(process.argv.slice(2));
    if (mode === 'prepare') {
      const result = await withRestoreLock(() =>
        prepareRestore({
          target: values.target,
          backup: values.backup,
          sha256: values.sha256,
          resetTarget: values['reset-target'],
        }),
      );
      process.stdout.write(
        `GEOPS restore verified and CLOSED; target=${result.target}; epoch=${result.epoch}\n`,
      );
    } else if (mode === 'reopen') {
      await withRestoreLock(() =>
        reopenRestore({ target: values.target, authorizedEpoch: values['authorize-epoch'] }),
      );
      process.stdout.write('GEOPS restore reopened after explicit authorization and readiness\n');
    } else throw new Error('Invalid restore mode');
  } catch {
    process.stderr.write(
      'GEOPS restore failed; gate remains or must be checked CLOSED; details withheld\n',
    );
    process.exitCode = 1;
  }
}
