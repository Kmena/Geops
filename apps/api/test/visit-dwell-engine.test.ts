import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDwellSample,
  evaluateDwell,
  uniquePhysicalSeconds,
  validateDwellParameters,
  type DwellSample,
} from '../src/visit-dwell-engine.js';

const parameters = validateDwellParameters({
  max_gap_s: 300,
  credit_cap_s: 300,
  uncertainty_guard_s: 0,
  max_accuracy_m: 25,
  boundary_tolerance_m: 0,
  max_speed_m_s: 50,
});
const at = (minutes: number) =>
  new Date(Date.parse('2027-01-04T08:00:00Z') + minutes * 60_000).toISOString();
const sample = (minutes: number, id: string, distanceM = 0, accuracyM = 5): DwellSample => ({
  deviceId: 'device-a',
  eventId: id,
  sessionId: 'session-a',
  linkId: 'link-a',
  captureAnchorId: 'anchor-a',
  bootId: 'boot-a',
  capturedAt: at(minutes),
  receivedAt: at(minutes + 1),
  payloadDigest: id,
  accuracyM,
  distanceM,
  moveDistanceM: 0,
  qualityState: 'DEVICE_REPORTED',
});
const run = (samples: DwellSample[], requiredS = 600, endsAt = at(60), barriers: string[] = []) =>
  evaluateDwell({
    samples,
    barriers,
    radiusM: 100,
    requiredS,
    startsAt: at(0),
    endsAt,
    now: at(120),
    parameters,
  });

test('geodesic distance and accuracy classification is conservative at the edge', () => {
  assert.equal(classifyDwellSample(sample(0, 'a', 94, 5), 100, parameters), 'INSIDE');
  assert.equal(classifyDwellSample(sample(0, 'a', 95, 5), 100, parameters), 'INSIDE');
  assert.equal(classifyDwellSample(sample(0, 'a', 100, 5), 100, parameters), 'UNCERTAIN');
  assert.equal(classifyDwellSample(sample(0, 'a', 106, 5), 100, parameters), 'OUTSIDE');
  assert.equal(classifyDwellSample(sample(0, 'a', 0, 30), 100, parameters), 'UNCERTAIN');
  assert.equal(classifyDwellSample(sample(0, 'a', 0, NaN), 100, parameters), 'UNCERTAIN');
});
test('three observed visits accumulate 4 + 3 + 5 minutes without carrying gaps', () => {
  const result = run([
    sample(0, 'a'),
    sample(4, 'b'),
    sample(5, 'outside', 200),
    sample(10, 'c'),
    sample(13, 'd'),
    sample(14, 'outside2', 200),
    sample(20, 'e'),
    sample(25, 'f'),
  ]);
  assert.equal(result.creditedS, 720);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.percent, 100);
  assert.equal(result.intervals.length, 3);
  assert.equal(result.completedAt, at(23));
});
test('isolated sample, uncertain edge and long gap cannot manufacture dwell', () => {
  assert.equal(run([sample(0, 'a')]).creditedS, 0);
  assert.equal(run([sample(0, 'a'), sample(10, 'b')]).creditedS, 0);
  assert.equal(run([sample(0, 'a'), sample(1, 'edge', 100), sample(2, 'b')]).creditedS, 0);
  assert.equal(run([sample(0, 'a'), sample(4, 'b', 0, 30)]).status, 'INSUFFICIENT_EVIDENCE');
});
test('duplicates and out-of-order delivery produce identical result', () => {
  const events: [DwellSample, DwellSample, DwellSample] = [
    sample(0, 'a'),
    sample(4, 'b'),
    sample(7, 'c'),
  ];
  const expected = run(events, 300);
  const replay = run([events[2], events[0], events[1], events[1]], 300);
  assert.deepEqual(replay, expected);
});
test('work window, session and identity barriers clip physical evidence', () => {
  assert.equal(
    run([sample(-1, 'before'), sample(0, 'a'), sample(4, 'b'), sample(61, 'after')]).creditedS,
    240,
  );
  assert.equal(run([sample(0, 'a'), sample(4, 'b')], 600, at(3)).creditedS, 0);
  assert.equal(run([sample(0, 'a'), sample(4, 'b')], 600, at(60), [at(2)]).creditedS, 0);
  assert.equal(run([sample(0, 'a'), { ...sample(4, 'b'), linkId: 'link-b' }]).creditedS, 0);
  assert.equal(run([sample(0, 'a'), { ...sample(4, 'b'), sessionId: 'session-b' }]).creditedS, 0);
});
test('speed and non-overlap protect against implausible and double credited time', () => {
  assert.equal(run([sample(0, 'a'), { ...sample(1, 'b'), moveDistanceM: 4000 }]).creditedS, 0);
  const first = run([sample(0, 'a'), sample(4, 'b')], 100).intervals[0];
  assert.ok(first);
  assert.equal(uniquePhysicalSeconds([first, first]), 240);
  assert.equal(
    uniquePhysicalSeconds([first, { ...first, creditedFromAt: at(2), toAt: at(6) }]),
    360,
  );
});
test('parameter validation rejects unsupported lab configurations', () => {
  assert.throws(() => validateDwellParameters({ ...parameters, max_gap_s: 0 }));
  assert.throws(() => validateDwellParameters({ ...parameters, credit_cap_s: 400 }));
  assert.throws(() => validateDwellParameters({ ...parameters, extra: 1 }));
});
test('the civil-day assignment window does not borrow dwell from another day', () => {
  const dayStart = '2027-01-04T23:55:00Z';
  const following = '2027-01-05T00:10:00Z';
  const inside = [
    { ...sample(0, 'a'), capturedAt: '2027-01-04T23:56:00Z' },
    { ...sample(4, 'b'), capturedAt: '2027-01-05T00:00:00Z' },
    { ...sample(8, 'c'), capturedAt: '2027-01-05T00:04:00Z' },
  ];
  const result = evaluateDwell({
    samples: inside,
    barriers: [],
    radiusM: 100,
    requiredS: 600,
    startsAt: dayStart,
    endsAt: following,
    now: '2027-01-05T02:00:00Z',
    parameters,
  });
  assert.equal(result.creditedS, 480);
  assert.equal(result.status, 'INCOMPLETE');
  const next = evaluateDwell({
    samples: inside,
    barriers: [],
    radiusM: 100,
    requiredS: 600,
    startsAt: following,
    endsAt: '2027-01-05T01:00:00Z',
    now: '2027-01-05T02:00:00Z',
    parameters,
  });
  assert.equal(next.creditedS, 0);
});
test('status changes with the work window without inventing absence', () => {
  const empty = evaluateDwell({
    samples: [],
    barriers: [],
    radiusM: 100,
    requiredS: 600,
    startsAt: at(0),
    endsAt: at(60),
    now: at(-1),
    parameters,
  });
  assert.equal(empty.status, 'PENDING');
  assert.equal(run([]).status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(run([sample(0, 'a'), sample(4, 'b')]).status, 'INCOMPLETE');
  assert.equal(run([sample(0, 'a'), sample(4, 'b')], 100).status, 'COMPLETED');
});
test('boot, anchor, poor quality and same-time samples break pairs', () => {
  assert.equal(run([sample(0, 'a'), { ...sample(4, 'b'), bootId: 'new-boot' }]).creditedS, 0);
  assert.equal(
    run([sample(0, 'a'), { ...sample(4, 'b'), captureAnchorId: 'new-anchor' }]).creditedS,
    0,
  );
  assert.equal(run([sample(0, 'a'), { ...sample(4, 'b'), qualityState: 'UNKNOWN' }]).creditedS, 0);
  assert.equal(run([sample(0, 'a'), sample(0, 'b')]).creditedS, 0);
});
test('a noninteger second is rounded down for conservative persisted credit', () => {
  const later = { ...sample(4, 'b'), capturedAt: new Date(Date.parse(at(4)) + 500).toISOString() };
  const result = run([sample(0, 'a'), later]);
  assert.equal(result.creditedS, 240);
  assert.equal(result.intervals[0]?.observedS, 240);
});
test('small, large and shared circular zones use meters and one physical interval', () => {
  assert.equal(classifyDwellSample(sample(0, 'a', 10, 5), 12, parameters), 'UNCERTAIN');
  assert.equal(classifyDwellSample(sample(0, 'a', 10, 5), 100_000, parameters), 'INSIDE');
  assert.equal(classifyDwellSample(sample(0, 'a', Number.NaN), 100, parameters), 'UNCERTAIN');
  const one = run([sample(0, 'a'), sample(4, 'b')], 100).intervals[0];
  const two = run([sample(0, 'a', 5), sample(4, 'b', 5)], 100).intervals[0];
  assert.ok(one && two);
  assert.equal(one.creditedS + two.creditedS, 480);
  assert.equal(uniquePhysicalSeconds([one, two]), 240);
});
