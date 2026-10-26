import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpec03CandidateManifest } from './spec03-candidate-manifest.mjs';
import {
  newJournal,
  recoverUpgrade,
  runUpgrade,
  UpgradeBlocked,
} from './spec03-upgrade-supervisor.mjs';

const B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d';
const candidate = createSpec03CandidateManifest();

function lab(manifest) {
  const state = { schema: 23, sqlListSha256: B23, api: 'B23', web: 'B23', gate: 'open' };
  const evidence = [];
  return {
    state,
    evidence,
    async observe() {
      return { ...state };
    },
    async save(journal) {
      evidence.push({ journal: structuredClone(journal), state: { ...state } });
    },
    async step(name) {
      if (name === 'drain') state.gate = 'closed';
      if (name === 'backup') return { sha256: 'a'.repeat(64) };
      if (name === 'prepare') {
        state.api = 'stopped';
        state.web = 'stopped';
      }
      if (name === 'migrate') {
        state.schema = 30;
        state.sqlListSha256 = manifest.database.targetListSha256;
      }
      if (name === 'api') state.api = 'B30';
      if (name === 'web') state.web = 'B30';
      if (name === 'health') return { api: true, web: true, db: true };
      if (name === 'confirm') state.gate = 'open';
      return undefined;
    },
    async recover(mode) {
      if (mode === 'FORWARD_B30') {
        assert.equal(state.schema, 30);
        state.api = 'B30';
        state.web = 'B30';
        state.gate = 'open';
      } else {
        assert.equal(state.schema, 23);
        state.api = 'B23';
        state.web = 'B23';
        state.gate = 'open';
      }
    },
  };
}

test('B23 to B30 keeps applications stopped across the migration and confirms only healthy B30', async () => {
  const manifest = candidate;
  const adapter = lab(manifest);
  const journal = newJournal(manifest, adapter.state);
  await runUpgrade(manifest, journal, adapter);
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.backupSha256, 'a'.repeat(64));
  assert.equal(adapter.state.schema, 30);
  assert.equal(adapter.state.api, 'B30');
  assert.equal(adapter.state.gate, 'open');
  for (const entry of adapter.evidence) {
    if (entry.state.schema === 30) {
      assert.notEqual(entry.state.api, 'B23');
      assert.notEqual(entry.state.web, 'B23');
    }
  }
  await runUpgrade(manifest, journal, adapter);
  assert.equal(journal.phase, 'complete');
});

for (const step of [
  'preflight',
  'drain',
  'backup',
  'prepare',
  'migrate',
  'api',
  'web',
  'health',
  'confirm',
]) {
  test(`interruption after ${step} has idempotent, schema-safe recovery`, async () => {
    const manifest = candidate;
    const adapter = lab(manifest);
    const journal = newJournal(manifest, adapter.state);
    await assert.rejects(
      runUpgrade(manifest, journal, adapter, { interruptAfter: step }),
      /INJECTED_INTERRUPTION/,
    );
    const persisted = structuredClone(adapter.evidence.at(-1).journal);
    await recoverUpgrade(manifest, persisted, adapter);
    const expected = ['preflight', 'drain', 'backup', 'prepare'].includes(step) ? 'B23' : 'B30';
    assert.equal(adapter.state.api, expected);
    assert.equal(adapter.state.web, expected);
    assert.equal(adapter.state.gate, 'open');
    assert.equal(persisted.phase, expected === 'B30' ? 'complete' : 'pending');
    if (expected === 'B23') await runUpgrade(manifest, persisted, adapter);
    assert.equal(adapter.state.schema, 30);
    assert.equal(adapter.state.api, 'B30');
  });
  test(`failure during ${step} recovers from persisted journal`, async () => {
    const manifest = candidate;
    const adapter = lab(manifest);
    const journal = newJournal(manifest, adapter.state);
    const normal = adapter.step.bind(adapter);
    adapter.step = async (name, value) => {
      if (name === step) throw new Error(`INJECTED_FAILURE:${step}`);
      return normal(name, value);
    };
    await assert.rejects(runUpgrade(manifest, journal, adapter), /INJECTED_FAILURE/);
    adapter.step = normal;
    const persisted = structuredClone(adapter.evidence.at(-1).journal);
    await recoverUpgrade(manifest, persisted, adapter);
    const expected = ['preflight', 'drain', 'backup', 'prepare', 'migrate'].includes(step)
      ? 'B23'
      : 'B30';
    assert.equal(adapter.state.api, expected);
    assert.equal(adapter.state.web, expected);
    assert.equal(adapter.state.gate, 'open');
  });
}

test('tampered ledger and old API on B30 fail closed', async () => {
  const manifest = candidate;
  const adapter = lab(manifest);
  const journal = newJournal(manifest, adapter.state);
  adapter.state.schema = 30;
  adapter.state.sqlListSha256 = manifest.database.targetListSha256;
  await assert.rejects(runUpgrade(manifest, journal, adapter), UpgradeBlocked);
  adapter.state.api = 'stopped';
  adapter.state.web = 'stopped';
  adapter.state.sqlListSha256 = '0'.repeat(64);
  await assert.rejects(recoverUpgrade(manifest, journal, adapter), /checksum mismatch/);
});
