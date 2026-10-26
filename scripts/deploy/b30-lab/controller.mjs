#!/usr/bin/env node
/** Disposable B23 -> B30 controller. It only accepts its own local Compose project. */
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { newJournal, runUpgrade, recoverUpgrade } from '../spec03-upgrade-supervisor.mjs';
import { seedB23, assertSeed } from './seed-b23.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const composeFile = join(root, 'infrastructure/compose/compose.b30-deployment-lab.yaml');
const candidateFile = join(
  root,
  'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json',
);
const candidateSha = '02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f';
const B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d';
const B30 = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6';
const source = '15f77a0d1904b77833972d8e2fd628a6cb97678f';
const images = {
  b23Api: 'geops-b30-lab-api:b23',
  b23Web: 'geops-b30-lab-web:b23',
  b30Api: 'geops-b30-lab-api:15f77a0',
  b30Web: 'geops-b30-lab-web:15f77a0',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

function contextPath(dir) {
  const base = resolve(root, 'artifacts');
  const target = resolve(dir);
  if (dirname(target) !== base || !/^b30-lab-[a-z0-9-]+$/.test(target.split(/[\\/]/).at(-1)))
    throw new Error('Only a direct artifacts/b30-lab-* directory is allowed');
  return target;
}
function atomic(file, data, mode = 0o600) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { flag: 'wx', mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}
function context(dir) {
  const ctx = json(join(dir, 'context.json'));
  if (!/^geops-b30lab-[a-f0-9]{8}$/.test(ctx.project) || ctx.root !== dir)
    throw new Error('Invalid lab context');
  return ctx;
}
function compose(dir, args, opts = {}) {
  const ctx = context(dir);
  return run(
    'docker',
    ['compose', '-p', ctx.project, '-f', composeFile, '--env-file', join(dir, '.env'), ...args],
    opts,
  );
}
function setImages(dir, version) {
  const env = readFileSync(join(dir, '.env'), 'utf8');
  const api = version === 'B23' ? images.b23Api : images.b30Api;
  const web = version === 'B23' ? images.b23Web : images.b30Web;
  const next = env
    .replace(/^GEOPS_LAB_API_IMAGE=.*$/m, `GEOPS_LAB_API_IMAGE=${api}`)
    .replace(/^GEOPS_LAB_WEB_IMAGE=.*$/m, `GEOPS_LAB_WEB_IMAGE=${web}`);
  atomic(join(dir, '.env'), next);
}
function imageId(ref) {
  const id = run('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid local image ID');
  return id;
}
function imageSql(ref) {
  const script =
    'const fs=require("fs"),c=require("crypto"),p="/work/apps/api/dist/db/migrations";' +
    'const n=fs.readdirSync(p).filter(x=>/^[0-9]{4}_[a-z0-9_]+\\.sql$/.test(x)).sort();' +
    'const s=n.map(x=>x+"|"+c.createHash("sha256").update(fs.readFileSync(p+"/"+x)).digest("hex")).join("\\n");' +
    'console.log(JSON.stringify({count:n.length,hash:c.createHash("sha256").update(s).digest("hex")}))';
  return JSON.parse(
    run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', ref, '-e', script]),
  );
}
let validatedImageSet = null;
function verifyImages(ctx) {
  for (const [key, ref] of Object.entries(images))
    if (imageId(ref) !== ctx.imageIds[key]) throw new Error(`Image ID mismatch: ${key}`);
  const key = JSON.stringify(ctx.imageIds);
  if (validatedImageSet === key) return;
  assert.deepEqual(imageSql(images.b23Api), { count: 23, hash: B23 });
  assert.deepEqual(imageSql(images.b30Api), { count: 30, hash: B30 });
  const b30Web = run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'cat',
    images.b30Web,
    '/usr/share/nginx/html/index.html',
  ]);
  if (!b30Web.includes('/assets/')) throw new Error('B30 Web build missing assets');
  validatedImageSet = key;
}
function verifySignedManifest(dir) {
  const bytes = readFileSync(join(dir, 'lab-manifest.json'));
  const document = JSON.parse(bytes.toString());
  const signature = readFileSync(join(dir, 'lab-manifest.sig'));
  const publicKey = readFileSync(join(dir, 'lab-public.pem'));
  const ctx = context(dir);
  if (
    !verify(null, bytes, publicKey, signature) ||
    Object.keys(document).sort().join(',') !==
      'candidateSha256,environment,expiresAt,imageIds,issuedAt,project,schemaVersion,sourceCommit,sql,targetSchema' ||
    document.schemaVersion !== 3 ||
    document.environment !== 'synthetic-b30-local' ||
    document.project !== ctx.project ||
    document.sourceCommit !== source ||
    document.candidateSha256 !== candidateSha ||
    document.targetSchema !== 30 ||
    document.sql?.b23 !== B23 ||
    document.sql?.b30 !== B30 ||
    JSON.stringify(document.imageIds) !== JSON.stringify(ctx.imageIds) ||
    Date.parse(document.expiresAt) <= Date.now() ||
    Date.parse(document.issuedAt) > Date.now()
  )
    throw new Error('Invalid signed B30 lab manifest');
  if (hash(readFileSync(candidateFile)) !== candidateSha)
    throw new Error('Candidate source manifest changed');
  const variables = Object.fromEntries(
    readFileSync(join(dir, '.env'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  if (
    !/^[a-f0-9]{64}$/.test(variables.GEOPS_LAB_DB_PASSWORD ?? '') ||
    !['ADMIN_SESSION', 'ADMIN_CSRF', 'INVITATION_HMAC', 'MDM_GRANT', 'GPS_QUARANTINE'].every(
      (name) => /^[A-Za-z0-9_-]{43}$/.test(variables[`GEOPS_LAB_${name}_KEY`] ?? ''),
    ) ||
    variables.GEOPS_LAB_GATE_DIR !== join(dir, 'gate').replaceAll('\\', '/')
  )
    throw new Error('Missing or invalid synthetic lab secrets');
  verifyImages(ctx);
  return document;
}
async function assertComplete(dir) {
  const seen = await observe(dir);
  if (
    seen.schema !== 30 ||
    seen.sqlListSha256 !== B30 ||
    seen.api !== 'B30' ||
    seen.web !== 'B30' ||
    seen.gate !== 'open' ||
    !healthy(dir, 'api') ||
    !healthy(dir, 'web')
  )
    throw new Error('Completed B30 journal differs from live state');
  const db = pool(dir);
  try {
    await assertSeed(db, context(dir).seed);
  } finally {
    await db.end();
  }
  return seen;
}
function port(dir) {
  const value = compose(dir, ['port', 'db', '5432']).trim();
  const match = /(?:127\.0\.0\.1|localhost):(\d+)$/.exec(value);
  if (!match) throw new Error('Isolated loopback database port required');
  return Number(match[1]);
}
function pool(dir) {
  const env = readFileSync(join(dir, '.env'), 'utf8');
  const pass = /^GEOPS_LAB_DB_PASSWORD=(.+)$/m.exec(env)?.[1];
  if (!/^[a-f0-9]{64}$/.test(pass ?? '')) throw new Error('Invalid synthetic database secret');
  return new pg.Pool({
    connectionString: `postgres://postgres:${pass}@127.0.0.1:${port(dir)}/geops_dev`,
  });
}
async function waitDb(dir, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let db;
    try {
      const id = compose(dir, ['ps', '-q', 'db']).trim();
      if (!id || !run('docker', ['logs', id]).includes('PostgreSQL init process complete'))
        throw new Error('PostGIS initialization pending');
      db = pool(dir);
      const row = (
        await db.query('SELECT current_database() AS name, PostGIS_Version() AS postgis')
      ).rows[0];
      if (row?.name === 'geops_dev' && row.postgis) return;
    } catch {
      /* PostGIS initialization temporarily shuts the server down. */
    } finally {
      await db?.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('PostGIS TCP readiness timeout');
}
async function ledger(db) {
  const rows = (
    await db.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')
  ).rows;
  return {
    schema: rows.length,
    sqlListSha256: hash(rows.map((r) => `${r.version}|${r.checksum}`).join('\n')),
  };
}
function service(dir, name, ids) {
  const container = compose(dir, ['ps', '-q', name]).trim();
  if (!container) return 'stopped';
  const value = run('docker', [
    'inspect',
    container,
    '--format',
    '{{.Image}} {{.State.Status}}',
  ]).trim();
  const [id, state] = value.split(' ');
  if (state !== 'running') return 'stopped';
  if (id === ids.b23) return 'B23';
  if (id === ids.b30) return 'B30';
  throw new Error(`Unexpected ${name} image`);
}
async function observe(dir) {
  const ctx = context(dir);
  const db = pool(dir);
  try {
    const state = await ledger(db);
    return {
      ...state,
      api: service(dir, 'api', { b23: ctx.imageIds.b23Api, b30: ctx.imageIds.b30Api }),
      web: service(dir, 'web', { b23: ctx.imageIds.b23Web, b30: ctx.imageIds.b30Web }),
      gate: json(join(dir, 'gate/security-gate.json')).phase,
    };
  } finally {
    await db.end();
  }
}
async function openGate(dir) {
  const path = join(dir, 'gate/security-gate.json');
  const gate = json(path);
  if (gate.phase !== 'closed' && gate.phase !== 'open') throw new Error('Invalid gate');
  const db = pool(dir);
  try {
    await db.query('UPDATE security_epoch SET epoch=$1,updated_at=now() WHERE singleton=true', [
      gate.epoch,
    ]);
  } finally {
    await db.end();
  }
  atomic(path, `${JSON.stringify({ version: 1, phase: 'open', epoch: gate.epoch })}\n`, 0o644);
}
function closeGate(dir) {
  const path = join(dir, 'gate/security-gate.json');
  const gate = json(path);
  if (gate.phase === 'closed') return;
  if (gate.phase !== 'open') throw new Error('Invalid gate');
  atomic(path, `${JSON.stringify({ version: 1, phase: 'closed', epoch: randomUUID() })}\n`, 0o644);
}
function healthy(dir, serviceName) {
  const id = compose(dir, ['ps', '-q', serviceName]).trim();
  if (!id) return false;
  return (
    run('docker', ['inspect', id, '--format', '{{.State.Health.Status}}']).trim() === 'healthy'
  );
}
async function waitHealthy(dir, name, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (healthy(dir, name)) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${name} health timeout`);
}
function migrate(dir) {
  const code =
    'import pg from "pg";import {applyMigrations} from "./apps/api/dist/db/migration-manager.js";' +
    'const p=new pg.Pool({connectionString:process.env.DATABASE_URL});' +
    'try{console.log(JSON.stringify(await applyMigrations(p)))}finally{await p.end()}';
  return compose(
    dir,
    ['run', '--rm', '--no-deps', 'api', 'node', '--input-type=module', '-e', code],
    { timeout: 300_000 },
  ).trim();
}
async function backup(dir) {
  const bytes = compose(
    dir,
    ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'geops_dev', '-Fc'],
    { encoding: 'buffer', timeout: 180_000 },
  );
  const file = join(dir, 'b23.dump');
  atomic(file, bytes);
  return { sha256: hash(bytes), bytes: bytes.length };
}
function saveJournal(dir, journal) {
  atomic(join(dir, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
  appendFileSync(
    join(dir, 'events.jsonl'),
    `${JSON.stringify({
      at: new Date().toISOString(),
      phase: journal.phase,
      lastCompleted: journal.lastCompleted,
      recovery: journal.recovery,
    })}\n`,
    { mode: 0o600 },
  );
}
function validateJournal(journal, candidate) {
  const steps = [
    'preflight',
    'drain',
    'backup',
    'prepare',
    'migrate',
    'api',
    'web',
    'health',
    'confirm',
  ];
  if (
    Object.keys(journal).sort().join(',') !==
      'backupSha256,candidate,lastCompleted,phase,recovery,schemaVersion,sourceSqlListSha256,targetSqlListSha256' ||
    journal.schemaVersion !== 1 ||
    journal.candidate !== candidate.identity ||
    journal.sourceSqlListSha256 !== B23 ||
    journal.targetSqlListSha256 !== B30 ||
    !['pending', 'recovery', 'complete', ...steps].includes(journal.phase) ||
    (journal.lastCompleted !== null && !steps.includes(journal.lastCompleted)) ||
    (journal.recovery !== null && !['RESTORE_B23', 'FORWARD_B30'].includes(journal.recovery)) ||
    (journal.backupSha256 !== null && !/^[a-f0-9]{64}$/.test(journal.backupSha256)) ||
    (journal.phase === 'complete') !== (journal.lastCompleted === 'confirm')
  )
    throw new Error('Invalid B30 transition journal');
}
function adapter(dir, fault) {
  return {
    observe: () => observe(dir),
    save: async (journal) => saveJournal(dir, journal),
    step: async (step) => {
      if (fault === `before-${step}`) throw new Error(`INJECTED_FAILURE:before-${step}`);
      let result;
      if (step === 'preflight') {
        verifySignedManifest(dir);
        const seen = await observe(dir);
        if (
          seen.schema !== 23 ||
          seen.api !== 'B23' ||
          seen.web !== 'B23' ||
          !healthy(dir, 'api') ||
          !healthy(dir, 'web')
        )
          throw new Error('B23 preflight failed');
      } else if (step === 'drain') {
        closeGate(dir);
        compose(dir, ['stop', 'web', 'api']);
      } else if (step === 'backup') result = await backup(dir);
      else if (step === 'prepare') verifySignedManifest(dir);
      else if (step === 'migrate') {
        setImages(dir, 'B30');
        migrate(dir);
      } else if (step === 'api' || step === 'web') {
        compose(dir, [
          'up',
          '-d',
          '--no-deps',
          '--no-build',
          '--pull',
          'never',
          '--force-recreate',
          step,
        ]);
      } else if (step === 'health') {
        compose(dir, [
          'exec',
          '-T',
          'api',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3500/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ]);
        if (fault === 'during-health') throw new Error('INJECTED_FAILURE:during-health');
        compose(dir, [
          'exec',
          '-T',
          'web',
          'wget',
          '-q',
          '-O',
          '/dev/null',
          'http://127.0.0.1:8080/health',
        ]);
        const db = pool(dir);
        try {
          const current = await ledger(db);
          if (current.schema !== 30 || current.sqlListSha256 !== B30)
            throw new Error('B30 database health failed');
        } finally {
          await db.end();
        }
        result = { api: true, web: true, db: true };
      } else if (step === 'confirm') {
        verifySignedManifest(dir);
        const db = pool(dir);
        try {
          await assertSeed(db, context(dir).seed);
        } finally {
          await db.end();
        }
        openGate(dir);
        await waitHealthy(dir, 'api');
        await waitHealthy(dir, 'web');
        if (!healthy(dir, 'api') || !healthy(dir, 'web'))
          throw new Error('Health lost before confirm');
      }
      if (fault === `after-${step}`) throw new Error(`INJECTED_FAILURE:after-${step}`);
      return result;
    },
    recover: async (mode) => {
      const target = mode === 'FORWARD_B30' ? 'B30' : 'B23';
      closeGate(dir);
      compose(dir, ['stop', 'web', 'api']);
      if (fault === 'during-recovery') throw new Error('INJECTED_FAILURE:during-recovery');
      setImages(dir, target);
      compose(dir, [
        'up',
        '-d',
        '--no-deps',
        '--no-build',
        '--pull',
        'never',
        '--force-recreate',
        'api',
      ]);
      compose(dir, [
        'up',
        '-d',
        '--no-deps',
        '--no-build',
        '--pull',
        'never',
        '--force-recreate',
        'web',
      ]);
      openGate(dir);
      await waitHealthy(dir, 'api');
      await waitHealthy(dir, 'web');
      const db = pool(dir);
      try {
        await assertSeed(db, context(dir).seed);
      } finally {
        await db.end();
      }
    },
  };
}

async function initialize(dir, restoreFrom = null) {
  if (existsSync(dir)) throw new Error('Lab directory already exists');
  mkdirSync(join(dir, 'gate'), { recursive: true });
  chmodSync(join(dir, 'gate'), 0o755);
  const project = `geops-b30lab-${randomBytes(4).toString('hex')}`;
  const ids = Object.fromEntries(Object.entries(images).map(([key, ref]) => [key, imageId(ref)]));
  const ctx = { project, root: dir, sourceCommit: source, imageIds: ids, seed: null };
  atomic(join(dir, 'context.json'), `${JSON.stringify(ctx, null, 2)}\n`);
  const secret = () => randomBytes(32).toString('base64url');
  const env = `${[
    `GEOPS_LAB_DB_PASSWORD=${randomBytes(32).toString('hex')}`,
    `GEOPS_LAB_GATE_DIR=${join(dir, 'gate').replaceAll('\\', '/')}`,
    `GEOPS_LAB_API_IMAGE=${images.b23Api}`,
    `GEOPS_LAB_WEB_IMAGE=${images.b23Web}`,
    ...['ADMIN_SESSION', 'ADMIN_CSRF', 'INVITATION_HMAC', 'MDM_GRANT', 'GPS_QUARANTINE'].map(
      (name) => `GEOPS_LAB_${name}_KEY=${secret()}`,
    ),
  ].join('\n')}\n`;
  atomic(join(dir, '.env'), env);
  verifyImages(ctx);
  if (hash(readFileSync(candidateFile)) !== candidateSha) throw new Error('Candidate changed');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'lab-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: 0o600,
  });
  const manifest = {
    schemaVersion: 3,
    environment: 'synthetic-b30-local',
    project,
    sourceCommit: source,
    candidateSha256: candidateSha,
    targetSchema: 30,
    sql: { b23: B23, b30: B30 },
    imageIds: ids,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'lab-manifest.json'), bytes, { mode: 0o600 });
  writeFileSync(join(dir, 'lab-manifest.sig'), sign(null, bytes, privateKey), { mode: 0o600 });
  verifySignedManifest(dir);
  compose(dir, [
    'up',
    '-d',
    '--no-build',
    '--pull',
    'never',
    '--wait',
    '--wait-timeout',
    '120',
    'db',
  ]);
  await waitDb(dir);
  let migrationOutput;
  if (restoreFrom) {
    const sourceDir = contextPath(restoreFrom);
    const sourceCtx = context(sourceDir);
    const previousJournal = json(join(sourceDir, 'journal.json'));
    const dump = readFileSync(join(sourceDir, 'b23.dump'));
    if (hash(dump) !== previousJournal.backupSha256 || !sourceCtx.seed)
      throw new Error('B23 source backup integrity failed');
    compose(
      dir,
      [
        'exec',
        '-T',
        'db',
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        'geops_dev',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--exit-on-error',
      ],
      { input: dump, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 },
    );
    ctx.seed = sourceCtx.seed;
    migrationOutput = `RESTORED_VERIFIED_B23_BACKUP:${hash(dump)}`;
  } else migrationOutput = migrate(dir);
  const db = pool(dir);
  try {
    const seen = await ledger(db);
    assert.deepEqual(seen, { schema: 23, sqlListSha256: B23 });
    const epoch = restoreFrom
      ? (await db.query('SELECT epoch FROM security_epoch WHERE singleton=true')).rows[0]?.epoch
      : randomUUID();
    if (!epoch) throw new Error('B23 security epoch missing');
    if (!restoreFrom)
      await db.query('INSERT INTO security_epoch(singleton,epoch) VALUES(true,$1)', [epoch]);
    atomic(
      join(dir, 'gate/security-gate.json'),
      `${JSON.stringify({ version: 1, phase: 'open', epoch })}\n`,
      0o644,
    );
    if (!restoreFrom) ctx.seed = await seedB23(db);
    else await assertSeed(db, ctx.seed);
  } finally {
    await db.end();
  }
  atomic(join(dir, 'context.json'), `${JSON.stringify(ctx, null, 2)}\n`);
  compose(dir, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api']);
  await waitHealthy(dir, 'api');
  compose(dir, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'web']);
  await waitHealthy(dir, 'web');
  const candidate = json(candidateFile);
  saveJournal(dir, newJournal(candidate, await observe(dir)));
  return {
    result: 'B23_BASELINE_PASS',
    project,
    migrationOutput,
    observed: await observe(dir),
    imageIds: ids,
    manifestSha256: hash(bytes),
  };
}

async function main() {
  const [command, dirArg, fault] = process.argv.slice(2);
  if (
    !['init', 'clone', 'upgrade', 'recover', 'status', 'down', 'verify'].includes(command) ||
    !dirArg
  )
    throw new Error(
      'Usage: controller.mjs init|clone|upgrade|recover|status|down|verify artifacts/b30-lab-ID [source or fault]',
    );
  const dir = contextPath(dirArg);
  if (command === 'init') return console.log(JSON.stringify(await initialize(dir)));
  if (command === 'clone') return console.log(JSON.stringify(await initialize(dir, fault)));
  const ctx = context(dir);
  if (command === 'down') {
    if (existsSync(join(dir, 'controller.lock'))) throw new Error('Lab controller is active');
    verifySignedManifest(dir);
    compose(dir, ['down', '--volumes', '--remove-orphans']);
    return console.log(JSON.stringify({ result: 'SCOPED_LAB_DOWN', project: ctx.project }));
  }
  if (command === 'verify')
    return console.log(JSON.stringify({ result: 'VERIFIED', manifest: verifySignedManifest(dir) }));
  if (command === 'status')
    return console.log(
      JSON.stringify({ journal: json(join(dir, 'journal.json')), observed: await observe(dir) }),
    );
  const lock = join(dir, 'controller.lock');
  let fd;
  try {
    fd = openSync(lock, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    verifySignedManifest(dir);
    const candidate = json(candidateFile);
    const journal = json(join(dir, 'journal.json'));
    validateJournal(journal, candidate);
    const work = adapter(dir, fault);
    if (command === 'upgrade') await runUpgrade(candidate, journal, work);
    else await recoverUpgrade(candidate, journal, work);
    const observed = journal.phase === 'complete' ? await assertComplete(dir) : await observe(dir);
    console.log(
      JSON.stringify({
        result: `${command.toUpperCase()}_PASS`,
        journal,
        observed,
      }),
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      rmSync(lock);
    }
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ result: 'BLOCKED', reason: error.message }));
  process.exitCode = 1;
});
