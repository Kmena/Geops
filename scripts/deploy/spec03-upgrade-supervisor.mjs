import assert from 'node:assert/strict';

const B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d';
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

export class UpgradeBlocked extends Error {}

export function validateCandidate(manifest) {
  if (
    manifest?.kind !== 'SPEC03_RELEASE_CANDIDATE_DRAFT' ||
    manifest.database?.minimumSourceSchema !== 23 ||
    manifest.database?.targetSchema !== 30 ||
    manifest.database?.b23PrefixSha256 !== B23 ||
    !/^[a-f0-9]{64}$/.test(manifest.database?.targetListSha256 ?? '') ||
    manifest.compatibility?.apiAfterMigration !== 'SPEC03_API_SCHEMA_30_ONLY'
  )
    throw new UpgradeBlocked('Unrecognized SPEC-03 B30 candidate');
}

export function newJournal(manifest, observed) {
  validateCandidate(manifest);
  if (
    observed.schema !== 23 ||
    observed.sqlListSha256 !== B23 ||
    observed.api !== 'B23' ||
    observed.web !== 'B23' ||
    observed.gate !== 'open'
  )
    throw new UpgradeBlocked('B23 source and open gate required');
  return {
    schemaVersion: 1,
    candidate: manifest.identity,
    phase: 'pending',
    lastCompleted: null,
    recovery: null,
    backupSha256: null,
    sourceSqlListSha256: B23,
    targetSqlListSha256: manifest.database.targetListSha256,
  };
}

function assertObserved(journal, observed) {
  if (observed.schema === 30) {
    if (observed.sqlListSha256 !== journal.targetSqlListSha256)
      throw new UpgradeBlocked('B30 ledger checksum mismatch');
    if (observed.api === 'B23' || observed.web === 'B23')
      throw new UpgradeBlocked('Old application cannot run against B30');
  } else if (observed.schema !== 23 || observed.sqlListSha256 !== B23) {
    throw new UpgradeBlocked('Unexpected migration ledger');
  }
  if (observed.schema === 23 && (observed.api === 'B30' || observed.web === 'B30'))
    throw new UpgradeBlocked('New application cannot run against B23');
}

export async function runUpgrade(manifest, journal, adapter, { interruptAfter } = {}) {
  validateCandidate(manifest);
  assert.equal(journal.candidate, manifest.identity);
  if (journal.phase === 'complete') return journal;
  if (journal.phase === 'recovery')
    throw new UpgradeBlocked('Recover interrupted transition first');
  const start = journal.lastCompleted === null ? 0 : steps.indexOf(journal.lastCompleted) + 1;
  if (start < 0) throw new UpgradeBlocked('Unknown journal step');
  for (const step of steps.slice(start)) {
    const observed = await adapter.observe();
    assertObserved(journal, observed);
    if (
      step === 'migrate' &&
      (observed.api !== 'stopped' || observed.web !== 'stopped' || observed.gate !== 'closed')
    )
      throw new UpgradeBlocked('Applications and gate must be stopped before migration');
    if (['api', 'web', 'health', 'confirm'].includes(step) && observed.schema !== 30)
      throw new UpgradeBlocked('B30 schema required before application startup');
    journal.phase = step;
    await adapter.save(journal);
    const result = await adapter.step(step, manifest);
    if (step === 'health' && (result?.api !== true || result?.web !== true || result?.db !== true))
      throw new UpgradeBlocked('B30 API, Web and database health required');
    if (step === 'backup') {
      if (!/^[a-f0-9]{64}$/.test(result?.sha256 ?? ''))
        throw new UpgradeBlocked('Verified backup digest required');
      journal.backupSha256 = result.sha256;
    }
    const after = await adapter.observe();
    assertObserved(journal, after);
    if (
      step === 'migrate' &&
      (after.schema !== 30 || after.api !== 'stopped' || after.web !== 'stopped')
    )
      throw new UpgradeBlocked('B30 migration did not finish with applications stopped');
    if (step === 'confirm' && (after.api !== 'B30' || after.web !== 'B30' || after.gate !== 'open'))
      throw new UpgradeBlocked('Cannot confirm incomplete B30 release');
    journal.lastCompleted = step;
    journal.phase = step === 'confirm' ? 'complete' : 'pending';
    await adapter.save(journal);
    if (interruptAfter === step) throw new Error(`INJECTED_INTERRUPTION:${step}`);
  }
  return journal;
}

export async function recoverUpgrade(manifest, journal, adapter) {
  validateCandidate(manifest);
  const observed = await adapter.observe();
  assertObserved(journal, observed);
  if (journal.phase === 'complete') return journal;
  journal.phase = 'recovery';
  journal.recovery = observed.schema === 30 ? 'FORWARD_B30' : 'RESTORE_B23';
  await adapter.save(journal);
  await adapter.recover(journal.recovery, manifest);
  const after = await adapter.observe();
  assertObserved(journal, after);
  if (journal.recovery === 'FORWARD_B30') {
    if (after.schema !== 30 || after.api !== 'B30' || after.web !== 'B30' || after.gate !== 'open')
      throw new UpgradeBlocked('Forward B30 recovery incomplete');
    journal.lastCompleted = 'confirm';
    journal.phase = 'complete';
  } else {
    if (after.schema !== 23 || after.api !== 'B23' || after.web !== 'B23' || after.gate !== 'open')
      throw new UpgradeBlocked('B23 source recovery incomplete');
    journal.lastCompleted = null;
    journal.phase = 'pending';
  }
  await adapter.save(journal);
  return journal;
}
