import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationChecksums } from './create-manifest.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const base = 'infrastructure/compose/compose.staging.yaml';
const mdmOverlay = 'infrastructure/compose/compose.staging.mdm.override.yaml';
const override = 'infrastructure/compose/compose.staging.digest.override.yaml';
const digestRef = /^[a-z0-9][a-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;

export function validatePlan(plan) {
  assert.equal(plan.schemaVersion, 1, 'Unsupported plan schema');
  assert.match(plan.commit ?? '', /^[a-f0-9]{40}$/, 'Commit must be a full SHA');
  assert.notEqual(plan.commit, '0'.repeat(40), 'Example commit is forbidden');
  assert.ok(['gps-base', 'mdm-qa'].includes(plan.qaVariant), 'Explicit QA Web variant required');
  assert.ok(['none', 'expand', 'contract'].includes(plan.migration), 'Invalid migration class');
  assert.notEqual(plan.migration, 'contract', 'Contract migration has no image-only rollback');
  for (const version of ['candidate', 'previous']) {
    for (const service of ['api', 'web']) {
      const ref = plan[version]?.[service] ?? '';
      assert.match(ref, digestRef, `${version}.${service} must be a registry digest reference`);
      assert.ok(!ref.includes('example.invalid'), 'Example registry is forbidden');
    }
  }
  for (const service of ['api', 'web'])
    assert.notEqual(
      plan.candidate[service],
      plan.previous[service],
      `${service} has no rollback version`,
    );
  return plan;
}

export function compareCompose(before, after, plan, target = 'candidate') {
  assert.equal(before.name, 'geops-spec02-staging');
  assert.equal(after.name, before.name);
  const mdmEnabled = plan.qaVariant === 'mdm-qa' ? 'true' : 'false';
  assert.equal(before.services['geops-api'].environment.MDM_ENABLED, mdmEnabled);
  assert.equal(before.services['geops-web'].build.args.MDM_ENABLED, mdmEnabled);
  assert.ok(
    isDeepStrictEqual(Object.keys(after.services).sort(), Object.keys(before.services).sort()),
    'Service set changed',
  );
  assert.equal(after.services['geops-api'].image, plan[target].api);
  assert.equal(after.services['geops-web'].image, plan[target].web);
  const normalized = structuredClone(after);
  normalized.services['geops-api'].image = before.services['geops-api'].image;
  normalized.services['geops-web'].image = before.services['geops-web'].image;
  assert.ok(
    isDeepStrictEqual(normalized, before),
    'Digest overlay changed more than API/Web images',
  );
}

function command(executable, args, env = process.env) {
  return execFileSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function compose(envFile, files, env) {
  const args = ['compose', '--env-file', envFile];
  for (const file of files) args.push('-f', file);
  args.push('--profile', 'maintenance', 'config', '--format', 'json');
  return JSON.parse(command('docker', args, env));
}

export function parseArgs(argv) {
  const options = { verifyLocalImages: false, planOnly: false, target: 'candidate' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') options.plan = argv[++i];
    else if (argv[i] === '--env-file') options.envFile = argv[++i];
    else if (argv[i] === '--verify-local-images') options.verifyLocalImages = true;
    else if (argv[i] === '--plan-only') options.planOnly = true;
    else if (argv[i] === '--target') options.target = argv[++i];
    else throw new Error('Unknown preflight option');
  }
  assert.ok(options.plan, '--plan is required');
  assert.ok(options.planOnly || options.envFile, '--env-file is required');
  assert.ok(
    ['candidate', 'previous'].includes(options.target),
    'Target must be candidate or previous',
  );
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = validatePlan(JSON.parse(readFileSync(resolve(options.plan), 'utf8')));
  if (options.planOnly) {
    console.log(
      JSON.stringify({
        result: 'PLAN_VALID',
        commit: plan.commit,
        qaVariant: plan.qaVariant,
        migration: plan.migration,
      }),
    );
    return;
  }
  assert.equal(
    command('git', ['rev-parse', 'HEAD']),
    plan.commit,
    'Checkout does not match approved commit',
  );
  assert.equal(command('git', ['status', '--porcelain']), '', 'Release checkout is dirty');
  assert.ok(
    Array.isArray(plan.provenance?.candidateMigrations),
    'Candidate SQL checksums required',
  );
  assert.ok(
    isDeepStrictEqual(migrationChecksums(), plan.provenance.candidateMigrations),
    'Candidate SQL checksums differ from approved checkout',
  );
  const env = {
    ...process.env,
    GEOPS_STAGE_API_IMAGE_REF: plan[options.target].api,
    GEOPS_STAGE_WEB_IMAGE_REF: plan[options.target].web,
  };
  const files = plan.qaVariant === 'mdm-qa' ? [base, mdmOverlay] : [base];
  const before = compose(resolve(options.envFile), files, env);
  const after = compose(resolve(options.envFile), [...files, override], env);
  compareCompose(before, after, plan, options.target);
  if (options.verifyLocalImages) {
    for (const version of ['candidate', 'previous']) {
      for (const service of ['api', 'web']) {
        const ref = plan[version][service];
        const digests = JSON.parse(
          command('docker', ['image', 'inspect', ref, '--format', '{{json .RepoDigests}}']),
        );
        assert.ok(digests?.includes(ref), `${version}.${service} digest unavailable locally`);
        if (service === 'web') {
          const label = command('docker', [
            'image',
            'inspect',
            ref,
            '--format',
            '{{index .Config.Labels "org.geops.web.variant"}}',
          ]);
          assert.equal(label, plan.qaVariant, `${version}.web variant mismatch`);
          const mdmLabel = command('docker', [
            'image',
            'inspect',
            ref,
            '--format',
            '{{index .Config.Labels "org.geops.web.mdm_enabled"}}',
          ]);
          assert.equal(
            mdmLabel,
            plan.qaVariant === 'mdm-qa' ? 'true' : 'false',
            `${version}.web MDM label mismatch`,
          );
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      result: options.verifyLocalImages ? 'LOCAL_IMAGES_VALID' : 'COMPOSE_VALID',
      target: options.target,
      commit: plan.commit,
      qaVariant: plan.qaVariant,
      migration: plan.migration,
      candidate: plan.candidate,
      previous: plan.previous,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `Preflight BLOCKED: ${error instanceof Error ? error.message : 'Unknown failure'}`,
    );
    process.exitCode = 1;
  }
}
