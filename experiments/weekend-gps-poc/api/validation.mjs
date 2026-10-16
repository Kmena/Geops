import { createHash, randomBytes, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto';

export const ENV_ID = 'weekend-gps-poc-v1';
export const MAX_BATCH = 50;
export const MAX_BODY = 64 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

export class POCError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const id = () => randomUUID();
export const validId = (value) => typeof value === 'string' && uuid.test(value);

export function verifyPassword(password, stored) {
  const pieces = String(stored ?? '').split(':');
  if (
    pieces.length !== 2 ||
    !/^[0-9a-f]{32}$/.test(pieces[0]) ||
    !/^[0-9a-f]{128}$/.test(pieces[1])
  )
    return false;
  const actual = scryptSync(password, Buffer.from(pieces[0], 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(pieces[1], 'hex'));
}

export function validateEnrollment(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'environment_id,invitation_id,invitation_secret'
  )
    throw new POCError(400, 'invalid_enrollment');
  if (
    value.environment_id !== ENV_ID ||
    !validId(value.invitation_id) ||
    typeof value.invitation_secret !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.invitation_secret)
  )
    throw new POCError(400, 'invalid_enrollment');
  return value;
}

export function validateBatch(value, now = Date.now(), retentionHours = 72) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'batch_id,events,schema_version'
  )
    throw new POCError(400, 'invalid_batch');
  if (
    value.schema_version !== 1 ||
    !validId(value.batch_id) ||
    !Array.isArray(value.events) ||
    value.events.length < 1 ||
    value.events.length > MAX_BATCH
  )
    throw new POCError(422, 'invalid_batch');
  const seen = new Set();
  const events = value.events.map((event) => {
    if (
      !event ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      Object.keys(event).sort().join(',') !== 'accuracy_m,captured_at,event_id,latitude,longitude'
    )
      throw new POCError(422, 'invalid_event');
    const { event_id, captured_at, latitude, longitude, accuracy_m } = event;
    if (
      !validId(event_id) ||
      seen.has(event_id) ||
      typeof captured_at !== 'string' ||
      !iso.test(captured_at) ||
      !Number.isFinite(Date.parse(captured_at)) ||
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      typeof accuracy_m !== 'number' ||
      !Number.isFinite(accuracy_m) ||
      accuracy_m <= 0 ||
      accuracy_m > 10000
    )
      throw new POCError(422, 'invalid_event');
    const captureMs = Date.parse(captured_at);
    if (captureMs > now + 5 * 60_000 || captureMs < now - retentionHours * 3_600_000)
      throw new POCError(422, 'invalid_capture_time');
    seen.add(event_id);
    return {
      event_id,
      captured_at,
      latitude,
      longitude,
      accuracy_m,
      digest: sha256(JSON.stringify([captured_at, latitude, longitude, accuracy_m])),
    };
  });
  return { batch_id: value.batch_id, events };
}

export function dateRange(query, now = Date.now(), retentionHours = 72) {
  const from = query?.from;
  const to = query?.to;
  if (typeof from !== 'string' || typeof to !== 'string' || !iso.test(from) || !iso.test(to))
    throw new POCError(400, 'invalid_range');
  const start = Date.parse(from),
    end = Date.parse(to);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    end - start > retentionHours * 3_600_000 ||
    start < now - retentionHours * 3_600_000 ||
    end > now + 60_000
  )
    throw new POCError(400, 'invalid_range');
  return { from, to };
}
