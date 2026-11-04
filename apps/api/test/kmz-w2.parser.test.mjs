import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { parseKmz } from '../src/kmz/parser.ts';
import { isRouteCandidate, recordType } from '../src/kmz/matcher.ts';

function archive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const source = Buffer.from(item.data ?? '');
    const method = item.method ?? 0;
    const body = method === 8 ? deflateRawSync(source) : source;
    const crc = item.badCrc ? 0 : crc32(source);
    const flags = item.flags ?? 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(source.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x031e, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(source.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(item.externalAttributes ?? 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + body.length;
  }
  const center = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(center.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, center, end]);
}

async function withArchive(entries, run) {
  const dir = await mkdtemp(join(tmpdir(), 'geops-w2-test-'));
  const path = join(dir, `${randomUUID()}.kmz`);
  try {
    await writeFile(path, archive(entries));
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const xml = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2">${body}</kml>`;

test('W2 extracts nested groups, candidate stops and all basic geometries', async () => {
  const kml = xml(
    '<Document><name>Demo</name><Folder><name>Clientes</name>' +
      '<Placemark><name>Uno</name><ExtendedData><Data name="codigo"><value>001</value></Data></ExtendedData><Point><coordinates>-84.1,9.9,0</coordinates></Point></Placemark>' +
      '<Placemark><name>Dos</name><ExtendedData><SimpleData name="code">001</SimpleData></ExtendedData><Point><coordinates>-84.2,9.8</coordinates></Point></Placemark>' +
      '<Folder><name>SEMANA 1</name><Placemark><name>Parada</name><Point><coordinates>-84.1,9.9</coordinates></Point></Placemark></Folder>' +
      '<Placemark><name>Polígono</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-84,9 -84.1,9 -84.1,9.1 -84,9</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>' +
      '<Placemark><name>Línea</name><LineString><coordinates>-84,9 -84.1,9.1</coordinates></LineString></Placemark>' +
      '</Folder></Document>',
  );
  const result = await withArchive([{ name: 'doc.kml', data: kml }], parseKmz);
  assert.equal(result.summary.placemarks, 5);
  assert.equal(result.summary.CLIENT_POINT, 2);
  assert.equal(result.summary.WEEKLY_STOP, 1);
  assert.equal(result.summary.GEO_FEATURE, 1);
  assert.equal(result.summary.ROUTE_LINE, 1);
  assert.equal(result.records.filter((row) => row.original.code === '001').length, 2);
  assert.equal(
    result.records.find((row) => row.sourceKind === 'WEEKLY_STOP').weekLabel,
    'SEMANA 1',
  );
  assert.equal(result.records.filter((row) => row.errors.length).length, 0);
});

test('W2 separates numeric name prefixes without treating them as official identity', async () => {
  const kml = xml(
    '<Document><Folder><name>0. Ruta San Jose Noreste</name><Folder><name>(042) - San Rafael de Coronado</name>' +
      '<Placemark><name>03997 - FARMACIA GIRASOL</name><Point><coordinates>-84.1,9.9</coordinates></Point></Placemark>' +
      '<Placemark><name>0007 - Nombre con código explícito</name><ExtendedData><Data name="codigo"><value>0009</value></Data></ExtendedData><Point><coordinates>-84.2,9.9</coordinates></Point></Placemark>' +
      '</Folder></Folder></Document>',
  );
  const result = await withArchive([{ name: 'doc.kml', data: kml }], parseKmz);
  const group = result.records.find(
    (row) => row.original.name === '(042) - San Rafael de Coronado',
  );
  const parent = result.records.find((row) => row.original.name === '0. Ruta San Jose Noreste');
  const pharmacy = result.records.find((row) => row.original.name === '03997 - FARMACIA GIRASOL');
  const explicit = result.records.find(
    (row) => row.original.name === '0007 - Nombre con código explícito',
  );
  assert.deepEqual(
    [group.normalized.name, group.normalized.code, group.normalized.code_source],
    ['San Rafael de Coronado', '42', 'NAME_PREFIX'],
  );
  assert.equal(
    isRouteCandidate({ source_kind: group.sourceKind, normalized: group.normalized }),
    true,
  );
  assert.equal(recordType(group.sourceKind, group.errors), 'GEOGRAPHIC_GROUP');
  assert.equal(
    isRouteCandidate({ source_kind: parent.sourceKind, normalized: parent.normalized }),
    false,
  );
  assert.equal(pharmacy.parentPath, group.sourcePath);
  assert.equal(
    isRouteCandidate({ source_kind: pharmacy.sourceKind, normalized: pharmacy.normalized }),
    false,
  );
  assert.equal(isRouteCandidate({ source_kind: 'WEEKLY_GROUP', normalized: {} }), true);
  assert.deepEqual(
    [pharmacy.normalized.name, pharmacy.normalized.code, pharmacy.normalized.code_source],
    ['FARMACIA GIRASOL', '3997', 'NAME_PREFIX'],
  );
  assert.deepEqual(
    [explicit.normalized.name, explicit.normalized.code, explicit.normalized.code_source],
    ['Nombre con código explícito', '0009', 'EXTENDED_DATA'],
  );
  assert.equal(pharmacy.original.code, null);
});

test('W2 diagnoses invalid and out-of-area points without dropping records', async () => {
  const kml = xml(
    '<Placemark><name>Inválido</name><Point><coordinates>190,95</coordinates></Point></Placemark>' +
      '<Placemark><name>Fuera</name><Point><coordinates>2,48</coordinates></Point></Placemark>' +
      '<Placemark><name>Sin ubicación</name></Placemark>',
  );
  const result = await withArchive([{ name: 'doc.kml', data: kml }], parseKmz);
  assert.equal(result.summary.placemarks, 3);
  assert.ok(result.records[0].errors.includes('INVALID_COORDINATE'));
  assert.ok(result.records[1].warnings.includes('OUT_OF_AREA'));
  assert.ok(result.records[2].warnings.includes('NO_GEOMETRY'));
});

test('W2 retains MultiGeometry and diagnoses an open polygon ring', async () => {
  const kml = xml(
    '<Placemark><name>Combined</name><MultiGeometry>' +
      '<Point><coordinates>-84,9</coordinates></Point>' +
      '<LineString><coordinates>-84,9 -84.1,9.1</coordinates></LineString>' +
      '</MultiGeometry></Placemark>' +
      '<Placemark><name>Open ring</name><Polygon><outerBoundaryIs><LinearRing>' +
      '<coordinates>-84,9 -84.1,9 -84.1,9.1 -84,9.1</coordinates>' +
      '</LinearRing></outerBoundaryIs></Polygon></Placemark>',
  );
  const result = await withArchive([{ name: 'doc.kml', data: kml }], parseKmz);
  assert.equal(result.records[0].geometry.type, 'MultiGeometry');
  assert.equal(result.records[0].geometry.geometries.length, 2);
  assert.ok(result.records[0].warnings.includes('MULTI_GEOMETRY'));
  assert.ok(result.records[1].errors.includes('INVALID_POLYGON'));
});

test('W2 rejects DTD and NetworkLink without network access', async () => {
  await assert.rejects(
    withArchive(
      [{ name: 'doc.kml', data: '<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml/>' }],
      parseKmz,
    ),
    /DTD_FORBIDDEN/,
  );
  await assert.rejects(
    withArchive(
      [
        {
          name: 'doc.kml',
          data: xml('<NetworkLink><Link><href>https://example.invalid</href></Link></NetworkLink>'),
        },
      ],
      parseKmz,
    ),
    /NETWORK_LINK_FORBIDDEN/,
  );
});

test('W2 rejects traversal, encrypted entries, bad CRC and expansion bombs', async () => {
  const good = xml('<Placemark><Point><coordinates>-84,9</coordinates></Point></Placemark>');
  await assert.rejects(withArchive([{ name: '../doc.kml', data: good }], parseKmz));
  await assert.rejects(withArchive([{ name: 'doc.kml', data: good, flags: 1 }], parseKmz));
  await assert.rejects(withArchive([{ name: 'doc.kml', data: good, badCrc: true }], parseKmz));
  await assert.rejects(
    withArchive([{ name: 'doc.kml', data: 'x'.repeat(100_000), method: 8 }], parseKmz),
    /EXPANSION_LIMIT/,
  );
});

test('W2 rejects missing KML and malformed XML', async () => {
  await assert.rejects(withArchive([{ name: 'image.png', data: 'x' }], parseKmz), /KML_MISSING/);
  await assert.rejects(
    withArchive([{ name: 'doc.kml', data: '<kml><Placemark></kml>' }], parseKmz),
  );
});
