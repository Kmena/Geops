import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareInventories } from './replica-check.mjs';

const before = {
  version: 14,
  epoch_digest: 'synthetic-epoch-digest',
  identity: { admins_total: 2, active_admins: 1, permissions_total: 9, permissions: 8 },
  data: { policies: 3, gps_sessions: 4, positions: 12, health_events: 5, audit_events: 7 },
};

test('schema 14-17 to 17 preserves epoch, identities, grants, GPS and audit counts', () => {
  for (const version of [14, 15, 16, 17]) {
    const source = { ...before, version };
    assert.equal(compareInventories(source, { ...source, version: 17 }).result, 'PASS');
  }
});

test('missing migration, changed epoch, lost permission or changed GPS data blocks release evidence', () => {
  for (const changed of [
    { ...before, version: 14 },
    { ...before, version: 17, epoch_digest: 'different' },
    { ...before, version: 17, identity: { ...before.identity, permissions: 7 } },
    { ...before, version: 17, data: { ...before.data, positions: 11 } },
  ])
    assert.throws(() => compareInventories(before, changed));
});
