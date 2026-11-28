import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DiagnosticValidationError,
  diagnosticDigest,
  parseDiagnostic,
} from '../src/device-diagnostics-contract.js';
import { evaluateDiagnostic } from '../src/device-diagnostics-rules.js';

const now = new Date('2026-11-27T12:00:00.000Z');
const fixture = () => ({
  schema_version: 1,
  installation_id: randomUUID(),
  boot_id: randomUUID(),
  sequence: 1,
  observed_at: now.toISOString(),
  app_version: '1.0.2-spec05-wave2',
  manufacturer: 'Motorola',
  model: 'moto g06',
  android_release: '15',
  android_api: 35,
  permissions: {
    fine: 'GRANTED',
    coarse: 'GRANTED',
    background: 'GRANTED',
    notifications: 'GRANTED',
  },
  execution: {
    location_enabled: true,
    gps_provider_enabled: true,
    battery_exempt: true,
    power_save: false,
    background_restricted: false,
    data_saver: 'DISABLED',
    internet: 'VALIDATED',
  },
  gps: {
    service: 'RUNNING_OBSERVED',
    last_callback_at: now.toISOString(),
    last_capture_at: now.toISOString(),
    last_ack_at: now.toISOString(),
    pending_positions: 0,
    upload_auth_blocked: false,
    capture_interval_s: 60,
    sync_interval_s: 60,
    policy_revision: 2,
    tracking_mode: 'CONTINUOUS',
  },
  errors: [],
});
const parse = (value: unknown) => parseDiagnostic(value, Buffer.byteLength(JSON.stringify(value)));

test('strict contract preserves typed Android evidence and stable digest', () => {
  const sample = parse(fixture());
  assert.equal(sample.permissions.background, 'GRANTED');
  assert.equal(diagnosticDigest(sample), diagnosticDigest(parse(sample)));
  assert.deepEqual(evaluateDiagnostic(sample, now, now), []);
});

test('rejects unknown keys, identity injection, oversized and free-form errors', () => {
  const sample = fixture();
  assert.throws(() => parse({ ...sample, device_id: randomUUID() }), DiagnosticValidationError);
  assert.throws(() => parse({ ...sample, coordinates: [1, 2] }), DiagnosticValidationError);
  assert.throws(
    () => parse({ ...sample, errors: [{ code: 'TOKEN=secret', observed_at: now.toISOString() }] }),
    DiagnosticValidationError,
  );
  assert.throws(() => parseDiagnostic(sample, 16_385), DiagnosticValidationError);
  assert.throws(() => parse({ ...sample, schema_version: 2 }), DiagnosticValidationError);
});

test('separates confirmed permissions, capture and transmission problems', () => {
  const sample = fixture();
  sample.permissions.background = 'DENIED';
  sample.gps.last_capture_at = new Date(now.getTime() - 10 * 60_000).toISOString();
  sample.gps.last_ack_at = new Date(now.getTime() - 20 * 60_000).toISOString();
  sample.gps.pending_positions = 30;
  const codes = evaluateDiagnostic(parse(sample), now, now).map((f) => f.code);
  assert.ok(codes.includes('GPS_BACKGROUND_PERMISSION_MISSING'));
  assert.ok(codes.includes('GPS_CAPTURE_STALE'));
  assert.ok(codes.includes('GPS_TRANSMISSION_STALE'));
  assert.ok(codes.includes('SYNC_QUEUE_BACKLOG'));
});

test('offline and stale reports do not imply stopped GPS', () => {
  assert.deepEqual(
    evaluateDiagnostic(null, null, now).map((f) => f.code),
    ['GPS_SERVICE_STATE_UNKNOWN'],
  );
  const sample = parse(fixture());
  const received = new Date(now.getTime() - 20 * 60_000);
  const activeGps = evaluateDiagnostic(sample, received, now, now);
  assert.deepEqual(
    activeGps.map((f) => f.code),
    ['DIAGNOSTIC_STALE'],
  );
  const old = evaluateDiagnostic(sample, received, now, received);
  assert.deepEqual(
    old.map((f) => f.code),
    ['DEVICE_OFFLINE', 'DIAGNOSTIC_STALE'],
  );
  assert.ok(!old.some((f) => f.code === 'GPS_SERVICE_NOT_RUNNING'));
});

test('ownership and explicit minimum version expose configuration drift', () => {
  const sample = fixture();
  sample.gps.tracking_mode = 'WORK_WINDOW';
  const findings = evaluateDiagnostic(parse(sample), now, now, now, {
    ownership: 'CORPORATE_MANAGED',
    minimumAppVersion: '1.0.3',
  });
  assert.ok(findings.some((item) => item.code === 'CONFIGURATION_INCOMPATIBLE'));
  assert.ok(findings.some((item) => item.code === 'APP_VERSION_OUTDATED'));
  assert.ok(
    !evaluateDiagnostic(parse(sample), now, now, now).some(
      (item) => item.code === 'APP_VERSION_OUTDATED',
    ),
  );
});
