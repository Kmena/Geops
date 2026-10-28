import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePolicy, windowsForRange } from '../src/gps-policy-windows.ts';

const policy = {
  name: 'MDM continuous synthetic',
  days_iso: [1, 2, 3, 4, 5, 6, 7],
  start_local: '00:00',
  end_local: '00:00',
  time_zone: 'UTC',
  capture_interval_s: 60,
  sync_interval_s: 300,
  heartbeat_missing_after_s: 900,
  health_interval_s: 300,
  valid_from: '2026-10-27T12:00:00Z',
  valid_until: '2026-10-30T12:00:00Z',
  exceptions: [],
  mdm_continuous: true,
};

test('MDM continuous windows cover midnight without a gap', () => {
  const windows = windowsForRange(
    policy,
    new Date('2026-10-27T12:00:00Z'),
    new Date('2026-10-30T12:00:00Z'),
  );
  assert.equal(windows.length, 4);
  assert.equal(windows[0].start_at, '2026-10-27T12:00:00.000Z');
  assert.equal(windows.at(-1).end_at, '2026-10-30T12:00:00.000Z');
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i - 1].end_at, windows[i].start_at);
});

test('ordinary policies cannot request a 24-hour MDM schedule', () => {
  assert.throws(() => validatePolicy(policy), /invalid_policy/);
  assert.throws(
    () =>
      windowsForRange(
        { ...policy, mdm_continuous: false },
        new Date(policy.valid_from),
        new Date(policy.valid_until),
      ),
    /invalid_policy/,
  );
});
