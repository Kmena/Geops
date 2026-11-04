import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canBulkSelect,
  candidateKind,
  confidenceName,
  decisionOptions,
  finding,
  firstFinding,
  signalName,
} from './review-guidance.js';
import type { Candidate, ReviewRow } from './api.js';

test('invalid weekly stop explains the parser finding before matcher warnings', () => {
  const row = {
    review_state: 'INVALID',
    parse_errors: ['INVALID_COORDINATE'],
    conflicts: ['MULTIPLE_CUSTOMER_CANDIDATES'],
    warnings: ['UNLINKED_STOP'],
  } as ReviewRow;
  assert.equal(firstFinding(row), 'Las coordenadas no son válidas');
  assert.match(finding('INVALID_COORDINATE').next, /nueva revisión/);
});

test('duplicate evidence identifies the actual matched record type and reason', () => {
  const candidate = { target_type: 'STAGING_RECORD' } as Candidate;
  assert.equal(candidateKind(candidate), 'Otro registro del KMZ');
  assert.equal(confidenceName('POSSIBLE'), 'Posible coincidencia');
  assert.equal(signalName('IN_FILE_CODE'), 'Mismo código en este KMZ');
});

test('weekly stop can link or reject, while an invalid point cannot be accepted', () => {
  const stop = { record_type: 'WEEKLY_STOP', source_kind: 'WEEKLY_STOP', review_state: 'NEW' };
  assert.deepEqual(
    decisionOptions(stop).map(([action]) => action),
    ['LINK', 'UPDATE', 'EXCLUDE', 'PENDING'],
  );
  assert.deepEqual(
    decisionOptions({ ...stop, review_state: 'INVALID' }).map(([action]) => action),
    ['EXCLUDE', 'PENDING'],
  );
});

test('bulk selection offers creation only for undecided new customer points', () => {
  const point = {
    record_type: 'CLIENT_CANDIDATE',
    review_state: 'NEW',
    action: null,
    normalized: { name: 'Cliente nuevo', point: { latitude: 9.9, longitude: -84.1 } },
  } as ReviewRow;
  assert.equal(canBulkSelect(point, 'CREATE'), true);
  assert.equal(canBulkSelect({ ...point, review_state: 'POSSIBLE_DUPLICATE' }, 'CREATE'), false);
  assert.equal(canBulkSelect({ ...point, record_type: 'GEOGRAPHIC_GROUP' }, 'CREATE'), false);
  assert.equal(canBulkSelect({ ...point, action: 'CREATE' }, 'CREATE'), false);
  assert.equal(canBulkSelect({ ...point, review_state: 'CONFLICT' }, 'EXCLUDE'), false);
});
