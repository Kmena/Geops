import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareInventories } from './replica-check.mjs';

const before = {
  version: 14,
  epoch_digest: 'synthetic-epoch-digest',
  identity: { admins_total: 2, active_admins: 1, permissions_total: 9, permissions: 8 },
  data: { policies: 3, gps_sessions: 4, positions: 12, health_events: 5, audit_events: 7 },
};

test('0014 to 0015 preserves epoch, identities, grants, GPS and audit counts', () => {
  assert.equal(compareInventories(before, { ...before, version: 15 }).result, 'PASS');
});

test('missing migration, changed epoch, lost permission or changed GPS data blocks release evidence', () => {
  for (const changed of [
    { ...before, version: 14 },
    { ...before, version: 15, epoch_digest: 'different' },
    { ...before, version: 15, identity: { ...before.identity, permissions: 7 } },
    { ...before, version: 15, data: { ...before.data, positions: 11 } },
  ])
    assert.throws(() => compareInventories(before, changed));
});
