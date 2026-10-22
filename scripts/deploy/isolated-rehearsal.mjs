import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const imageFlags = ['--api-a', '--web-a', '--api-b', '--web-b'];
const commitFlags = ['--commit-a', '--commit-b'];
const options = {};
for (let index = 0; index < args.length; index += 2) {
  assert.ok(
    [...imageFlags, ...commitFlags].includes(args[index]) && args[index + 1],
    'Four image flags and optional commit flags are required',
  );
  options[args[index].slice(2)] = args[index + 1];
}
for (const flag of imageFlags) assert.ok(options[flag.slice(2)], `${flag} is required`);
options['commit-a'] ??= 'e3f086eb8be3f74ff53cd4c12ad73c4609c5743c';
options['commit-b'] ??= 'e2b0af7b439fed76f152e979f60517b88a8d05de';
for (const flag of commitFlags)
  assert.match(options[flag.slice(2)], /^[a-f0-9]{40}$/, `${flag} must be a full commit SHA`);
assert.notEqual(options['commit-a'], options['commit-b'], 'A/B commits must differ');

const runId = `p0${Date.now()}${randomBytes(3).toString('hex')}`;
const prefix = `geops-deploy-${runId}`;
const network = `${prefix}-net`;
const gateVolume = `${prefix}-gate`;
const databaseName = `geops_verify_${Date.now()}_restore`;
const names = {
  db: `${prefix}-db`,
  apiA: `${prefix}-api-a`,
  webA: `${prefix}-web-a`,
  apiB: `${prefix}-api-b`,
  webB: `${prefix}-web-b`,
  apiBad: `${prefix}-api-bad`,
  apiSlow: `${prefix}-api-slow`,
};
const evidenceDir = resolve(root, 'tmp', `rehearsal-${runId}`);
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const timingsPath = resolve(evidenceDir, 'timings.jsonl');
const envPath = resolve(evidenceDir, 'synthetic.env');
const probePath = resolve(root, 'scripts/deploy/gps-rehearsal.mjs');
const ownedContainers = [];
let networkCreated = false;
let gateCreated = false;

function docker(args, { input, timeout = 90_000, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `Docker command failed (${args[0]} ${args[1] ?? ''}): ${(result.stderr ?? '').trim().slice(0, 500)}`,
    );
  return result;
}

function record(stage, startedAt, start, result, detail = {}) {
  const entry = {
    stage,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    result,
    ...detail,
  };
  appendFileSync(timingsPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(entry));
  return entry;
}

async function stage(name, action) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const value = await action();
    record(name, startedAt, start, 'PASS');
    return value;
  } catch (error) {
    record(name, startedAt, start, 'FAIL', { reason: error.message.slice(0, 300) });
    throw error;
  }
}

function inspectImage(ref, expectedSha) {
  const image = JSON.parse(docker(['image', 'inspect', ref]).stdout)[0];
  assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'], expectedSha);
  return image.Id;
}

function containerExists(name) {
  return docker(['container', 'inspect', name], { allowFailure: true }).status === 0;
}

function createContainer(name, args) {
  assert.ok(!containerExists(name), `Container collision: ${name}`);
  const result = docker([
    'run',
    '-d',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    `geops.deploy.p0=${runId}`,
    ...args,
  ]);
  ownedContainers.push(name);
  return result.stdout.trim();
}

function startApi(name, image, extra = [], command = []) {
  return createContainer(name, [
    '--network',
    network,
    '--network-alias',
    'geops-api',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=16m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=volume,src=${gateVolume},dst=/geops-security,readonly`,
    '--env-file',
    envPath,
    ...extra,
    image,
    ...command,
  ]);
}

function startWeb(name, image) {
  return createContainer(name, [
    '--network',
    network,
    '--network-alias',
    'geops-web',
    '--memory',
    '128m',
    '--cpus',
    '0.5',
    '--pids-limit',
    '64',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=16m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    image,
  ]);
}

async function waitFor(check, deadlineMs, label) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} did not become ready within ${deadlineMs} ms`);
}

function apiReady(name) {
  return (
    docker(
      [
        'exec',
        name,
        'node',
        '-e',
        "fetch('http://127.0.0.1:3500/health/ready',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      { timeout: 4_000, allowFailure: true },
    ).status === 0
  );
}

function webReady(name) {
  return (
    docker(['exec', name, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health'], {
      timeout: 4_000,
      allowFailure: true,
    }).status === 0
  );
}

function probe(mode, input = {}) {
  const result = docker(
    [
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--network',
      network,
      '--memory',
      '256m',
      '--cpus',
      '0.5',
      '--pids-limit',
      '96',
      '--env-file',
      envPath,
      '--mount',
      `type=bind,src=${probePath},dst=/work/scripts/deploy/gps-rehearsal.mjs,readonly`,
      '--entrypoint',
      'node',
      options['api-b'],
      '/work/scripts/deploy/gps-rehearsal.mjs',
      mode,
    ],
    { input: `${JSON.stringify(input)}\n`, timeout: 45_000 },
  );
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(line);
}

function stop(name) {
  docker(['stop', '--time', '5', name]);
}

function start(name) {
  docker(['start', name]);
}

function verifyIsolation() {
  const host = docker([
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]).stdout.trim();
  assert.ok(
    host.startsWith('npipe:////./pipe/dockerDesktopLinuxEngine') ||
      host === 'unix:///var/run/docker.sock',
    'Remote Docker context forbidden',
  );
  assert.ok(
    !process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT && !process.env.BUILDKIT_HOST,
    'Docker override forbidden',
  );
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']).stdout);
  assert.ok(info.MemTotal >= 8 * 1024 ** 3 && info.NCPU >= 4, 'Insufficient Docker resources');
  const disk = statfsSync(root);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  assert.ok(freeBytes >= 6 * 1024 ** 3, 'Insufficient free disk space');
  for (const name of Object.values(names))
    assert.ok(!containerExists(name), `Container collision: ${name}`);
  assert.notEqual(
    docker(['network', 'inspect', network], { allowFailure: true }).status,
    0,
    'Network collision',
  );
  assert.notEqual(
    docker(['volume', 'inspect', gateVolume], { allowFailure: true }).status,
    0,
    'Volume collision',
  );
  const imageIds = {
    apiA: inspectImage(options['api-a'], options['commit-a']),
    webA: inspectImage(options['web-a'], options['commit-a']),
    apiB: inspectImage(options['api-b'], options['commit-b']),
    webB: inspectImage(options['web-b'], options['commit-b']),
  };
  assert.notEqual(imageIds.apiA, imageIds.apiB);
  assert.notEqual(imageIds.webA, imageIds.webB);
  const migrations = (ref) =>
    docker([
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      ref,
      '-c',
      'sha256sum /work/apps/api/dist/db/migrations/*.sql',
    ]).stdout.trim();
  assert.equal(
    migrations(options['api-a']),
    migrations(options['api-b']),
    'A/B migration checksums differ',
  );
  writeFileSync(
    resolve(evidenceDir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        network,
        databaseName,
        images: options,
        imageIds,
        migrationCount: migrations(options['api-a']).split('\n').length,
        dockerMemoryBytes: info.MemTotal,
        dockerCpus: info.NCPU,
        hostFreeBytes: freeBytes,
      },
      null,
      2,
    ),
  );
}

function createIsolation() {
  docker(['network', 'create', '--internal', '--label', `geops.deploy.p0=${runId}`, network]);
  networkCreated = true;
  assert.equal(
    docker(['network', 'inspect', network, '--format', '{{.Internal}}']).stdout.trim(),
    'true',
  );
  docker(['volume', 'create', '--label', `geops.deploy.p0=${runId}`, gateVolume]);
  gateCreated = true;
  createContainer(names.db, [
    '--network',
    network,
    '--network-alias',
    'db',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=1073741824',
    '--memory',
    '1g',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--security-opt',
    'no-new-privileges',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    `POSTGRES_DB=${databaseName}`,
    'postgis/postgis:18-3.6',
  ]);
  const db = JSON.parse(docker(['container', 'inspect', names.db]).stdout)[0];
  assert.equal(db.HostConfig.NetworkMode, network);
  assert.ok(db.HostConfig.Tmpfs?.['/var/lib/postgresql']);
  assert.equal(docker(['port', names.db]).stdout.trim(), '');
}

function writeSyntheticEnv() {
  const key = () => randomBytes(32).toString('base64url');
  const env = [
    `DATABASE_URL=postgres://postgres@db:5432/${databaseName}`,
    'GEOPS_DATA_MODE=synthetic',
    'GEOPS_SECURITY_GATE_PATH=/geops-security/security-gate.json',
    'GEOPS_ALLOWED_ORIGINS=http://localhost:3501',
    'GEOPS_INSECURE_LOCAL_COOKIE=1',
    'HOST=0.0.0.0',
    'PORT=3500',
    'LOG_LEVEL=silent',
    `GEOPS_ADMIN_SESSION_KEY=${key()}`,
    `GEOPS_ADMIN_CSRF_KEY=${key()}`,
    `GEOPS_INVITATION_HMAC_KEY=${key()}`,
    `GEOPS_MDM_GRANT_KEY=${key()}`,
    `GEOPS_GPS_QUARANTINE_KEY=${key()}`,
  ];
  writeFileSync(envPath, `${env.join('\n')}\n`, { mode: 0o600 });
}

async function main() {
  const baseline = docker(['ps', '--format', '{{.ID}}|{{.Names}}'])
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean);
  let passed = false;
  try {
    await stage('preflight', verifyIsolation);
    await stage('prepare_images', () => {
      const manifest = JSON.parse(readFileSync(resolve(evidenceDir, 'manifest.json'), 'utf8'));
      for (const [name, ref] of Object.entries(options)) {
        const id = JSON.parse(docker(['image', 'inspect', ref]).stdout)[0].Id;
        assert.equal(
          id,
          manifest.imageIds[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())],
        );
      }
    });
    writeSyntheticEnv();
    await stage('create_isolation', createIsolation);
    await stage('database_readiness', () =>
      waitFor(
        () =>
          docker(
            [
              'exec',
              names.db,
              'pg_isready',
              '-h',
              '127.0.0.1',
              '-U',
              'postgres',
              '-d',
              databaseName,
            ],
            {
              allowFailure: true,
            },
          ).status === 0,
        60_000,
        'database',
      ),
    );
    await stage('migrate_isolated', () => {
      const base = [
        'run',
        '--rm',
        '--pull',
        'never',
        '--network',
        network,
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--env-file',
        envPath,
        '-e',
        `GEOPS_TEST_DB=${databaseName}`,
        '-e',
        `GEOPS_MIGRATION_TARGET=${databaseName}`,
        '-e',
        `GEOPS_CONFIRM_MIGRATION_TARGET=${databaseName}`,
        '--entrypoint',
        'node',
        options['api-b'],
      ];
      try {
        docker([...base, 'apps/api/dist/db/migrate.js'], { timeout: 120_000 });
      } catch (error) {
        const diagnostic = docker(
          [
            ...base,
            '--input-type=module',
            '-e',
            "import {resolveMigrationTarget} from './apps/api/dist/db/migration-target.js'; import {createPool} from './apps/api/dist/db/pool.js'; import {applyMigrations} from './apps/api/dist/db/migration-manager.js'; const t=resolveMigrationTarget(process.env); const p=createPool(t.url); try { const r=await p.query('SELECT current_database() AS name,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS others'); console.log(JSON.stringify(r.rows[0])); console.log(JSON.stringify(await applyMigrations(p))); } catch(e) { console.error(e.message); process.exitCode=1; } finally { await p.end(); }",
          ],
          { timeout: 120_000, allowFailure: true },
        );
        writeFileSync(
          resolve(evidenceDir, 'migration-diagnostic.txt'),
          `${diagnostic.stdout}\n${diagnostic.stderr}`,
        );
        throw error;
      }
    });
    await stage('gate_init_isolated', () =>
      docker([
        'run',
        '--rm',
        '--pull',
        'never',
        '--network',
        network,
        '--user',
        '0',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--env-file',
        envPath,
        '--mount',
        `type=volume,src=${gateVolume},dst=/geops-security`,
        '--entrypoint',
        'node',
        options['api-b'],
        'apps/api/dist/db/security-gate-cli.js',
        'init',
      ]),
    );
    await stage('gate_permissions_isolated', () =>
      docker([
        'run',
        '--rm',
        '--pull',
        'never',
        '--network',
        'none',
        '--user',
        '0',
        '--mount',
        `type=volume,src=${gateVolume},dst=/geops-security`,
        '--entrypoint',
        'sh',
        options['api-b'],
        '-c',
        'chown -R node:node /geops-security && chmod 700 /geops-security && chmod 600 /geops-security/security-gate.json',
      ]),
    );

    await stage('start_services_a', () => {
      startApi(names.apiA, options['api-a']);
      startWeb(names.webA, options['web-a']);
    });
    await stage('readiness_a', () =>
      waitFor(() => apiReady(names.apiA) && webReady(names.webA), 45_000, 'A API/Web'),
    );

    const state = await stage('gps_setup_a', () => probe('setup'));
    const first = await stage('gps_ack_a', () => probe('send', { state, index: 0 }));
    assert.equal(first.ack, true, 'A did not ACK first GPS position');

    const switchStart = performance.now();
    const switchAt = new Date().toISOString();
    await stage('stop_a', () => {
      stop(names.webA);
      stop(names.apiA);
    });
    const duringSwitch = await stage('gps_during_switch', () => probe('send', { state, index: 1 }));
    assert.equal(
      duringSwitch.ack,
      false,
      'GPS position unexpectedly ACKed during stopped services',
    );
    await stage('start_services_b', () => {
      startApi(names.apiB, options['api-b']);
      startWeb(names.webB, options['web-b']);
    });
    await stage('readiness_b', () =>
      waitFor(() => apiReady(names.apiB) && webReady(names.webB), 45_000, 'B API/Web'),
    );
    record('change_a_to_b', switchAt, switchStart, 'PASS');
    const second = await stage('gps_retry_b', () => probe('send', { state, index: 1 }));
    assert.equal(second.ack, true, 'B did not ACK retained GPS position');
    const validationStart = performance.now();
    const validationAt = new Date().toISOString();
    const bValidation = await stage('gps_validate_b', () =>
      probe('verify', { state, expected: 2 }),
    );
    assert.equal(bValidation.pass, true, 'B did not persist both GPS positions exactly once');
    assert.ok(apiReady(names.apiB) && webReady(names.webB));
    record('post_validation_b', validationAt, validationStart, 'PASS');

    const rollbackStart = performance.now();
    const rollbackAt = new Date().toISOString();
    await stage('stop_b', () => {
      stop(names.webB);
      stop(names.apiB);
    });
    const duringRollback = await stage('gps_during_rollback', () =>
      probe('send', { state, index: 2 }),
    );
    assert.equal(
      duringRollback.ack,
      false,
      'GPS position unexpectedly ACKed during rollback outage',
    );
    await stage('restart_services_a', () => {
      start(names.apiA);
      start(names.webA);
    });
    await stage('recovery_readiness_a', () =>
      waitFor(() => apiReady(names.apiA) && webReady(names.webA), 45_000, 'A recovery'),
    );
    record('rollback_b_to_a', rollbackAt, rollbackStart, 'PASS', { rebuiltImages: false });
    const third = await stage('gps_retry_a', () => probe('send', { state, index: 2 }));
    assert.equal(third.ack, true, 'A did not ACK retained GPS position');
    const repeat = await stage('gps_duplicate_after_rollback', () =>
      probe('send', { state, index: 1 }),
    );
    assert.equal(repeat.ack, true);
    assert.equal(repeat.persistedAt, second.persistedAt, 'Duplicate ACK changed across rollback');
    const gps = await stage('gps_verify_database', () => probe('verify', { state }));
    assert.equal(gps.pass, true, 'GPS database verification failed');
    writeFileSync(
      resolve(evidenceDir, 'gps-summary.json'),
      JSON.stringify(
        {
          result: 'PASS',
          sentUnique: 3,
          lostDuringSwitch: duringSwitch.status,
          lostDuringRollback: duringRollback.status,
          persisted: gps.positions,
          receipts: gps.receipts,
          retryAckStable: repeat.persistedAt === second.persistedAt,
          eventIds: gps.eventIds,
          batchIds: gps.batchIds,
        },
        null,
        2,
      ),
    );

    await stage('missing_image', () => {
      const result = docker(['image', 'inspect', `${prefix}-missing:never`], {
        allowFailure: true,
      });
      assert.notEqual(result.status, 0, 'Missing image accepted');
    });
    await stage('invalid_configuration', () => {
      const result = docker(
        [
          'run',
          '--rm',
          '--pull',
          'never',
          '--network',
          'none',
          '--env-file',
          envPath,
          '-e',
          'GEOPS_DATA_MODE=invalid',
          '--entrypoint',
          'node',
          options['api-b'],
          'apps/api/dist/main.js',
        ],
        { timeout: 10_000, allowFailure: true },
      );
      assert.notEqual(result.status, 0, 'Invalid configuration started');
    });
    await stage('candidate_not_ready', async () => {
      stop(names.webA);
      stop(names.apiA);
      startApi(names.apiBad, options['api-b'], [
        '-e',
        'GEOPS_SECURITY_GATE_PATH=/missing/security-gate.json',
      ]);
      try {
        await waitFor(() => apiReady(names.apiBad), 5_000, 'invalid candidate');
        throw new Error('Invalid candidate became ready');
      } catch (error) {
        if (!error.message.includes('did not become ready')) throw error;
      }
      stop(names.apiBad);
      start(names.apiA);
      start(names.webA);
      await waitFor(
        () => apiReady(names.apiA) && webReady(names.webA),
        45_000,
        'A after invalid candidate',
      );
    });
    await stage('deployment_timeout', async () => {
      stop(names.webA);
      stop(names.apiA);
      startApi(names.apiSlow, options['api-b'], ['--entrypoint', 'sh'], ['-c', 'sleep 30']);
      try {
        await waitFor(() => apiReady(names.apiSlow), 3_000, 'slow candidate');
        throw new Error('Slow candidate became ready');
      } catch (error) {
        if (!error.message.includes('did not become ready')) throw error;
      }
      stop(names.apiSlow);
      start(names.apiA);
      start(names.webA);
      await waitFor(() => apiReady(names.apiA) && webReady(names.webA), 45_000, 'A after timeout');
    });

    const migrations = docker([
      'exec',
      names.db,
      'psql',
      '-U',
      'postgres',
      '-d',
      databaseName,
      '-Atc',
      'SELECT count(*) FROM geops_schema_migrations',
    ]).stdout.trim();
    const expectedMigrationCount = JSON.parse(
      readFileSync(resolve(evidenceDir, 'manifest.json'), 'utf8'),
    ).migrationCount;
    assert.equal(Number(migrations), expectedMigrationCount);
    assert.ok(apiReady(names.apiA) && webReady(names.webA));
    passed = true;
    writeFileSync(
      resolve(evidenceDir, 'result.json'),
      JSON.stringify(
        {
          result: 'PASS',
          scope: 'isolated_docker_rehearsal',
          runId,
          migrationCount: expectedMigrationCount,
          gps,
        },
        null,
        2,
      ),
    );
  } finally {
    const current = docker(['ps', '--format', '{{.ID}}|{{.Names}}'], { allowFailure: true })
      .stdout.trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const unrelated = current.filter(
      (entry) => !Object.values(names).some((name) => entry.endsWith(`|${name}`)),
    );
    writeFileSync(
      resolve(evidenceDir, 'unrelated-containers.json'),
      JSON.stringify({ before: baseline, after: unrelated }, null, 2),
    );
    for (const name of [...ownedContainers].reverse()) {
      try {
        const label = docker(
          ['container', 'inspect', name, '--format', '{{index .Config.Labels "geops.deploy.p0"}}'],
          { allowFailure: true },
        ).stdout.trim();
        if (label === runId) docker(['rm', '-f', name], { allowFailure: true });
      } catch {
        /* preserve evidence and continue only with owned resources */
      }
    }
    if (networkCreated) {
      const label = docker(
        ['network', 'inspect', network, '--format', '{{index .Labels "geops.deploy.p0"}}'],
        { allowFailure: true },
      ).stdout.trim();
      if (label === runId) docker(['network', 'rm', network], { allowFailure: true });
    }
    // Keep the newly created synthetic gate volume and all four images for audit/rollback.
    const remainingOwned = ownedContainers.filter((name) => containerExists(name));
    const networkRemaining =
      docker(['network', 'inspect', network], { allowFailure: true }).status === 0;
    writeFileSync(
      resolve(evidenceDir, 'cleanup.json'),
      JSON.stringify(
        {
          ownedContainersRemoved: ownedContainers.filter((name) => !remainingOwned.includes(name)),
          remainingOwned,
          networkRemoved: networkCreated && !networkRemaining,
          gateVolumeRetained: gateCreated ? gateVolume : null,
          imagesRetained: options,
        },
        null,
        2,
      ),
    );
    if (!passed)
      writeFileSync(
        resolve(evidenceDir, 'result.json'),
        JSON.stringify({ result: 'BLOCKED', runId }, null, 2),
      );
    console.log(`Evidence: ${evidenceDir}`);
  }
}

main().catch((error) => {
  console.error(`Isolated rehearsal BLOCKED: ${error.message}`);
  process.exitCode = 1;
});
