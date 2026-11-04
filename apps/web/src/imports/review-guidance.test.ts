import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canBulkSelect,
  candidateDistance,
  candidateKind,
  confidenceName,
  decisionOptions,
  finding,
  firstFinding,
  groupCandidates,
  signalName,
  suggestedDistinctCodes,
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
  assert.equal(signalName('CUSTOMER_CODE'), 'Mismo código de un cliente');
  assert.equal(
    finding('possible_duplicate_customer').title,
    'Ya existe un cliente con el mismo nombre o código',
  );
});

test('comparison separates GEOPS clients from code-only KMZ collisions and offers distinct codes', () => {
  const candidate = (target_type: string, target_code: string | null, signals: string[]) =>
    ({ target_type, target_code, signals }) as Candidate;
  const items = [
    candidate('CUSTOMER', 'C-15', ['CUSTOMER_NAME']),
    candidate('STAGING_RECORD', '16', ['IN_FILE_CODE']),
    candidate('STAGING_RECORD', '16-A', ['IN_FILE_PROXIMITY']),
    candidate('STAGING_RECORD', '17', ['IN_FILE_PROXIMITY']),
  ];
  const grouped = groupCandidates(items);
  assert.equal(grouped.geops.length, 1);
  assert.equal(grouped.codeOnly.length, 1);
  assert.equal(grouped.otherKmz.length, 2);
  assert.deepEqual(suggestedDistinctCodes('16', items), ['16-B', '16-C']);
  assert.deepEqual(
    suggestedDistinctCodes(
      '16',
      items.filter((item) => item.target_code !== '16'),
    ),
    [],
  );
  assert.deepEqual(suggestedDistinctCodes('código inválido', items), []);
  assert.equal(candidateDistance(190_432), '190,4 km');
  assert.equal(candidateDistance(48), '48 m');
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
