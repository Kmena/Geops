import type { DiagnosticSnapshot } from './device-diagnostics-contract.js';

export type FindingClass = 'CONFIRMED' | 'POSSIBLE' | 'INSUFFICIENT_EVIDENCE' | 'OFFLINE' | 'STALE';
export interface DiagnosticFinding {
  code: string;
  classification: FindingClass;
  source: 'ANDROID' | 'GPS_V2_LOCAL' | 'SERVER';
}
const FIFTEEN_MIN = 15 * 60_000;
export interface DiagnosticExpectation {
  ownership?: 'CORPORATE_MANAGED' | 'PERSONAL_BYOD' | 'UNVERIFIED';
  trackingAuthorized?: boolean;
  minimumAppVersion?: string;
}
const version = (value: string): number[] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
};

/** Pure rules; never infer a stopped service from missing telemetry. */
export function evaluateDiagnostic(
  snapshot: DiagnosticSnapshot | null,
  receivedAt: Date | null,
  now: Date,
  lastCommunicationAt: Date | null = null,
  expected: DiagnosticExpectation = {},
): DiagnosticFinding[] {
  const noCommunication =
    lastCommunicationAt !== null && now.getTime() - lastCommunicationAt.getTime() > FIFTEEN_MIN;
  if (!snapshot || !receivedAt)
    return [
      ...(noCommunication
        ? [{ code: 'DEVICE_OFFLINE', classification: 'OFFLINE', source: 'SERVER' } as const]
        : []),
      {
        code: 'GPS_SERVICE_STATE_UNKNOWN',
        classification: 'INSUFFICIENT_EVIDENCE',
        source: 'SERVER',
      },
    ];
  const observed = Date.parse(snapshot.observed_at);
  if (now.getTime() - receivedAt.getTime() > FIFTEEN_MIN)
    return [
      ...(noCommunication
        ? [{ code: 'DEVICE_OFFLINE', classification: 'OFFLINE', source: 'SERVER' } as const]
        : []),
      { code: 'DIAGNOSTIC_STALE', classification: 'STALE', source: 'SERVER' },
    ];
  if (now.getTime() - observed > FIFTEEN_MIN || observed - now.getTime() > 5 * 60_000)
    return [{ code: 'DIAGNOSTIC_STALE', classification: 'STALE', source: 'SERVER' }];
  const out: DiagnosticFinding[] = [];
  const add = (code: string, classification: FindingClass, source: DiagnosticFinding['source']) =>
    out.push({ code, classification, source });
  const p = snapshot.permissions;
  if (
    (expected.ownership === 'CORPORATE_MANAGED' && snapshot.gps.tracking_mode === 'WORK_WINDOW') ||
    (expected.ownership === 'PERSONAL_BYOD' && snapshot.gps.tracking_mode === 'CONTINUOUS') ||
    (expected.trackingAuthorized === false && snapshot.gps.tracking_mode !== 'UNKNOWN')
  )
    add('CONFIGURATION_INCOMPATIBLE', 'POSSIBLE', 'SERVER');
  const actualVersion = version(snapshot.app_version);
  const minimumVersion = expected.minimumAppVersion ? version(expected.minimumAppVersion) : null;
  if (
    actualVersion &&
    minimumVersion &&
    actualVersion.some(
      (part, index) =>
        part !== minimumVersion[index] &&
        actualVersion
          .slice(0, index)
          .every((prior, position) => prior === minimumVersion[position]) &&
        part < (minimumVersion[index] ?? 0),
    )
  )
    add('APP_VERSION_OUTDATED', 'CONFIRMED', 'SERVER');
  if (p.fine === 'DENIED' || p.fine === 'RESTRICTED' || p.fine === 'NOT_DECLARED')
    add('GPS_PRECISE_LOCATION_DISABLED', 'CONFIRMED', 'ANDROID');
  if (p.coarse !== 'GRANTED' && p.fine !== 'GRANTED')
    add('GPS_PERMISSION_MISSING', 'CONFIRMED', 'ANDROID');
  if (p.background === 'DENIED' || p.background === 'RESTRICTED' || p.background === 'NOT_DECLARED')
    add('GPS_BACKGROUND_PERMISSION_MISSING', 'CONFIRMED', 'ANDROID');
  if (
    snapshot.execution.location_enabled === false ||
    snapshot.execution.gps_provider_enabled === false
  )
    add('LOCATION_SERVICES_DISABLED', 'CONFIRMED', 'ANDROID');
  if (
    snapshot.execution.background_restricted === true ||
    snapshot.execution.battery_exempt === false
  )
    add('BATTERY_RESTRICTION_DETECTED', 'POSSIBLE', 'ANDROID');
  if (snapshot.execution.data_saver === 'RESTRICTED')
    add('BACKGROUND_DATA_RESTRICTED', 'POSSIBLE', 'ANDROID');
  if (snapshot.gps.service === 'STOPPED_OBSERVED')
    add('GPS_SERVICE_NOT_RUNNING', 'CONFIRMED', 'GPS_V2_LOCAL');
  if (snapshot.gps.service === 'UNKNOWN')
    add('GPS_SERVICE_STATE_UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'GPS_V2_LOCAL');
  const captureAge = snapshot.gps.last_capture_at
    ? observed - Date.parse(snapshot.gps.last_capture_at)
    : null;
  if (
    snapshot.gps.tracking_mode === 'CONTINUOUS' &&
    snapshot.gps.service === 'RUNNING_OBSERVED' &&
    snapshot.gps.capture_interval_s !== null &&
    (captureAge === null || captureAge > Math.max(180_000, snapshot.gps.capture_interval_s * 3_000))
  )
    add('GPS_CAPTURE_STALE', 'POSSIBLE', 'GPS_V2_LOCAL');
  const ackAge = snapshot.gps.last_ack_at ? observed - Date.parse(snapshot.gps.last_ack_at) : null;
  if ((snapshot.gps.pending_positions ?? 0) >= 20)
    add('SYNC_QUEUE_BACKLOG', 'POSSIBLE', 'GPS_V2_LOCAL');
  if (
    (snapshot.gps.pending_positions ?? 0) > 0 &&
    snapshot.gps.sync_interval_s !== null &&
    (ackAge === null || ackAge > Math.max(300_000, snapshot.gps.sync_interval_s * 3_000))
  )
    add('GPS_TRANSMISSION_STALE', 'POSSIBLE', 'GPS_V2_LOCAL');
  if (snapshot.gps.upload_auth_blocked === true)
    add('UPLOAD_AUTHENTICATION_BLOCKED', 'CONFIRMED', 'GPS_V2_LOCAL');
  return out;
}
