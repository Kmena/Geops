import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { validatePlan } from './preflight.mjs';

const supervisedVersions = new Set([
  '0019_mdm_security.sql',
  '0021_gps_offline_policy_contract.sql',
]);

export function assertAutomaticExpandCompatible(candidateMigrations, previousMigrations) {
  const additions = candidateMigrations.slice(previousMigrations.length);
  assert.ok(
    additions.every((item) => !supervisedVersions.has(item.version)),
    'SQL 0019/0021 requires a separately reviewed supervised migration strategy',
  );
}

const variantKeys = { 'gps-base': 'gpsBase', 'mdm-qa': 'mdmQa' };

export function createPlan(candidate, previous, qaVariant) {
  const variantKey = variantKeys[qaVariant];
  assert.ok(variantKey, 'Explicit QA Web variant required: gps-base or mdm-qa');
  for (const item of [candidate, previous]) {
    assert.equal(item.schemaVersion, 3, 'Release manifest schema 3 required');
    assert.equal(item.ci?.result, 'success', 'Successful CI required');
    assert.ok(
      Array.isArray(item.migrations) && item.migrations.length > 0,
      'Migration checksums required',
    );
    assert.equal(item.webBuild?.[variantKey]?.variant, qaVariant, 'Web variant metadata mismatch');
    assert.equal(
      item.webBuild[variantKey].mdmEnabled,
      qaVariant === 'mdm-qa',
      'Web MDM setting mismatch',
    );
    assert.ok(item.images?.web?.gpsBase && item.images?.web?.mdmQa, 'Both Web digests required');
    assert.notEqual(
      item.images.web.gpsBase.split('@')[1],
      item.images.web.mdmQa.split('@')[1],
      'Web variant digests must differ',
    );
  }
  assert.notEqual(candidate.commit, previous.commit, 'Distinct commits required');
  const same = JSON.stringify(candidate.migrations) === JSON.stringify(previous.migrations);
  const expanded =
    candidate.migrations.length > previous.migrations.length &&
    JSON.stringify(candidate.migrations.slice(0, previous.migrations.length)) ===
      JSON.stringify(previous.migrations);
  assert.ok(same || expanded, 'Incompatible migration set blocks image rollback');
  if (expanded) assertAutomaticExpandCompatible(candidate.migrations, previous.migrations);
  assert.equal(
    candidate.migration,
    same ? 'none' : 'expand',
    'Reviewed migration class mismatches SQL checksums',
  );
  const plan = {
    schemaVersion: 1,
    commit: candidate.commit,
    qaVariant,
    migration: candidate.migration,
    candidate: { api: candidate.images.api, web: candidate.images.web[variantKey] },
    previous: { api: previous.images.api, web: previous.images.web[variantKey] },
    provenance: {
      previousCommit: previous.commit,
      candidateCiRun: candidate.ci.run,
      previousCiRun: previous.ci.run,
      candidateCreatedAt: candidate.createdAt,
      previousCreatedAt: previous.createdAt,
      candidateMigrations: candidate.migrations,
      previousMigrations: previous.migrations,
    },
  };
  return validatePlan(plan);
}

if (process.argv[1]?.endsWith('create-plan.mjs')) {
  try {
    const [candidatePath, previousPath, output, qaVariant] = process.argv.slice(2);
    assert.ok(
      candidatePath && previousPath && output,
      'Usage: create-plan.mjs CANDIDATE PREVIOUS OUTPUT QA_VARIANT',
    );
    const plan = createPlan(
      JSON.parse(readFileSync(candidatePath, 'utf8')),
      JSON.parse(readFileSync(previousPath, 'utf8')),
      qaVariant,
    );
    writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({
        result: 'PLAN_CREATED',
        path: output,
        commit: plan.commit,
        qaVariant: plan.qaVariant,
      }),
    );
  } catch (error) {
    console.error(`Plan BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
