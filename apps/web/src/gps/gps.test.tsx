import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer, type ViteDevServer } from 'vite';
import {
  devices,
  historicalExperiment,
  policies,
  sessions,
  type PolicyFixture,
} from './fixtures.js';
import {
  assignedDevices,
  assignmentConflicts,
  can,
  validIanaZone,
  validateDraft,
} from './model.js';

let vite: ViteDevServer;
let Workspace: typeof import('./GpsWorkspace.js').GpsWorkspace;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  ({ GpsWorkspace: Workspace } = await vite.ssrLoadModule('/src/gps/GpsWorkspace.tsx'));
});

after(async () => {
  await vite?.close();
});

function screen(section: 'policies' | 'devices' | 'sessions' | 'executive') {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [`/gps/${section}`] },
      createElement(Workspace, { section, initialMode: 'preview' }),
    ),
  );
}

function policy(index: number): PolicyFixture {
  const value = policies[index];
  assert.ok(value);
  return value;
}

test('fixtures are synthetic and preserve the historical aggregate', () => {
  assert.equal(historicalExperiment.positions, 543);
  assert.equal(historicalExperiment.inferredSessions, 4);
  assert.equal(historicalExperiment.cadenceWithinTolerance, '81.82%');
  assert.equal(historicalExperiment.lateSyncs, 84);
  assert.ok(devices.every((device) => device.id.startsWith('SYN-')));
  assert.ok(sessions.every((session) => session.id.startsWith('SES-SYN-')));
});

test('assignment conflict expands groups and ignores different validity periods', () => {
  const draft = { ...policy(1), id: 'NEW', deviceIds: ['SYN-01'], groupIds: [] };
  assert.deepEqual(assignedDevices(policy(0)), ['SYN-01', 'SYN-02']);
  assert.deepEqual(assignmentConflicts(draft, policies), ['SYN-01']);
  assert.deepEqual(
    assignmentConflicts(
      { ...draft, validFrom: '2027-01-01T00:00', validUntil: '2027-02-01T00:00' },
      policies,
    ),
    [],
  );
});

test('draft validates contract bounds, schedule, validity and IANA zone', () => {
  assert.deepEqual(validateDraft(policy(0)), []);
  assert.equal(validIanaZone('America/Guatemala'), true);
  assert.equal(validIanaZone('Etc/GMT+1'), true);
  assert.equal(validIanaZone('Bogus/Invalid'), false);
  const bad = {
    ...policy(0),
    daysIso: [],
    startLocal: '08:00',
    endLocal: '08:00',
    timeZone: 'Bogus/Invalid',
    captureIntervalS: 29,
    syncIntervalS: 901,
    healthIntervalS: 59,
    heartbeatMissingAfterS: 7201,
    validFrom: '2027-02-01T00:00',
    validUntil: '2027-01-01T00:00',
  };
  assert.equal(validateDraft(bad).length, 8);
});

test('capabilities deny by default', () => {
  assert.equal(can([], 'gps.policy.write'), false);
  assert.equal(can(['gps.policy.read'], 'gps.policy.write'), false);
  assert.equal(can(['gps.policy.read'], 'gps.policy.read'), true);
});

test('four navigation targets and synthetic warning render', () => {
  const html = screen('policies');
  for (const target of ['policies', 'devices', 'sessions', 'executive'])
    assert.match(html, new RegExp(`/gps/${target}`));
  assert.match(html, /W1-D · datos sintéticos/);
  assert.match(html, /Publicada/);
  assert.match(html, /Historial de versiones/);
  assert.doesNotMatch(html, /-90\.\d{4,}/);
});

test('device and session screens distinguish evidence and unconfirmed starts', () => {
  const deviceHtml = screen('devices');
  assert.match(deviceHtml, /SYN-01/);
  assert.match(deviceHtml, /Versión/iu);
  const sessionHtml = screen('sessions');
  assert.match(sessionHtml, /Inicio fallido/);
  assert.match(sessionHtml, /No confirmado/);
  assert.match(sessionHtml, /Sin evento de fin/);
});

test('executive screen keeps historical inference separate from readiness', () => {
  const html = screen('executive');
  assert.match(html, /25/);
  assert.match(html, /0/);
  assert.match(html, /543/);
  assert.match(html, /81\.82%/);
  assert.match(html, /inferidas/);
  assert.match(html, /W1-E pendiente/);
});
