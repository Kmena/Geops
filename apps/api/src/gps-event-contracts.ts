import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export type GpsEventKind = 'SESSION' | 'POSITION';
export type SessionType =
  | 'START_ATTEMPT'
  | 'STARTED'
  | 'STOP_REQUESTED'
  | 'STOPPED'
  | 'INTERRUPTED'
  | 'RESUMED'
  | 'MISSED_START';
export interface SessionEvent {
  event_id: string;
  client_session_id?: string;
  scheduled_session_id?: string;
  type: SessionType;
  occurred_at: string;
  assignment_version: number;
  boot_id: string;
  elapsed_realtime_ms: number;
  anchor_elapsed_realtime_ms?: number;
  capture_anchor_id?: string;
  reason_code?: string | null;
}
export interface PositionEvent {
  event_id: string;
  client_session_id: string;
  session_id?: string;
  assignment_version: number;
  captured_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number;
  boot_id: string;
  anchor_elapsed_realtime_ms: number;
  elapsed_realtime_ms: number;
  capture_anchor_id: string;
}
export interface GpsBatch<T extends SessionEvent | PositionEvent> {
  schema_version: 1;
  batch_id: string;
  device_id: string;
  installation_id: string;
  events: T[];
}
export interface GpsBatchAck {
  batch_id: string;
  persisted_at: string;
  accepted_event_ids: string[];
  duplicate_event_ids: string[];
  session_mappings: Array<{ client_session_id: string; session_id: string }>;
  processing: 'complete';
}
export interface GpsMixedEvent {
  kind: GpsEventKind;
  payload: SessionEvent | PositionEvent;
}
export interface GpsBatchV2 {
  schema_version: 2;
  batch_id: string;
  device_id: string;
  installation_id: string;
  client_session_id: string;
  events: GpsMixedEvent[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TYPES = new Set<SessionType>([
  'START_ATTEMPT',
  'STARTED',
  'STOP_REQUESTED',
  'STOPPED',
  'INTERRUPTED',
  'RESUMED',
  'MISSED_START',
]);
const REASONS = new Set([
  'FGS_START_BLOCKED',
  'PERMISSION_DENIED',
  'GPS_DISABLED',
  'CONNECTIVITY_LOST',
  'WINDOW_END',
  'POLICY_REPLACED',
  'POLICY_REVOKED',
  'IDENTITY_REVOKED',
  'PROCESS_RESTART',
  'USER_STOP',
  'UNKNOWN',
]);
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isInt = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;
const isUtc = (value: unknown): value is string =>
  typeof value === 'string' &&
  UTC.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');

export class GpsValidationError extends ApiError {
  constructor(readonly invalidIds: string[] = []) {
    super(422, 'invalid_gps_event', 'Invalid request', true);
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new GpsValidationError();
  return value as Record<string, unknown>;
}

function session(value: unknown): SessionEvent {
  const e = object(value, [
    'event_id',
    'client_session_id',
    'scheduled_session_id',
    'type',
    'occurred_at',
    'assignment_version',
    'boot_id',
    'elapsed_realtime_ms',
    'anchor_elapsed_realtime_ms',
    'capture_anchor_id',
    'reason_code',
  ]);
  const id = isUuid(e.event_id) ? e.event_id : undefined;
  const fail = (): never => {
    throw new GpsValidationError(id ? [id] : []);
  };
  if (
    !id ||
    !TYPES.has(e.type as SessionType) ||
    !isUtc(e.occurred_at) ||
    !isInt(e.assignment_version) ||
    !isUuid(e.boot_id) ||
    !isInt(e.elapsed_realtime_ms) ||
    (e.reason_code !== undefined &&
      e.reason_code !== null &&
      !REASONS.has(e.reason_code as string)) ||
    (e.client_session_id !== undefined && !isUuid(e.client_session_id)) ||
    (e.scheduled_session_id !== undefined && !isUuid(e.scheduled_session_id)) ||
    (e.capture_anchor_id !== undefined && !isUuid(e.capture_anchor_id)) ||
    (e.anchor_elapsed_realtime_ms !== undefined && !isInt(e.anchor_elapsed_realtime_ms))
  )
    fail();
  const diagnostic = e.type === 'START_ATTEMPT' || e.type === 'MISSED_START';
  if (
    (!diagnostic &&
      (!e.client_session_id ||
        !e.capture_anchor_id ||
        e.anchor_elapsed_realtime_ms === undefined)) ||
    (e.type === 'STARTED' && !e.scheduled_session_id) ||
    (e.capture_anchor_id === undefined) !== (e.anchor_elapsed_realtime_ms === undefined) ||
    (e.anchor_elapsed_realtime_ms !== undefined &&
      (e.anchor_elapsed_realtime_ms as number) > (e.elapsed_realtime_ms as number))
  )
    fail();
  return e as unknown as SessionEvent;
}

function position(value: unknown): PositionEvent {
  const e = object(value, [
    'event_id',
    'client_session_id',
    'session_id',
    'assignment_version',
    'captured_at',
    'latitude',
    'longitude',
    'accuracy_m',
    'boot_id',
    'anchor_elapsed_realtime_ms',
    'elapsed_realtime_ms',
    'capture_anchor_id',
  ]);
  const id = isUuid(e.event_id) ? e.event_id : undefined;
  const fail = (): never => {
    throw new GpsValidationError(id ? [id] : []);
  };
  if (
    !id ||
    !isUuid(e.client_session_id) ||
    (e.session_id !== undefined && !isUuid(e.session_id)) ||
    !isInt(e.assignment_version) ||
    !isUtc(e.captured_at) ||
    typeof e.latitude !== 'number' ||
    !Number.isFinite(e.latitude) ||
    e.latitude < -90 ||
    e.latitude > 90 ||
    typeof e.longitude !== 'number' ||
    !Number.isFinite(e.longitude) ||
    e.longitude < -180 ||
    e.longitude > 180 ||
    typeof e.accuracy_m !== 'number' ||
    !Number.isFinite(e.accuracy_m) ||
    e.accuracy_m <= 0 ||
    e.accuracy_m > 10000 ||
    !isUuid(e.boot_id) ||
    !isUuid(e.capture_anchor_id) ||
    !isInt(e.anchor_elapsed_realtime_ms) ||
    !isInt(e.elapsed_realtime_ms) ||
    (e.anchor_elapsed_realtime_ms as number) > (e.elapsed_realtime_ms as number)
  )
    fail();
  return e as unknown as PositionEvent;
}

export function parseGpsBatch(
  kind: 'SESSION',
  body: unknown,
  bytes: number,
): GpsBatch<SessionEvent>;
export function parseGpsBatch(
  kind: 'POSITION',
  body: unknown,
  bytes: number,
): GpsBatch<PositionEvent>;
export function parseGpsBatch(
  kind: GpsEventKind,
  body: unknown,
  bytes: number,
): GpsBatch<SessionEvent> | GpsBatch<PositionEvent> {
  if (bytes > (kind === 'SESSION' ? 128 : 256) * 1024)
    throw new ApiError(413, 'batch_too_large', 'Request too large', true);
  const b = object(body, ['schema_version', 'batch_id', 'device_id', 'installation_id', 'events']);
  if (
    b.schema_version !== 1 ||
    !isUuid(b.batch_id) ||
    !isUuid(b.device_id) ||
    !isUuid(b.installation_id) ||
    !Array.isArray(b.events) ||
    b.events.length < 1 ||
    b.events.length > 100
  )
    throw new GpsValidationError();
  const events = b.events.map((value) => (kind === 'SESSION' ? session(value) : position(value)));
  const ids = events.map((event) => event.event_id);
  if (new Set(ids).size !== ids.length) throw new GpsValidationError(ids);
  return {
    schema_version: 1,
    batch_id: b.batch_id,
    device_id: b.device_id,
    installation_id: b.installation_id,
    events,
  } as GpsBatch<SessionEvent> | GpsBatch<PositionEvent>;
}

/** V2 keeps each original event payload unchanged so v1 and v2 share event digests. */
export function parseGpsV2Batch(body: unknown, bytes: number): GpsBatchV2 {
  if (bytes > 256 * 1024) throw new ApiError(413, 'batch_too_large', 'Request too large', true);
  const b = object(body, [
    'schema_version',
    'batch_id',
    'device_id',
    'installation_id',
    'client_session_id',
    'events',
  ]);
  if (
    b.schema_version !== 2 ||
    !isUuid(b.batch_id) ||
    !isUuid(b.device_id) ||
    !isUuid(b.installation_id) ||
    !isUuid(b.client_session_id) ||
    !Array.isArray(b.events) ||
    b.events.length < 1 ||
    b.events.length > 100
  )
    throw new GpsValidationError();
  const events = b.events.map((value: unknown): GpsMixedEvent => {
    const item = object(value, ['kind', 'payload']);
    if (item.kind !== 'SESSION' && item.kind !== 'POSITION') throw new GpsValidationError();
    const payload = item.kind === 'SESSION' ? session(item.payload) : position(item.payload);
    if (payload.client_session_id !== b.client_session_id) {
      throw new GpsValidationError([payload.event_id]);
    }
    return { kind: item.kind, payload };
  });
  const ids = events.map((event) => event.payload.event_id);
  if (new Set(ids).size !== ids.length) throw new GpsValidationError(ids);
  if (
    events.filter(
      (event) => event.kind === 'SESSION' && (event.payload as SessionEvent).type === 'STARTED',
    ).length > 1
  )
    throw new GpsValidationError(ids);
  return {
    schema_version: 2,
    batch_id: b.batch_id,
    device_id: b.device_id,
    installation_id: b.installation_id,
    client_session_id: b.client_session_id,
    events,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export const digest = (value: unknown): Buffer =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest();
