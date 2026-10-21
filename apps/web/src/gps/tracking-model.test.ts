import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLayers, tileAttribution, tileTemplate } from './map-model.js';
import {
  deviceNames,
  effectiveSession,
  GAP_MS,
  localInputValue,
  presetPeriod,
  routeSegments,
  sortAndDedupe,
  validatePeriod,
  zonedDateTime,
} from './tracking-model.js';
import type { RemoteGpsDevice, RemoteGpsSession, RemotePosition } from './remote.js';

const device = (device_id: string, display_label: string): RemoteGpsDevice => ({
  device_id,
  display_label,
  tenant_id: 'synthetic',
  installation_id: null,
  assignment_version: 0,
});
const position = (
  event_id: string,
  minute: number,
  session_id = 'session-a',
  accuracy_m = 12,
): RemotePosition => ({
  event_id,
  session_id,
  captured_at: new Date(Date.UTC(2026, 9, 20, 15, minute)).toISOString(),
  received_at: new Date(Date.UTC(2026, 9, 20, 15, minute + 1)).toISOString(),
  latitude: 9.9 + minute / 1000,
  longitude: -84.1 + minute / 1000,
  accuracy_m,
});

test('duplicate device names get stable short suffixes and unnamed records remain distinct', () => {
  const labels = deviceNames([
    device('11111111-aaaa', 'Android 01'),
    device('22222222-bbbb', 'Android 01'),
    device('33333333-cccc', 'Oficina'),
  ]);
  assert.equal(labels.get('11111111-aaaa'), 'Android 01 · 11aaaa');
  assert.equal(labels.get('22222222-bbbb'), 'Android 01 · 22bbbb');
  assert.equal(labels.get('33333333-cccc'), 'Oficina');
});

test('route keeps chronology, removes duplicate pages and breaks long gaps and session changes', () => {
  const items = [
    position('b', 2),
    position('a', 0),
    position('b', 2),
    position('c', 12),
    position('d', 13, 'session-b'),
  ];
  assert.deepEqual(
    sortAndDedupe(items).map((item) => item.event_id),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    routeSegments(items).map((part) => part.map((item) => item.event_id)),
    [['a', 'b'], ['c'], ['d']],
  );
  const data = mapLayers(items, 'b');
  assert.equal(data.ordered.length, 4);
  assert.deepEqual(
    data.segments.map((part) => part.map((item) => item.event_id)),
    [['a', 'b'], ['c'], ['d']],
  );
  assert.equal(data.gapCount, 2);
  assert.equal(data.selected?.event_id, 'b');
  assert.equal(GAP_MS, 300_000);
});

test('one position, selection and empty map keep accuracy data without a route', () => {
  const data = mapLayers([position('a', 0, 'session-a', 140)], 'a');
  assert.equal(data.selected?.accuracy_m, 140);
  assert.equal(data.latest?.event_id, 'a');
  assert.equal(data.segments.length, 1);
  assert.equal(data.segments[0]?.length, 1);
  assert.equal(mapLayers([], null).selected, null);
  assert.equal(mapLayers([], null).segments.length, 0);
});

test('tile gate defaults to PoC OpenStreetMap and rejects unapproved sources', () => {
  assert.equal(tileTemplate('/maps/tiles/{z}/{x}/{y}.png'), '/maps/tiles/{z}/{x}/{y}.png');
  const osm = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  assert.equal(tileTemplate(undefined), osm);
  assert.equal(tileTemplate(osm), osm);
  assert.match(tileAttribution(), /OpenStreetMap contributors/);
  assert.equal(tileTemplate('http://tile.openstreetmap.org/{z}/{x}/{y}.png'), null);
  assert.equal(tileTemplate('https://tiles.example.com/{z}/{x}/{y}.png'), null);
  assert.equal(tileTemplate('//tiles.example/{z}/{x}/{y}.png'), null);
  assert.equal(tileTemplate('/maps/{z}/{x}/{y}.png?key=private'), null);
  assert.equal(tileTemplate('/maps/../outside/{z}/{x}/{y}.png'), null);
  assert.equal(tileTemplate('/maps/{z}/{x}.png'), null);
});

test('quick periods use Costa Rica midnight, UTC and exclusive upper bounds', () => {
  const now = new Date('2026-10-20T15:30:00.000Z');
  assert.deepEqual(presetPeriod('today', 'America/Costa_Rica', now), {
    from: '2026-10-20T06:00:00.000Z',
    to: '2026-10-20T15:30:00.001Z',
  });
  assert.deepEqual(presetPeriod('yesterday', 'America/Costa_Rica', now), {
    from: '2026-10-19T06:00:00.000Z',
    to: '2026-10-20T06:00:00.000Z',
  });
  assert.equal(presetPeriod('hour', 'UTC', now).from, '2026-10-20T14:30:00.000Z');
  assert.equal(presetPeriod('now', 'UTC', now).from, '2026-10-20T15:15:00.000Z');
  assert.equal(localInputValue(now, 'America/Costa_Rica'), '2026-10-20T09:30');
  assert.equal(
    zonedDateTime('2026-10-20T09:30', 'America/Costa_Rica').toISOString(),
    now.toISOString(),
  );
  assert.equal(zonedDateTime('2026-10-20T09:30', 'UTC').toISOString(), '2026-10-20T09:30:00.000Z');
});

test('24-hour contract rejects wider custom periods and invalid order', () => {
  assert.equal(validatePeriod({ from: '2026-10-19T00:00:00Z', to: '2026-10-20T00:00:00Z' }), null);
  assert.match(
    validatePeriod({ from: '2026-10-19T00:00:00Z', to: '2026-10-20T00:00:00.001Z' }) ?? '',
    /24 horas/,
  );
  assert.match(
    validatePeriod({ from: '2026-10-20T00:00:00Z', to: '2026-10-19T00:00:00Z' }) ?? '',
    /inicio/,
  );
  assert.throws(() => zonedDateTime('2026-03-08T02:30', 'America/New_York'), /no existe/);
});

test('device change clears a selected session before the next location request', () => {
  const sessions = [{ session_id: 'session-a' }] as RemoteGpsSession[];
  assert.equal(effectiveSession('session-a', sessions, false), 'session-a');
  assert.equal(effectiveSession('session-a', sessions, true), '');
  assert.equal(effectiveSession('session-b', sessions, false), '');
});
