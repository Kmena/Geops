import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferContinuity } from '../src/gps-continuity-monitor.ts';

const at = (minute) => new Date(Date.UTC(2026, 9, 20, 12, minute));
const window = (overrides = {}) => ({
  start_at: at(0),
  end_at: at(60),
  changed_at: at(0),
  warning_after_s: 300,
  critical_after_s: 600,
  start_grace_s: 300,
  policy_grace_s: 300,
  ...overrides,
});
const empty = () => ({
  last_position_captured_at: null,
  last_position_received_at: null,
  last_health_observed_at: null,
  last_health_received_at: null,
  observed_tracking_state: null,
  last_session_received_at: null,
  last_config_fetched_at: null,
  last_batch_persisted_at: null,
});

test('grace and exact window boundaries never alert outside authorized time', () => {
  assert.equal(inferContinuity(at(4), window(), empty()), null);
  assert.equal(inferContinuity(at(60), window(), empty()), null);
  assert.equal(inferContinuity(at(65), window(), empty()), null);
  assert.equal(inferContinuity(at(5), window(), empty())?.severity, 'WARNING');
  assert.equal(inferContinuity(at(10), window(), empty())?.severity, 'CRITICAL');
});

test('fresh capture and communication remain healthy', () => {
  const evidence = {
    ...empty(),
    last_position_captured_at: at(8),
    last_position_received_at: at(8),
    last_health_observed_at: at(8),
    last_health_received_at: at(8),
  };
  assert.equal(inferContinuity(at(11), window(), evidence), null);
});

test('telemetry arriving without captures is capture stale, not communication missing', () => {
  const evidence = {
    ...empty(),
    last_health_observed_at: at(9),
    last_health_received_at: at(9),
    observed_tracking_state: 'RUNNING',
  };
  assert.deepEqual(inferContinuity(at(11), window(), evidence), {
    reason_code: 'CAPTURE_STALE',
    severity: 'CRITICAL',
    evidence_at: null,
    age_s: 660,
    threshold_s: 600,
  });
});

test('late upload proves communication, not current capture', () => {
  const evidence = {
    ...empty(),
    last_position_captured_at: at(1),
    last_position_received_at: at(11),
  };
  assert.equal(inferContinuity(at(11), window(), evidence)?.reason_code, 'CAPTURE_STALE');
});

test('no communication is an inference without guessed cause', () => {
  const evidence = {
    ...empty(),
    last_health_observed_at: at(1),
    last_health_received_at: at(1),
    observed_tracking_state: 'STOPPED',
  };
  const decision = inferContinuity(at(11), window(), evidence);
  assert.equal(decision?.reason_code, 'COMMUNICATION_MISSING');
  assert.equal(decision?.evidence_at?.toISOString(), at(1).toISOString());
  assert.equal(decision?.severity, 'CRITICAL');
});

test('a policy change starts a new grace period', () => {
  assert.equal(inferContinuity(at(12), window({ changed_at: at(10) }), empty()), null);
  assert.equal(
    inferContinuity(at(15), window({ changed_at: at(10) }), empty())?.severity,
    'CRITICAL',
  );
});

test('server batch persistence does not masquerade as client ACK or communication', () => {
  const evidence = { ...empty(), last_batch_persisted_at: at(11) };
  assert.equal(inferContinuity(at(11), window(), evidence)?.reason_code, 'COMMUNICATION_MISSING');
});
