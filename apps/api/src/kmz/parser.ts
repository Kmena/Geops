import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { SaxesParser } from 'saxes';
import { splitNameCode } from './name-code.js';

const require = createRequire(import.meta.url);
type ZipEntry = {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  generalPurposeBitFlag: number;
  externalFileAttributes: number;
  crc32: number;
};
type ZipFile = {
  entryCount: number;
  eachEntry(): AsyncIterable<ZipEntry>;
  openReadStreamPromise(entry: ZipEntry): Promise<Readable>;
  close(): void;
};
const yauzl = require('yauzl') as {
  openPromise(path: string, options: Record<string, boolean>): Promise<ZipFile>;
};

export const HARD_LIMITS = {
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entries: 128,
  pathSegments: 8,
  expansionRatio: 50,
  xmlDepth: 32,
  xmlNodes: 250_000,
  placemarks: 10_000,
  coordinates: 2_000_000,
  coordinatesPerElement: 100_000,
  textBytes: 2 * 1024 * 1024,
  elapsedMs: 30_000,
  rssBytes: 512 * 1024 * 1024,
} as const;

export class KmzParseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type StagedRecord = {
  ordinal: number;
  sourcePath: string;
  parentPath: string | null;
  sourceKind: string;
  weekLabel: string | null;
  original: Record<string, unknown>;
  normalized: Record<string, unknown>;
  geometry: Record<string, unknown> | null;
  warnings: string[];
  errors: string[];
};

export type ParseResult = {
  records: StagedRecord[];
  summary: Record<string, number>;
  expandedBytes: number;
  entries: number;
  cpuMs: number;
  elapsedMs: number;
  peakRssBytes: number;
};

type Geometry = {
  kind: string;
  raw: string[];
  tuples: number[][];
  invalid: boolean;
  topologyInvalid: boolean;
  rings?: number[][][];
  members?: Geometry[];
};
type Frame = {
  tag: string;
  path: string;
  parentPath: string | null;
  index: Map<string, number>;
  text: string;
  name?: string;
  description?: string;
  code?: string;
  geopsCustomerId?: string;
  geopsEstablishmentId?: string;
  geopsPinId?: string;
  dataKey?: string;
  geometry?: Geometry;
  geometries?: Geometry[];
};

function _local(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

function isCodeKey(value: string): boolean {
  return /^(cod(?:igo|e)?|customer.?code|client.?code|id.?cliente)$/i.test(value.trim());
}

function geopsKey(value: string): 'geopsCustomerId' | 'geopsEstablishmentId' | 'geopsPinId' | null {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/gu, '');
  if (key === 'geopscustomerid') return 'geopsCustomerId';
  if (key === 'geopsestablishmentid') return 'geopsEstablishmentId';
  if (key === 'geopspinid') return 'geopsPinId';
  return null;
}

function weekName(value: string): boolean {
  return /^semana\s*[1-9][0-9]*\b/i.test(value.trim());
}

function inCostaRica(lon: number, lat: number): boolean {
  return lon >= -86 && lon <= -82 && lat >= 8 && lat <= 11.5;
}

function parseCoordinates(
  text: string,
  result: ParseResult,
): { tuples: number[][]; invalid: boolean } {
  const parts = text.trim() ? text.trim().split(/\s+/u) : [];
  if (parts.length > HARD_LIMITS.coordinatesPerElement) throw new KmzParseError('COORDINATE_LIMIT');
  result.summary.coordinate_tuples = (result.summary.coordinate_tuples ?? 0) + parts.length;
  if (result.summary.coordinate_tuples > HARD_LIMITS.coordinates)
    throw new KmzParseError('COORDINATE_LIMIT');
  let invalid = false;
  const tuples = parts.map((part) => {
    const fields = part.split(',').map(Number);
    if (
      fields.length < 2 ||
      fields.length > 3 ||
      fields.some((value) => !Number.isFinite(value)) ||
      (fields[0] ?? Number.NaN) < -180 ||
      (fields[0] ?? Number.NaN) > 180 ||
      (fields[1] ?? Number.NaN) < -90 ||
      (fields[1] ?? Number.NaN) > 90
    )
      invalid = true;
    return fields;
  });
  return { tuples, invalid };
}

function makeKmlParser(fileName: string, result: ParseResult): SaxesParser<{ xmlns: true }> {
  const parser = new SaxesParser({ xmlns: true });
  const frames: Frame[] = [];
  let nodes = 0;
  let placemarks = 0;
  const geometryJson = (geometry: Geometry): Record<string, unknown> => {
    if (geometry.members)
      return {
        type: 'MultiGeometry',
        geometries: geometry.members.map(geometryJson),
      };
    return {
      type: geometry.kind,
      coordinates:
        geometry.kind === 'Polygon'
          ? geometry.rings
          : geometry.kind === 'Point'
            ? (geometry.tuples[0] ?? null)
            : geometry.tuples,
    };
  };
  const addRecord = (
    frame: Frame,
    kind: string,
    geometry: Geometry | null,
    week: string | null,
  ) => {
    const warnings: string[] = [];
    const errors: string[] = [];
    if (geometry) {
      if (geometry.kind === 'MultiGeometry') warnings.push('MULTI_GEOMETRY');
      if (geometry.tuples.length === 0) errors.push('INVALID_GEOMETRY');
      if (geometry.kind === 'Point' && geometry.tuples.length !== 1) errors.push('INVALID_POINT');
      if (
        geometry.tuples.some(
          (point) =>
            point.length >= 2 && !inCostaRica(point[0] ?? Number.NaN, point[1] ?? Number.NaN),
        )
      )
        warnings.push('OUT_OF_AREA');
      if (
        geometry.invalid ||
        geometry.tuples.some(
          (point) =>
            point.length < 2 || point.length > 3 || point.some((value) => !Number.isFinite(value)),
        )
      )
        errors.push('INVALID_COORDINATE');
      if (geometry.topologyInvalid || (geometry.kind === 'Polygon' && geometry.tuples.length < 4))
        errors.push('INVALID_POLYGON');
      if (geometry.kind === 'LineString' && geometry.tuples.length < 2) errors.push('INVALID_LINE');
    } else if (frame.tag === 'Placemark') warnings.push('NO_GEOMETRY');
    const original = {
      name: frame.name ?? null,
      code: frame.code ?? null,
      geops_customer_id: frame.geopsCustomerId ?? null,
      geops_establishment_id: frame.geopsEstablishmentId ?? null,
      geops_pin_id: frame.geopsPinId ?? null,
      description: frame.description ?? null,
      geometry_raw: geometry?.raw ?? null,
      source_file: fileName,
    };
    const label = splitNameCode(frame.name, frame.code);
    const normalized = {
      name: label.name,
      code: label.code,
      code_source: label.codeSource,
      geops_customer_id: frame.geopsCustomerId?.trim() ?? null,
      geops_establishment_id: frame.geopsEstablishmentId?.trim() ?? null,
      geops_pin_id: frame.geopsPinId?.trim() ?? null,
      point:
        geometry?.kind === 'Point' && geometry.tuples.length === 1 && errors.length === 0
          ? { longitude: geometry.tuples[0]?.[0], latitude: geometry.tuples[0]?.[1] }
          : null,
    };
    result.records.push({
      ordinal: result.records.length,
      sourcePath: frame.path,
      parentPath: frame.parentPath,
      sourceKind: kind,
      weekLabel: week,
      original,
      normalized,
      geometry: geometry ? geometryJson(geometry) : null,
      warnings,
      errors,
    });
    result.summary[kind] = (result.summary[kind] ?? 0) + 1;
    if (warnings.length) result.summary.warning_records = (result.summary.warning_records ?? 0) + 1;
    if (errors.length) result.summary.error_records = (result.summary.error_records ?? 0) + 1;
  };
  parser.on('doctype', () => {
    throw new KmzParseError('DTD_FORBIDDEN');
  });
  parser.on('processinginstruction', (item) => {
    if (item.target.toLowerCase() !== 'xml')
      throw new KmzParseError('PROCESSING_INSTRUCTION_FORBIDDEN');
  });
  parser.on('opentag', (tag) => {
    nodes++;
    if (nodes > HARD_LIMITS.xmlNodes) throw new KmzParseError('XML_NODE_LIMIT');
    if (frames.length >= HARD_LIMITS.xmlDepth) throw new KmzParseError('XML_DEPTH_LIMIT');
    const name = tag.local;
    if (name === 'NetworkLink') throw new KmzParseError('NETWORK_LINK_FORBIDDEN');
    const parent = frames.at(-1);
    const count = (parent?.index.get(name) ?? 0) + 1;
    parent?.index.set(name, count);
    const parentPath =
      [...frames].reverse().find((item) => ['Document', 'Folder', 'Placemark'].includes(item.tag))
        ?.path ?? null;
    const path = `${parent?.path ?? fileName}/${name}[${count}]`;
    if (path.length > 1200) throw new KmzParseError('XML_PATH_LIMIT');
    const attr = tag.attributes.name;
    frames.push({
      tag: name,
      path,
      parentPath,
      index: new Map(),
      text: '',
      ...(attr && 'value' in attr ? { dataKey: attr.value } : {}),
      ...(['Point', 'Polygon', 'LineString'].includes(name)
        ? {
            geometry: {
              kind: name,
              raw: [],
              tuples: [],
              invalid: false,
              topologyInvalid: false,
              ...(name === 'Polygon' ? { rings: [] } : {}),
            },
          }
        : {}),
      ...(name === 'Placemark' ? { geometries: [] } : {}),
    });
    if (name === 'Placemark' && ++placemarks > HARD_LIMITS.placemarks)
      throw new KmzParseError('PLACEMARK_LIMIT');
  });
  const append = (value: string) => {
    const frame = frames.at(-1);
    if (!frame) return;
    frame.text += value;
    if (Buffer.byteLength(frame.text, 'utf8') > HARD_LIMITS.textBytes)
      throw new KmzParseError('XML_TEXT_LIMIT');
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    const frame = frames.pop();
    if (!frame) throw new KmzParseError('INVALID_KML');
    const parent = frames.at(-1);
    if (frame.tag === 'name' && parent) parent.name = frame.text.trim();
    if (frame.tag === 'description' && parent) parent.description = frame.text;
    if (frame.tag === 'SimpleData' && frame.dataKey) {
      const placemark = [...frames].reverse().find((item) => item.tag === 'Placemark');
      if (placemark) {
        if (isCodeKey(frame.dataKey)) placemark.code = frame.text.trim();
        const key = geopsKey(frame.dataKey);
        if (key) placemark[key] = frame.text.trim();
      }
    }
    if (
      frame.tag === 'value' &&
      parent?.tag === 'Data' &&
      parent.dataKey &&
      (isCodeKey(parent.dataKey) || geopsKey(parent.dataKey))
    ) {
      const placemark = [...frames].reverse().find((item) => item.tag === 'Placemark');
      if (placemark) {
        if (isCodeKey(parent.dataKey)) placemark.code = frame.text.trim();
        const key = geopsKey(parent.dataKey);
        if (key) placemark[key] = frame.text.trim();
      }
    }
    if (frame.tag === 'coordinates') {
      const geo = [...frames].reverse().find((item) => item.geometry);
      if (geo?.geometry) {
        const parsed = parseCoordinates(frame.text, result);
        geo.geometry.raw.push(frame.text);
        geo.geometry.tuples.push(...parsed.tuples);
        geo.geometry.rings?.push(parsed.tuples);
        if (parsed.invalid) geo.geometry.invalid = true;
        if (geo.geometry.kind === 'Polygon') {
          const first = parsed.tuples[0];
          const last = parsed.tuples.at(-1);
          if (
            parsed.tuples.length < 4 ||
            !first ||
            !last ||
            first[0] !== last[0] ||
            first[1] !== last[1]
          )
            geo.geometry.topologyInvalid = true;
        }
      }
    }
    if (['Point', 'Polygon', 'LineString'].includes(frame.tag) && frame.geometry) {
      const placemark = [...frames].reverse().find((item) => item.tag === 'Placemark');
      if (placemark) placemark.geometries?.push(frame.geometry);
    }
    if (frame.tag === 'Placemark') {
      result.summary.placemarks = (result.summary.placemarks ?? 0) + 1;
      const shapes = frame.geometries ?? [];
      const geometry: Geometry | null =
        shapes.length === 1
          ? (shapes[0] ?? null)
          : shapes.length > 1
            ? {
                kind: 'MultiGeometry',
                raw: shapes.flatMap((item) => item.raw),
                tuples: shapes.flatMap((item) => item.tuples),
                invalid: shapes.some((item) => item.invalid),
                topologyInvalid: shapes.some((item) => item.topologyInvalid),
                members: shapes,
              }
            : null;
      const week =
        [...frames].reverse().find((item) => item.tag === 'Folder' && weekName(item.name ?? ''))
          ?.name ?? null;
      const branch = [...frames]
        .reverse()
        .some((item) => item.tag === 'Folder' && /^sedes?\b/i.test(item.name ?? ''));
      const classificationGeometry =
        geometry?.kind === 'MultiGeometry' &&
        geometry.members?.length &&
        geometry.members.every((item) => item.kind === 'Polygon')
          ? 'Polygon'
          : geometry?.kind;
      const kind =
        classificationGeometry === 'Point'
          ? week
            ? 'WEEKLY_STOP'
            : branch
              ? 'BRANCH_POINT'
              : 'CLIENT_POINT'
          : classificationGeometry === 'Polygon'
            ? 'GEO_FEATURE'
            : classificationGeometry === 'LineString'
              ? 'ROUTE_LINE'
              : 'OTHER';
      addRecord(frame, kind, geometry, week);
    }
    if (frame.tag === 'Folder' || frame.tag === 'Document') {
      const week =
        frame.tag === 'Folder' && weekName(frame.name ?? '') ? (frame.name ?? null) : null;
      addRecord(
        frame,
        frame.tag === 'Document' ? 'DOCUMENT' : week ? 'WEEKLY_GROUP' : 'TERRITORY_GROUP',
        null,
        week,
      );
    }
    if (frame.tag === 'href' && /^https?:|^file:|^\//i.test(frame.text.trim()))
      result.summary.external_references_ignored =
        (result.summary.external_references_ignored ?? 0) + 1;
  });
  return parser;
}

export async function parseKmz(path: string): Promise<ParseResult> {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const result: ParseResult = {
    records: [],
    summary: {},
    expandedBytes: 0,
    entries: 0,
    cpuMs: 0,
    elapsedMs: 0,
    peakRssBytes: process.memoryUsage().rss,
  };
  const zip = await yauzl.openPromise(path, {
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const names = new Set<string>();
  let kmlCount = 0;
  try {
    if (zip.entryCount > HARD_LIMITS.entries) throw new KmzParseError('ZIP_ENTRY_LIMIT');
    for await (const entry of zip.eachEntry()) {
      if (performance.now() - started > HARD_LIMITS.elapsedMs)
        throw new KmzParseError('TIME_LIMIT');
      result.entries++;
      if (result.entries > HARD_LIMITS.entries) throw new KmzParseError('ZIP_ENTRY_LIMIT');
      const name = entry.fileName;
      const segments = name.split('/').filter(Boolean);
      if (
        !name ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.includes('\0') ||
        /^[A-Za-z]:/.test(name) ||
        segments.length > HARD_LIMITS.pathSegments ||
        segments.some((segment) => segment === '.' || segment === '..' || segment.includes(':')) ||
        names.has(name.toLowerCase())
      )
        throw new KmzParseError('ZIP_PATH_INVALID');
      names.add(name.toLowerCase());
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) throw new KmzParseError('ZIP_SYMLINK_FORBIDDEN');
      if (entry.generalPurposeBitFlag & 1) throw new KmzParseError('ZIP_ENCRYPTED');
      if (![0, 8].includes(entry.compressionMethod))
        throw new KmzParseError('ZIP_METHOD_UNSUPPORTED');
      if (/\.(?:zip|kmz)$/i.test(name)) throw new KmzParseError('NESTED_ARCHIVE_FORBIDDEN');
      if (
        entry.uncompressedSize > HARD_LIMITS.expandedBytes ||
        result.expandedBytes + entry.uncompressedSize > HARD_LIMITS.expandedBytes ||
        entry.uncompressedSize / Math.max(1, entry.compressedSize) > HARD_LIMITS.expansionRatio
      )
        throw new KmzParseError('EXPANSION_LIMIT');
      if (name.endsWith('/')) {
        if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)
          throw new KmzParseError('ZIP_PATH_INVALID');
        continue;
      }
      const isKml = /\.kml$/i.test(name);
      if (isKml) kmlCount++;
      const parser = isKml ? makeKmlParser(name, result) : null;
      const decoder = parser ? new TextDecoder('utf-8', { fatal: true }) : null;
      const stream = await zip.openReadStreamPromise(entry);
      let length = 0;
      let actualCrc = 0;
      for await (const data of stream) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
        length += chunk.length;
        result.expandedBytes += chunk.length;
        if (result.expandedBytes > HARD_LIMITS.expandedBytes || length > HARD_LIMITS.expandedBytes)
          throw new KmzParseError('EXPANSION_LIMIT');
        if (performance.now() - started > HARD_LIMITS.elapsedMs)
          throw new KmzParseError('TIME_LIMIT');
        actualCrc = crc32(chunk, actualCrc);
        if (parser && decoder) parser.write(decoder.decode(chunk, { stream: true }));
        result.peakRssBytes = Math.max(result.peakRssBytes, process.memoryUsage().rss);
        if (result.peakRssBytes > HARD_LIMITS.rssBytes) throw new KmzParseError('MEMORY_LIMIT');
      }
      if (length !== entry.uncompressedSize || actualCrc !== entry.crc32)
        throw new KmzParseError('ZIP_INTEGRITY_FAILED');
      if (parser && decoder) {
        parser.write(decoder.decode());
        parser.close();
        result.peakRssBytes = Math.max(result.peakRssBytes, process.memoryUsage().rss);
        if (result.peakRssBytes > HARD_LIMITS.rssBytes) throw new KmzParseError('MEMORY_LIMIT');
      }
    }
    if (kmlCount === 0) throw new KmzParseError('KML_MISSING');
  } finally {
    zip.close();
  }
  const usage = process.cpuUsage(cpu);
  result.cpuMs = (usage.user + usage.system) / 1000;
  result.elapsedMs = performance.now() - started;
  return result;
}
