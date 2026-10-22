import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan } from './preflight.mjs';
import { assertAutomaticExpandCompatible } from './create-plan.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const base = 'infrastructure/compose/compose.staging.yaml';
const mdmOverlay = 'infrastructure/compose/compose.staging.mdm.override.yaml';
const digestOverlay = 'infrastructure/compose/compose.staging.digest.override.yaml';
const migrateOverlay = 'infrastructure/compose/compose.staging.migrate.digest.override.yaml';

function run(program, args, env, timeout = 120_000) {
  try {
    return execFileSync(program, args, {
      cwd: root,
      env,
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`${program} operation failed or timed out; inspect private host logs`);
  }
}

function main() {
  const [planPath, envFile, logPath, authorization, execute] = process.argv.slice(2);
  assert.ok(
    planPath && envFile && logPath,
    'Usage: migrate.mjs PLAN ENV_FILE LOG AUTHORIZATION_ID --execute',
  );
  assert.match(
    authorization ?? '',
    /^[A-Za-z0-9][A-Za-z0-9._-]{5,80}$/,
    'Recorded authorization ID required',
  );
  assert.equal(execute, '--execute', 'Explicit execution flag required');
  const plan = validatePlan(JSON.parse(readFileSync(resolve(planPath), 'utf8')));
  assert.equal(plan.migration, 'expand', 'Only reviewed expand migrations are eligible');
  assert.ok(
    plan.provenance?.candidateMigrations?.length > plan.provenance?.previousMigrations?.length,
    'A generated migration comparison is required',
  );
  assert.equal(
    JSON.stringify(
      plan.provenance.candidateMigrations.slice(0, plan.provenance.previousMigrations.length),
    ),
    JSON.stringify(plan.provenance.previousMigrations),
    'Previous SQL checksum prefix changed',
  );
  assertAutomaticExpandCompatible(
    plan.provenance.candidateMigrations,
    plan.provenance.previousMigrations,
  );
  const dockerHost = run(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    process.env,
  );
  assert.match(dockerHost, /^(npipe|unix):\/\//, 'Remote Docker context forbidden');
  run(
    'node',
    ['scripts/deploy/preflight.mjs', '--plan', resolve(planPath), '--env-file', resolve(envFile)],
    process.env,
  );
  const env = {
    ...process.env,
    GEOPS_STAGE_API_IMAGE_REF: plan.candidate.api,
    GEOPS_STAGE_WEB_IMAGE_REF: plan.candidate.web,
  };
  const args = ['compose', '--env-file', resolve(envFile)];
  const files = [
    base,
    ...(plan.qaVariant === 'mdm-qa' ? [mdmOverlay] : []),
    digestOverlay,
    migrateOverlay,
  ];
  for (const file of files) args.push('-f', file);
  args.push('--profile', 'maintenance');
  const config = JSON.parse(run('docker', [...args, 'config', '--format', 'json'], env));
  assert.equal(config.services['geops-migrate'].image, plan.candidate.api);
  assert.ok(!config.services['geops-migrate'].build, 'Migration image must not build on host');
  assert.equal(config.services['geops-migrate'].environment.GEOPS_MIGRATION_TARGET, 'geops_dev');
  assert.equal(
    config.services['geops-migrate'].environment.GEOPS_CONFIRM_MIGRATION_TARGET,
    'geops_dev',
  );
  assert.equal(
    config.services['geops-migrate'].environment.GEOPS_ALLOW_NONDISPOSABLE_MIGRATION,
    'YES',
  );
  assert.ok(
    config.services['geops-migrate'].environment.GEOPS_CONFIRM_MAINTENANCE_EPOCH,
    'Maintenance epoch confirmation required',
  );
  const digests = JSON.parse(
    run(
      'docker',
      ['image', 'inspect', plan.candidate.api, '--format', '{{json .RepoDigests}}'],
      env,
    ),
  );
  assert.ok(digests.includes(plan.candidate.api), 'Candidate API digest not downloaded');
  assert.equal(
    run(
      'docker',
      [
        'image',
        'inspect',
        plan.candidate.api,
        '--format',
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      ],
      env,
    ),
    plan.commit,
    'Migration image revision mismatch',
  );
  for (const service of ['geops-api', 'geops-web'])
    assert.equal(
      run('docker', [...args, 'ps', '-q', service], env),
      '',
      `${service} must already be stopped under maintenance authorization`,
    );
  assert.ok(run('docker', [...args, 'ps', '-q', 'geops-db'], env), 'Database is not running');
  const startedAt = new Date().toISOString();
  const t = process.hrtime.bigint();
  let result = 'PASS';
  try {
    run('docker', [...args, 'run', '--rm', '--no-deps', '--no-TTY', 'geops-migrate'], env, 300_000);
  } catch (error) {
    result = 'FAIL';
    throw error;
  } finally {
    appendFileSync(
      resolve(logPath),
      `${JSON.stringify({
        stage: 'authorized_expand_migration',
        authorization,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Number((process.hrtime.bigint() - t) / 1_000_000n),
        result,
      })}\n`,
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify({ result: 'MIGRATION_APPLIED', authorization, commit: plan.commit }));
}

try {
  main();
} catch (error) {
  console.error(`Migration BLOCKED: ${error.message}`);
  process.exitCode = 1;
}
