import { createHash } from 'node:crypto';

export type PermissionState =
  | 'GRANTED'
  | 'DENIED'
  | 'NOT_DECLARED'
  | 'RESTRICTED'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';
export type ServiceState = 'RUNNING_OBSERVED' | 'STOPPED_OBSERVED' | 'UNKNOWN';
export interface DiagnosticSnapshot {
  schema_version: 1;
  installation_id: string;
  boot_id: string;
  sequence: number;
  observed_at: string;
  app_version: string;
  manufacturer: string;
  model: string;
  android_release: string;
  android_api: number;
  permissions: Record<'fine' | 'coarse' | 'background' | 'notifications', PermissionState>;
  execution: {
    location_enabled: boolean | null;
    gps_provider_enabled: boolean | null;
    battery_exempt: boolean | null;
    power_save: boolean | null;
    background_restricted: boolean | null;
    data_saver: 'RESTRICTED' | 'EXEMPT' | 'DISABLED' | 'UNKNOWN';
    internet: 'VALIDATED' | 'UNVALIDATED' | 'OFFLINE' | 'UNKNOWN';
  };
  gps: {
    service: ServiceState;
    last_callback_at: string | null;
    last_capture_at: string | null;
    last_ack_at: string | null;
    pending_positions: number | null;
    upload_auth_blocked: boolean | null;
    capture_interval_s: number | null;
    sync_interval_s: number | null;
    policy_revision: number | null;
    tracking_mode: 'CONTINUOUS' | 'WORK_WINDOW' | 'UNKNOWN';
  };
  errors: { code: string; observed_at: string }[];
}

export class DiagnosticValidationError extends Error {}
const fail = (): never => {
  throw new DiagnosticValidationError('invalid_diagnostic');
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const fields = (value: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value)))
    fail();
};
const string = (value: unknown, max: number, pattern?: RegExp): string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  (!pattern || pattern.test(value))
    ? value
    : fail();
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T =>
  typeof value === 'string' && options.includes(value as T) ? (value as T) : fail();
const integer = (value: unknown, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail();
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
  value === null ? null : parse(value);
const bool = (value: unknown): boolean => (typeof value === 'boolean' ? value : fail());
const time = (value: unknown): string => {
  const text = string(value, 35, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/);
  if (!Number.isFinite(Date.parse(text))) fail();
  return text;
};
const uuid = (value: unknown) =>
  string(value, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const permissionStates = [
  'GRANTED',
  'DENIED',
  'NOT_DECLARED',
  'RESTRICTED',
  'NOT_APPLICABLE',
  'UNKNOWN',
] as const;

/** Exact, bounded allowlist; no free-form diagnostic text, coordinates or secrets. */
export function parseDiagnostic(value: unknown, bytes: number): DiagnosticSnapshot {
  if (bytes > 16_384) fail();
  const root = record(value);
  fields(root, [
    'schema_version',
    'installation_id',
    'boot_id',
    'sequence',
    'observed_at',
    'app_version',
    'manufacturer',
    'model',
    'android_release',
    'android_api',
    'permissions',
    'execution',
    'gps',
    'errors',
  ]);
  if (root.schema_version !== 1) fail();
  const permissions = record(root.permissions);
  fields(permissions, ['fine', 'coarse', 'background', 'notifications']);
  const execution = record(root.execution);
  fields(execution, [
    'location_enabled',
    'gps_provider_enabled',
    'battery_exempt',
    'power_save',
    'background_restricted',
    'data_saver',
    'internet',
  ]);
  const gps = record(root.gps);
  fields(gps, [
    'service',
    'last_callback_at',
    'last_capture_at',
    'last_ack_at',
    'pending_positions',
    'upload_auth_blocked',
    'capture_interval_s',
    'sync_interval_s',
    'policy_revision',
    'tracking_mode',
  ]);
  const rawErrors = root.errors;
  if (!Array.isArray(rawErrors) || rawErrors.length > 5) fail();
  const errors = (rawErrors as unknown[]).map((item: unknown) => {
    const row = record(item);
    fields(row, ['code', 'observed_at']);
    return {
      code: string(row.code, 80, /^[A-Z][A-Z0-9_]{2,79}$/),
      observed_at: time(row.observed_at),
    };
  });
  return {
    schema_version: 1,
    installation_id: uuid(root.installation_id),
    boot_id: string(root.boot_id, 100, /^[A-Za-z0-9_-]{8,100}$/),
    sequence: integer(root.sequence, 1, Number.MAX_SAFE_INTEGER),
    observed_at: time(root.observed_at),
    app_version: string(root.app_version, 80, /^[A-Za-z0-9._-]+$/),
    manufacturer: string(root.manufacturer, 80, /^[\p{L}\p{N} ._-]+$/u),
    model: string(root.model, 80, /^[\p{L}\p{N} ._-]+$/u),
    android_release: string(root.android_release, 40, /^[A-Za-z0-9._-]+$/),
    android_api: integer(root.android_api, 26, 100),
    permissions: {
      fine: oneOf(permissions.fine, permissionStates),
      coarse: oneOf(permissions.coarse, permissionStates),
      background: oneOf(permissions.background, permissionStates),
      notifications: oneOf(permissions.notifications, permissionStates),
    },
    execution: {
      location_enabled: nullable(execution.location_enabled, bool),
      gps_provider_enabled: nullable(execution.gps_provider_enabled, bool),
      battery_exempt: nullable(execution.battery_exempt, bool),
      power_save: nullable(execution.power_save, bool),
      background_restricted: nullable(execution.background_restricted, bool),
      data_saver: oneOf(execution.data_saver, ['RESTRICTED', 'EXEMPT', 'DISABLED', 'UNKNOWN']),
      internet: oneOf(execution.internet, ['VALIDATED', 'UNVALIDATED', 'OFFLINE', 'UNKNOWN']),
    },
    gps: {
      service: oneOf(gps.service, ['RUNNING_OBSERVED', 'STOPPED_OBSERVED', 'UNKNOWN']),
      last_callback_at: nullable(gps.last_callback_at, time),
      last_capture_at: nullable(gps.last_capture_at, time),
      last_ack_at: nullable(gps.last_ack_at, time),
      pending_positions: nullable(gps.pending_positions, (v) => integer(v, 0, 100_000)),
      upload_auth_blocked: nullable(gps.upload_auth_blocked, bool),
      capture_interval_s: nullable(gps.capture_interval_s, (v) => integer(v, 15, 86_400)),
      sync_interval_s: nullable(gps.sync_interval_s, (v) => integer(v, 15, 86_400)),
      policy_revision: nullable(gps.policy_revision, (v) => integer(v, 0, 1_000_000)),
      tracking_mode: oneOf(gps.tracking_mode, ['CONTINUOUS', 'WORK_WINDOW', 'UNKNOWN']),
    },
    errors,
  };
}

export const diagnosticDigest = (snapshot: DiagnosticSnapshot): string =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
