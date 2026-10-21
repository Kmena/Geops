import type {
  RemoteContinuityAlert,
  RemoteGpsSession,
  RemoteHealth,
  RemotePosition,
} from './remote.js';
import { ApiClientError } from '../api/client.js';

/** A 404 means an old API only before the unfiltered route discovery succeeds. */
export function continuityFailure(
  error: unknown,
  routeDiscovered: boolean,
): 'UNAVAILABLE' | 'ERROR' {
  return error instanceof ApiClientError && error.status === 404 && !routeDiscovered
    ? 'UNAVAILABLE'
    : 'ERROR';
}

export type ContinuityDisplay = 'CRITICAL' | 'WARNING' | 'NORMAL' | 'OUT_OF_HOURS' | 'UNKNOWN';

/** Empty alerts alone never prove that a device is healthy. */
export function continuityDisplay(
  alerts: RemoteContinuityAlert[],
  sessions: RemoteGpsSession[],
  health: RemoteHealth | null,
  positions: RemotePosition[],
  evaluatedAt: number,
  now = Date.now(),
): ContinuityDisplay {
  const activeWindow = sessions.find(
    (session) =>
      Date.parse(session.scheduled_start_at) <= now && now < Date.parse(session.scheduled_end_at),
  );
  if (!activeWindow && sessions.length) return 'OUT_OF_HOURS';
  if (alerts.some((alert) => alert.status === 'OPEN' && alert.severity === 'CRITICAL'))
    return 'CRITICAL';
  if (alerts.some((alert) => alert.status === 'OPEN')) return 'WARNING';
  if (!activeWindow) return 'UNKNOWN';
  const lastCapture = positions.reduce(
    (latest, position) => Math.max(latest, Date.parse(position.captured_at)),
    0,
  );
  const healthAt = health?.observed_at ? Date.parse(health.observed_at) : 0;
  if (
    health?.source !== 'DEVICE_OBSERVATION' ||
    health.latest?.tracking_state !== 'RUNNING' ||
    lastCapture < Date.parse(activeWindow.scheduled_start_at) ||
    healthAt < Date.parse(activeWindow.scheduled_start_at) ||
    now - evaluatedAt > 5 * 60_000 ||
    lastCapture > now ||
    healthAt > now ||
    now - lastCapture > 5 * 60_000 ||
    now - healthAt > 5 * 60_000
  )
    return 'UNKNOWN';
  return 'NORMAL';
}

export const continuityLabel: Record<ContinuityDisplay, string> = {
  CRITICAL: 'Alerta crítica',
  WARNING: 'Aviso de continuidad',
  NORMAL: 'Actividad reciente observada',
  OUT_OF_HOURS: 'Fuera de horario',
  UNKNOWN: 'Sin evidencia suficiente',
};

export const continuityReason: Record<RemoteContinuityAlert['reason_code'], string> = {
  CAPTURE_STALE: 'Posiciones sin actualizar',
  COMMUNICATION_MISSING: 'Sin comunicación reciente',
};

export const continuityResolution: Record<
  Exclude<RemoteContinuityAlert['resolution_reason'], null>,
  string
> = {
  EVIDENCE_RECOVERED: 'Volvió la evidencia',
  WINDOW_ENDED: 'Finalizó el horario',
  POLICY_CHANGED: 'Cambió la política',
  DEVICE_INACTIVE: 'Dispositivo inactivo',
  INSTALLATION_CHANGED: 'Cambió la instalación',
};
