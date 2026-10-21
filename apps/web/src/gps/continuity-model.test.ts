import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  continuityDisplay,
  continuityFailure,
  continuityLabel,
  continuityReason,
} from './continuity-model.js';
import { ApiClientError } from '../api/client.js';
import type {
  RemoteContinuityAlert,
  RemoteGpsSession,
  RemoteHealth,
  RemotePosition,
} from './remote.js';

const now = Date.parse('2026-10-20T15:00:00Z');
const session = {
  scheduled_start_at: '2026-10-20T14:00:00Z',
  scheduled_end_at: '2026-10-20T16:00:00Z',
} as RemoteGpsSession;
const health = {
  observed_at: '2026-10-20T14:59:00Z',
  source: 'DEVICE_OBSERVATION',
  latest: { tracking_state: 'RUNNING' },
} as RemoteHealth;
const position = { captured_at: '2026-10-20T14:59:00Z' } as RemotePosition;
const alert = (
  reason_code: RemoteContinuityAlert['reason_code'],
  severity: RemoteContinuityAlert['severity'],
) => ({ status: 'OPEN', reason_code, severity }) as RemoteContinuityAlert;

test('normal requires recent positive evidence and a current scheduled window', () => {
  assert.equal(continuityDisplay([], [session], health, [position], now, now), 'NORMAL');
  assert.equal(continuityDisplay([], [session], health, [], now, now), 'UNKNOWN');
  assert.equal(
    continuityDisplay(
      [],
      [session],
      { ...health, source: 'SERVER_INFERENCE' },
      [position],
      now,
      now,
    ),
    'UNKNOWN',
  );
  assert.equal(
    continuityDisplay(
      [],
      [session],
      {
        ...health,
        latest: { ...health.latest, tracking_state: 'STOPPED' } as RemoteHealth['latest'],
      },
      [position],
      now,
      now,
    ),
    'UNKNOWN',
  );
  assert.equal(
    continuityDisplay([], [session], health, [position], now - 6 * 60_000, now),
    'UNKNOWN',
  );
  assert.equal(continuityDisplay([], [], health, [position], now, now), 'UNKNOWN');
  assert.equal(
    continuityDisplay(
      [],
      [{ ...session, scheduled_end_at: '2026-10-20T14:00:00Z' }],
      health,
      [position],
      now,
      now,
    ),
    'OUT_OF_HOURS',
  );
  assert.equal(
    continuityDisplay(
      [alert('COMMUNICATION_MISSING', 'CRITICAL')],
      [{ ...session, scheduled_end_at: '2026-10-20T14:00:00Z' }],
      null,
      [],
      now,
      now,
    ),
    'OUT_OF_HOURS',
  );
});

test('open server inferences distinguish warning, critical, stalled capture and silence', () => {
  assert.equal(
    continuityDisplay([alert('CAPTURE_STALE', 'WARNING')], [session], health, [position], now, now),
    'WARNING',
  );
  assert.equal(
    continuityDisplay([alert('COMMUNICATION_MISSING', 'CRITICAL')], [session], null, [], now, now),
    'CRITICAL',
  );
  assert.match(continuityLabel.CRITICAL, /crítica/);
  assert.match(continuityReason.CAPTURE_STALE, /Posiciones/);
  assert.match(continuityReason.COMMUNICATION_MISSING, /comunicación/);
});

test('resolved alerts do not become active alerts', () => {
  const closed = {
    ...alert('CAPTURE_STALE', 'CRITICAL'),
    status: 'RESOLVED',
  } as RemoteContinuityAlert;
  assert.equal(continuityDisplay([closed], [session], health, [position], now, now), 'NORMAL');
});

test('only an unfiltered discovery 404 means the API lacks the additive route', () => {
  assert.equal(continuityFailure(new ApiClientError(404, 'not_found'), false), 'UNAVAILABLE');
  assert.equal(continuityFailure(new ApiClientError(404, 'not_found'), true), 'ERROR');
  for (const status of [0, 401, 403, 429, 503])
    assert.equal(continuityFailure(new ApiClientError(status, 'failure'), false), 'ERROR');
});
