import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyze, classifyEdge } from './analyze.mjs';
import { csvCells, csvRow } from './common.mjs';
import { options } from './extract.mjs';

const base = Date.parse('2026-10-17T12:00:00Z');
function point(
  minute,
  latitude = 14.6,
  longitude = -90.5,
  accuracy_m = 5,
  receiptDelaySeconds = 3,
  device = 'device_001',
) {
  const at = base + minute * 60_000;
  return {
    device,
    captured_at: new Date(at).toISOString(),
    received_at: new Date(at + receiptDelaySeconds * 1000).toISOString(),
    latitude,
    longitude,
    accuracy_m,
  };
}

test('local PoC schema contains only the columns used by analysis', async () => {
  const sql = await readFile(new URL('../api/schema.sql', import.meta.url), 'utf8');
  for (const expected of [
    'poc_location',
    'poc_device',
    'device_id uuid',
    'event_id uuid',
    'captured_at timestamptz',
    'received_at timestamptz',
    'geom geography(Point,4326)',
    'accuracy_m double precision',
  ])
    assert.ok(sql.includes(expected), expected);
  assert.ok(!sql.includes('poc_session'));
});

test('gap separates inferred sessions and excludes inter-session pause from cadence', () => {
  const result = analyze([point(0), point(1), point(2), point(13), point(14)]);
  assert.equal(result.aggregate.sessions, 2);
  assert.equal(result.aggregate.total_within_session_intervals, 3);
  assert.equal(result.aggregate.within_target_percent, 100);
  assert.ok(result.sessions.every((s) => s.boundary === 'inferred_from_capture_gap'));
});

test('exactly ten minutes remains one session; devices never join', () => {
  const result = analyze([point(0), point(10), point(0, 14.6, -90.5, 5, 3, 'device_002')]);
  assert.equal(result.aggregate.sessions, 2);
  assert.equal(result.aggregate.total_within_session_intervals, 1);
  assert.equal(result.sessions[0].interval_seconds.max_seconds, 600);
});

test('network delay does not imply missing capture; long in-session pause stays uncertain', () => {
  const result = analyze([point(0), point(1, 14.6, -90.5, 5, 601), point(5)]);
  assert.equal(result.aggregate.sessions, 1);
  assert.equal(result.sessions[0].late_sync_count, 1);
  assert.equal(result.sessions[0].long_capture_gaps, 1);
  assert.equal(result.sessions[0].edge_counts.uncertain, 1);
  assert.equal(result.sessions[0].intervals_beyond_target_tolerance, 1);
  assert.equal(result.sessions[0].capture_gaps[0].seconds, 240);
});

test('repeated coordinates with new timestamps are stationary, exact duplicates are counted', () => {
  const result = analyze([point(0), point(1), point(1)]);
  assert.equal(result.sessions[0].edge_counts.stationary, 1);
  assert.equal(result.sessions[0].exact_coordinate_time_duplicates, 1);
  assert.equal(result.sessions[0].interval_seconds.max_seconds, 60);
});

test('large geographic jump is excluded from estimated traveled distance', () => {
  const result = analyze([point(0), point(1, 15.6)]);
  assert.equal(result.sessions[0].suspicious_gps_jumps, 1);
  assert.equal(result.sessions[0].estimated_moving_centerline_m, 0);
});

test('receipt order inversion and negative latency are reported separately', () => {
  const result = analyze([
    point(0, 14.6, -90.5, 5, 130),
    point(1, 14.6, -90.5, 5, 3),
    point(2, 14.6, -90.5, 5, -10),
  ]);
  assert.equal(result.sessions[0].out_of_order_received_pairs, 1);
  assert.equal(result.sessions[0].negative_latency_clock_skew_count, 1);
});

test('accuracy and sparse sampling make displacement uncertain', () => {
  const a = point(0, 14.6, -90.5, 100),
    b = point(1, 14.6005, -90.5, 100);
  assert.equal(classifyEdge(a, b, analyze([a, b]).config).kind, 'stationary');
  const result = analyze([point(0), point(9, 14.61)]);
  assert.equal(result.sessions[0].edge_counts.uncertain, 1);
  assert.equal(result.sessions[0].estimated_moving_centerline_m, 0);
});

test('CSV escaping and strict range validation', () => {
  assert.deepEqual(csvCells(csvRow(['a"b', 'c,d']).trim()), ['a"b', 'c,d']);
  assert.throws(() => options(['--from', '2026-10-17T00:00:00Z', '--to', '2026-10-17T00:00:00Z']));
  assert.throws(() =>
    options(['--from', '2026-10-17T00:00:00+01:00', '--to', '2026-10-18T00:00:00Z']),
  );
  assert.throws(() =>
    options(['--from', '2026-10-17T00:00:00Z', '--to', '2026-10-18T00:00:00Z', '--device', 'bad']),
  );
});
