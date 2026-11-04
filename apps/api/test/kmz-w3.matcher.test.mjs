import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIntraPairs,
  comparisonCode,
  comparisonName,
  DEFAULT_MATCH_CONFIG,
  hasIdentityEvidence,
  normalizedCode,
  normalizedName,
  proximityBand,
  recordType,
  similarName,
} from '../src/kmz/matcher.ts';

const record = (id, name, code, longitude, latitude, sourcePath = id) => ({
  id,
  ordinal: Number(id),
  source_path: sourcePath,
  parent_path: null,
  source_kind: 'CLIENT_POINT',
  week_label: null,
  normalized: { name, code, point: { longitude, latitude } },
  warnings: [],
  errors: [],
});

test('W3 preserves explicit codes and canonicalizes numeric name prefixes', () => {
  assert.equal(normalizedCode(' 001  '), '001');
  assert.notEqual(normalizedCode('001'), normalizedCode('1'));
  assert.equal(normalizedName('  Café   Niño '), 'cafe nino');
  assert.equal(similarName('farmacia central', 'farmacia centrl'), true);
  assert.equal(similarName('farmacia central', 'taller rojo'), false);
  assert.deepEqual(comparisonCode(record('1', '001 - Café Niño', null, -84.1, 9.9)), {
    value: '1',
    source: 'NAME_PREFIX',
  });
  assert.equal(comparisonName('001 - Café Niño'), 'cafe nino');
  assert.deepEqual(comparisonCode(record('1', '(042) - San Rafael', null, -84.1, 9.9)), {
    value: '42',
    source: 'NAME_PREFIX',
  });
  assert.equal(comparisonName('(042) - San Rafael'), 'san rafael');
  const parsed = record('1', 'FARMACIA GIRASOL', '3997', -84.1, 9.9);
  parsed.normalized.code_source = 'NAME_PREFIX';
  assert.deepEqual(comparisonCode(parsed), { value: '3997', source: 'NAME_PREFIX' });
});

test('W3 D-02 bands include exactly 50 and 250 metres', () => {
  assert.equal(proximityBand(0, DEFAULT_MATCH_CONFIG), 'HIGH');
  assert.equal(proximityBand(40, DEFAULT_MATCH_CONFIG), 'HIGH');
  assert.equal(proximityBand(50, DEFAULT_MATCH_CONFIG), 'HIGH');
  assert.equal(proximityBand(50.000001, DEFAULT_MATCH_CONFIG), 'EXTENDED');
  assert.equal(proximityBand(200, DEFAULT_MATCH_CONFIG), 'EXTENDED');
  assert.equal(proximityBand(250, DEFAULT_MATCH_CONFIG), 'EXTENDED');
  assert.equal(proximityBand(250.000001, DEFAULT_MATCH_CONFIG), null);
  assert.equal(proximityBand(40, { highMeters: 20, extendedMeters: 80 }), 'EXTENDED');
});

test('W3 classification keeps weekly, group, polygon and line distinct', () => {
  assert.equal(recordType('CLIENT_POINT', []), 'CLIENT_CANDIDATE');
  assert.equal(recordType('BRANCH_POINT', []), 'REFERENCE_POINT');
  assert.equal(recordType('WEEKLY_STOP', []), 'WEEKLY_STOP');
  assert.equal(recordType('TERRITORY_GROUP', []), 'GEOGRAPHIC_GROUP');
  assert.equal(recordType('GEO_FEATURE', []), 'POLYGON');
  assert.equal(recordType('ROUTE_LINE', []), 'LINE');
  assert.equal(recordType('GEO_FEATURE', ['INVALID_TOPOLOGY']), 'INVALID_OR_OTHER');
});

test('W3 detects repeated codes and nearby distinct names without equating identity', () => {
  const rows = [
    record('1', 'Empresa A', '0007', -84.1, 9.9, '/Heredia/1'),
    record('2', 'Empresa B', '0007', -84.2, 9.9, '/Heredia/2'),
    record('3', 'Empresa C', '0008', -84.1, 9.9, '/Otra/3'),
  ];
  const result = buildIntraPairs(rows, 250);
  assert.equal(result.warnings.get('1')?.has('DUPLICATE_CODE'), true);
  assert.equal(result.warnings.get('2')?.has('DUPLICATE_CODE'), true);
  assert.equal(
    result.pairs.some((pair) => pair.rules.includes('IN_FILE_CODE')),
    true,
  );
  assert.equal(
    result.pairs.some((pair) => pair.rules.includes('IN_FILE_PROXIMITY')),
    true,
  );
  assert.equal(
    result.pairs
      .filter((pair) => pair.rules.includes('IN_FILE_CODE'))
      .every((pair) =>
        hasIdentityEvidence({
          target_type: 'STAGING_RECORD',
          distance_m: null,
          signals: pair.rules,
        }),
      ),
    true,
  );
});

test('nearby businesses with different names and codes are context, not duplicate evidence', () => {
  const rows = [
    record('1', 'MACROBIOTICA LA CASITA VERDE', '5056', -84.0756338, 9.9341756),
    record('2', 'CORPORACION RUBEN HJ S.A.', '3034', -84.0752, 9.9342),
  ];
  const pair = buildIntraPairs(rows, 250).pairs[0];
  assert.ok(pair);
  assert.deepEqual(pair.rules, ['IN_FILE_PROXIMITY']);
  assert.equal(
    hasIdentityEvidence({ target_type: 'STAGING_RECORD', distance_m: 48, signals: pair.rules }),
    false,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'ESTABLISHMENT',
      distance_m: 48,
      signals: ['ESTABLISHMENT_SPATIAL', 'PROXIMITY_HIGH'],
    }),
    false,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'CUSTOMER',
      distance_m: 48,
      signals: ['LINKED_CUSTOMER', 'PROXIMITY_HIGH'],
    }),
    false,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'CUSTOMER',
      distance_m: 48,
      signals: ['LINKED_CUSTOMER', 'NAME_NORMALIZED_EXACT', 'PROXIMITY_HIGH'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'STAGING_RECORD',
      distance_m: 48,
      signals: ['IN_FILE_CODE'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'STAGING_RECORD',
      distance_m: 48,
      signals: ['IN_FILE_NAME'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'STAGING_RECORD',
      distance_m: 48,
      signals: ['IN_FILE_SIMILAR_NAME'],
    }),
    false,
  );
  assert.equal(
    hasIdentityEvidence({ target_type: 'STAGING_RECORD', distance_m: 0, signals: pair.rules }),
    false,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'STAGING_RECORD',
      distance_m: 0,
      signals: ['IN_FILE_CODE', 'IN_FILE_NAME', 'IN_FILE_PROXIMITY'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'ESTABLISHMENT',
      distance_m: 48,
      signals: ['NAME_NORMALIZED_EXACT', 'SOURCE_KEY_EXACT_NON_AUTHORITATIVE'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'ESTABLISHMENT',
      distance_m: 48,
      signals: ['NAME_SIMILAR', 'SOURCE_KEY_EXACT_NON_AUTHORITATIVE'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'ESTABLISHMENT',
      distance_m: 48,
      signals: ['NAME_NORMALIZED_EXACT'],
    }),
    true,
  );
  assert.equal(
    hasIdentityEvidence({
      target_type: 'ESTABLISHMENT',
      distance_m: 48,
      signals: ['NAME_SIMILAR', 'PROXIMITY_HIGH'],
    }),
    false,
  );
});
