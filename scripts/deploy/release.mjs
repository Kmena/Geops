import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan } from './preflight.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const base = 'infrastructure/compose/compose.staging.yaml';
const override = 'infrastructure/compose/compose.staging.digest.override.yaml';

export function parseReleaseArgs(argv) {
  const options = { command: argv[0], execute: false };
  assert.ok(
    ['prepare', 'deploy', 'rollback'].includes(options.command),
    'Command must be prepare, deploy or rollback',
  );
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--execute') options.execute = true;
    else if (['--plan', '--env-file', '--log', '--state'].includes(key))
      options[key.slice(2)] = argv[++i];
    else throw new Error('Unknown release option');
  }
  for (const key of ['plan', 'env-file', 'log', 'state'])
    assert.ok(options[key], `${key} required`);
  assert.ok(options.execute, 'Explicit --execute required');
  return options;
}

function run(executable, args, { env = process.env, timeout = 120_000 } = {}) {
  try {
    return execFileSync(executable, args, {
      cwd: root,
      env,
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`${executable} step failed or timed out; inspect host logs privately`);
  }
}

function stage(log, name, fn) {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  let result = 'PASS';
  try {
    return fn();
  } catch (error) {
    result = 'FAIL';
    throw error;
  } finally {
    appendFileSync(
      log,
      `${JSON.stringify({
        stage: name,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        result,
      })}\n`,
      { mode: 0o600 },
    );
  }
}

function imageId(ref, commit) {
  const digests = JSON.parse(
    run('docker', ['image', 'inspect', ref, '--format', '{{json .RepoDigests}}']),
  );
  assert.ok(digests?.includes(ref), 'Registry digest unavailable in local image store');
  assert.equal(
    run('docker', [
      'image',
      'inspect',
      ref,
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ]),
    commit,
    'Image revision label mismatches release manifest',
  );
  return run('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']);
}

function expectedCommit(plan, version) {
  return version === 'candidate' ? plan.commit : plan.provenance.previousCommit;
}

export function embeddedMigrationScript(directory = '/work/apps/api/dist/db/migrations/') {
  return `const{createHash}=require('node:crypto');const{readFileSync,readdirSync}=require('node:fs');const{join}=require('node:path');const p=${JSON.stringify(directory)};console.log(JSON.stringify(readdirSync(p).filter(n=>/^\\d+_[a-z0-9_]+\\.sql$/.test(n)).sort().map(n=>({version:n,sha256:createHash('sha256').update(readFileSync(join(p,n))).digest('hex')}))))`;
}

export function assertImageMigrations(actual, expected) {
  assert.deepEqual(actual, expected, 'API image SQL differs from release manifest');
}

function verifyImageMigrations(ref, expected) {
  const actual = JSON.parse(
    run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--pull',
        'never',
        '--entrypoint',
        'node',
        ref,
        '-e',
        embeddedMigrationScript(),
      ],
      { timeout: 30_000 },
    ),
  );
  assertImageMigrations(actual, expected);
}

function composeArgs(envFile, service, target, plan) {
  const env = {
    ...process.env,
    GEOPS_STAGE_API_IMAGE_REF: plan[target].api,
    GEOPS_STAGE_WEB_IMAGE_REF: plan[target].web,
  };
  return {
    args: ['compose', '--env-file', resolve(envFile), '-f', base, '-f', override],
    env,
    service,
  };
}

function containerId(settings) {
  return run('docker', [...settings.args, 'ps', '-q', settings.service], { env: settings.env });
}

function health(settings, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = containerId(settings);
    if (id) {
      const status = run('docker', [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
        id,
      ]);
      if (status === 'healthy') return id;
      if (status === 'unhealthy' || status === 'exited')
        throw new Error(`${settings.service} is ${status}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`${settings.service} readiness timeout`);
}

function snapshot(settings) {
  const ids = {};
  for (const service of ['geops-db', 'geops-api', 'geops-web']) {
    const id = containerId({ ...settings, service });
    if (service === 'geops-db') assert.ok(id, 'Staging database must already be running');
    ids[service] = id;
  }
  return ids;
}

function verifyUnchanged(before, after) {
  assert.equal(after['geops-db'], before['geops-db'], 'Database container changed');
}

function assertCurrent(settings, plan, target) {
  for (const [service, key] of [
    ['geops-api', 'api'],
    ['geops-web', 'web'],
  ]) {
    const id = containerId({ ...settings, service });
    assert.ok(id, `${service} not running`);
    const runningImage = run('docker', ['inspect', '--format', '{{.Image}}', id]);
    assert.equal(
      runningImage,
      imageId(plan[target][key], expectedCommit(plan, target)),
      `${service} is not ${target}`,
    );
  }
}

function smoke(settings) {
  const api = containerId({ ...settings, service: 'geops-api' });
  const web = containerId({ ...settings, service: 'geops-web' });
  run(
    'docker',
    [
      'exec',
      api,
      'node',
      '-e',
      "Promise.all(['/health/live','/health/ready'].map(p=>fetch('http://127.0.0.1:3500'+p).then(r=>{if(!r.ok)throw Error(p)}))).catch(()=>process.exit(1))",
    ],
    { timeout: 15_000 },
  );
  run('docker', ['exec', web, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health'], {
    timeout: 15_000,
  });
}

function switchTo(settings, plan, target, log) {
  for (const [service, key] of [
    ['geops-api', 'api'],
    ['geops-web', 'web'],
  ]) {
    const selected = { ...settings, service };
    stage(log, `activate_${target}_${key}`, () =>
      run(
        'docker',
        [...selected.args, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', service],
        { env: selected.env, timeout: 120_000 },
      ),
    );
    stage(log, `readiness_${target}_${key}`, () => health(selected));
  }
  stage(log, `verify_${target}`, () => assertCurrent(settings, plan, target));
  stage(log, `smoke_${target}`, () => smoke(settings));
}

function main() {
  const options = parseReleaseArgs(process.argv.slice(2));
  const log = resolve(options.log);
  const plan = validatePlan(JSON.parse(readFileSync(resolve(options.plan), 'utf8')));
  assert.ok(
    plan.provenance?.candidateMigrations?.length && plan.provenance?.previousMigrations?.length,
    'Plan must be generated from two release manifests',
  );
  assert.match(plan.provenance.previousCommit ?? '', /^[a-f0-9]{40}$/, 'Previous commit required');
  assert.equal(
    plan.migration,
    'none',
    'Automatic change requires identical SQL migrations; use maintenance runbook for expand',
  );
  assert.equal(
    JSON.stringify(plan.provenance.candidateMigrations),
    JSON.stringify(plan.provenance.previousMigrations),
    'Migration sets differ',
  );
  const dockerHost = run('docker', [
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  assert.match(dockerHost, /^(npipe|unix):\/\//, 'Remote Docker context forbidden');
  const target = options.command === 'rollback' ? 'previous' : 'candidate';
  stage(log, 'preflight', () =>
    run('node', [
      'scripts/deploy/preflight.mjs',
      '--plan',
      resolve(options.plan),
      '--env-file',
      resolve(options['env-file']),
      '--target',
      target,
    ]),
  );
  if (options.command === 'prepare') {
    for (const version of ['previous', 'candidate']) {
      for (const service of ['api', 'web']) {
        stage(log, `pull_${version}_${service}`, () => {
          run('docker', ['pull', plan[version][service]], { timeout: 180_000 });
          imageId(plan[version][service], expectedCommit(plan, version));
          if (service === 'api')
            verifyImageMigrations(plan[version][service], plan.provenance[`${version}Migrations`]);
        });
      }
    }
    console.log(JSON.stringify({ result: 'PREPARED', commit: plan.commit }));
    return;
  }
  stage(log, 'verify_images', () => {
    for (const version of ['candidate', 'previous'])
      for (const service of ['api', 'web']) {
        imageId(plan[version][service], expectedCommit(plan, version));
        if (service === 'api')
          verifyImageMigrations(plan[version][service], plan.provenance[`${version}Migrations`]);
      }
  });
  const settings = composeArgs(options['env-file'], null, target, plan);
  const before = stage(log, 'snapshot', () => snapshot(settings));
  const source = options.command === 'deploy' ? 'previous' : 'candidate';
  let alreadyActive = false;
  try {
    assertCurrent(settings, plan, target);
    alreadyActive = true;
  } catch {
    /* inspect source next */
  }
  if (!alreadyActive) stage(log, `verify_${source}`, () => assertCurrent(settings, plan, source));
  try {
    if (!alreadyActive) switchTo(settings, plan, target, log);
    else {
      for (const service of ['geops-api', 'geops-web'])
        stage(log, `readiness_${target}_${service}`, () => health({ ...settings, service }));
      stage(log, `smoke_${target}`, () => smoke(settings));
    }
    const after = snapshot(settings);
    verifyUnchanged(before, after);
    appendFileSync(
      resolve(options.state),
      `${JSON.stringify({
        committedAt: new Date().toISOString(),
        commit: plan.commit,
        active: target,
        images: plan[target],
        before,
        after,
        alreadyActive,
      })}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        result: alreadyActive ? 'ALREADY_ACTIVE' : 'ACTIVE',
        target,
        commit: plan.commit,
      }),
    );
  } catch (error) {
    if (options.command === 'deploy') {
      try {
        const recovery = composeArgs(options['env-file'], null, 'previous', plan);
        switchTo(recovery, plan, 'previous', log);
        verifyUnchanged(before, snapshot(recovery));
        console.error('Deployment failed; previous digest restored and healthy');
      } catch {
        console.error('Deployment and automatic recovery failed; operator intervention required');
      }
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith('release.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(`Release BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
