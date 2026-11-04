import { splitNameCode } from './name-code.js';

export const MATCHER_RULESET = 'spec03-w3-v3';

export type MatchConfig = { highMeters: number; extendedMeters: number };
export const DEFAULT_MATCH_CONFIG: MatchConfig = { highMeters: 50, extendedMeters: 250 };

export type StageRecord = {
  id: string;
  ordinal: number;
  source_path: string;
  parent_path: string | null;
  source_kind: string;
  week_label: string | null;
  normalized: Record<string, unknown>;
  warnings: string[];
  errors: string[];
};

export type Point = { longitude: number; latitude: number };
export type IntraPair = { left: string; right: string; rules: string[] };

export function hasIdentityEvidence(candidate: {
  target_type: string;
  distance_m: number | null;
  signals: string[];
}): boolean {
  if (candidate.target_type === 'STAGING_RECORD' && candidate.distance_m === 0) return true;
  return candidate.signals.some(
    (signal) =>
      signal.startsWith('EXPLICIT_') ||
      [
        'IN_FILE_CODE',
        'IN_FILE_NAME',
        'IN_FILE_SIMILAR_NAME',
        'NAME_NORMALIZED_EXACT',
        'NAME_SIMILAR',
        'SOURCE_KEY_EXACT_NON_AUTHORITATIVE',
        'LINKED_CUSTOMER',
      ].includes(signal),
  );
}

export function isRouteCandidate(record: {
  source_kind: string;
  normalized: Record<string, unknown>;
}): boolean {
  return (
    record.source_kind === 'WEEKLY_GROUP' ||
    (record.source_kind === 'TERRITORY_GROUP' && record.normalized.code_source === 'NAME_PREFIX')
  );
}

export function normalizedName(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase('es')
        .trim()
        .replace(/\s+/gu, ' ')
    : '';
}

export function normalizedCode(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleUpperCase('es')
    : '';
}

export function comparisonCode(record: StageRecord): {
  value: string;
  source: 'EXTENDED_DATA' | 'NAME_PREFIX' | null;
} {
  const explicit = normalizedCode(record.normalized.code);
  if (explicit)
    return {
      value: explicit,
      source: record.normalized.code_source === 'NAME_PREFIX' ? 'NAME_PREFIX' : 'EXTENDED_DATA',
    };
  const inferred = splitNameCode(record.normalized.name, null).code;
  return inferred ? { value: inferred, source: 'NAME_PREFIX' } : { value: '', source: null };
}

export function comparisonName(value: unknown): string {
  return normalizedName(splitNameCode(value, null).name);
}

export function pointOf(record: StageRecord): Point | null {
  const point = record.normalized.point;
  if (!point || typeof point !== 'object') return null;
  const coords = point as Record<string, unknown>;
  return typeof coords.longitude === 'number' && typeof coords.latitude === 'number'
    ? { longitude: coords.longitude, latitude: coords.latitude }
    : null;
}

export function proximityBand(
  distance: number | null,
  config: MatchConfig,
): 'HIGH' | 'EXTENDED' | null {
  if (distance === null || !Number.isFinite(distance) || distance < 0) return null;
  if (distance <= config.highMeters) return 'HIGH';
  if (distance <= config.extendedMeters) return 'EXTENDED';
  return null;
}

export function recordType(kind: string, errors: string[]): string {
  if (errors.length) return 'INVALID_OR_OTHER';
  switch (kind) {
    case 'CLIENT_POINT':
      return 'CLIENT_CANDIDATE';
    case 'BRANCH_POINT':
      return 'REFERENCE_POINT';
    case 'WEEKLY_STOP':
      return 'WEEKLY_STOP';
    case 'TERRITORY_GROUP':
    case 'WEEKLY_GROUP':
    case 'FOLDER':
    case 'DOCUMENT':
      return 'GEOGRAPHIC_GROUP';
    case 'GEO_FEATURE':
      return 'POLYGON';
    case 'ROUTE_LINE':
      return 'LINE';
    default:
      return 'INVALID_OR_OTHER';
  }
}

function roughMeters(a: Point, b: Point): number {
  const radians = Math.PI / 180;
  const north = (a.latitude - b.latitude) * 111_200;
  const east =
    (a.longitude - b.longitude) * 111_200 * Math.cos(((a.latitude + b.latitude) / 2) * radians);
  return Math.hypot(north, east);
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < value.length - 1; i++) result.add(value.slice(i, i + 2));
  return result;
}

export function similarName(a: string, b: string): boolean {
  if (a === b) return a.length > 0;
  if (a.length < 5 || b.length < 5) return false;
  const left = bigrams(a);
  const right = bigrams(b);
  let common = 0;
  for (const item of left) if (right.has(item)) common++;
  return (2 * common) / (left.size + right.size) >= 0.86;
}

export function buildIntraPairs(
  records: StageRecord[],
  extendedMeters: number,
): {
  pairs: IntraPair[];
  warnings: Map<string, Set<string>>;
} {
  const points = records.filter((r) =>
    ['CLIENT_POINT', 'BRANCH_POINT', 'WEEKLY_STOP'].includes(r.source_kind),
  );
  const byCode = new Map<string, StageRecord[]>();
  const byName = new Map<string, StageRecord[]>();
  const byGrid = new Map<string, StageRecord[]>();
  const warnings = new Map<string, Set<string>>();
  const pairs = new Map<string, IntraPair>();
  const counts = new Map<string, number>();
  const cell = Math.max(extendedMeters / 90_000, 0.0001);
  const grid = (x: number, y: number) => `${x}:${y}`;
  const mark = (id: string, warning: string) => {
    const set = warnings.get(id) ?? new Set<string>();
    set.add(warning);
    warnings.set(id, set);
  };
  const add = (a: StageRecord, b: StageRecord, rule: string) => {
    if (a.id === b.id) return;
    const [left, right] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const key = `${left}:${right}`;
    const existing = pairs.get(key);
    if (existing) {
      if (!existing.rules.includes(rule)) existing.rules.push(rule);
      return;
    }
    if ((counts.get(a.id) ?? 0) >= 20 || (counts.get(b.id) ?? 0) >= 20) {
      mark(a.id, 'CANDIDATE_LIMIT');
      mark(b.id, 'CANDIDATE_LIMIT');
      return;
    }
    pairs.set(key, { left, right, rules: [rule] });
    counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
    counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
  };
  for (const record of points) {
    const code = comparisonCode(record).value;
    const name = comparisonName(record.normalized.name);
    if (code) {
      const prior = byCode.get(code) ?? [];
      if (prior.length) {
        mark(record.id, 'DUPLICATE_CODE');
        for (const other of prior.slice(-20)) {
          mark(other.id, 'DUPLICATE_CODE');
          add(record, other, 'IN_FILE_CODE');
        }
      }
      prior.push(record);
      byCode.set(code, prior);
    }
    if (name) {
      const prior = byName.get(name) ?? [];
      for (const other of prior.slice(-20)) add(record, other, 'IN_FILE_NAME');
      prior.push(record);
      byName.set(name, prior);
    }
    const point = pointOf(record);
    if (point) {
      const x = Math.floor(point.longitude / cell);
      const y = Math.floor(point.latitude / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const other of (byGrid.get(grid(x + dx, y + dy)) ?? []).slice(-50)) {
            const otherPoint = pointOf(other);
            if (otherPoint && roughMeters(point, otherPoint) <= extendedMeters + 5)
              add(record, other, 'IN_FILE_PROXIMITY');
          }
      const bucket = byGrid.get(grid(x, y)) ?? [];
      bucket.push(record);
      byGrid.set(grid(x, y), bucket);
    }
  }
  // Adjacent names in a sorted prefix bucket catch near spellings without all-pairs comparison.
  const nameBuckets = new Map<string, StageRecord[]>();
  for (const record of points) {
    const name = comparisonName(record.normalized.name);
    if (name.length < 5) continue;
    const key = name.slice(0, 4);
    const bucket = nameBuckets.get(key) ?? [];
    bucket.push(record);
    nameBuckets.set(key, bucket);
  }
  for (const bucket of nameBuckets.values()) {
    bucket.sort((a, b) =>
      comparisonName(a.normalized.name).localeCompare(comparisonName(b.normalized.name)),
    );
    for (let i = 0; i < bucket.length; i++)
      for (let j = i + 1; j < Math.min(bucket.length, i + 5); j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (
          a &&
          b &&
          similarName(comparisonName(a.normalized.name), comparisonName(b.normalized.name))
        )
          add(a, b, 'IN_FILE_SIMILAR_NAME');
      }
  }
  return { pairs: [...pairs.values()], warnings };
}
