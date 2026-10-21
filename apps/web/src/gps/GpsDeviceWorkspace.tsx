import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { GpsMap } from './GpsMap.js';
import { gpsReadErrorMessage } from './load.js';
import {
  GpsRemote,
  type RemoteGpsDevice,
  type RemoteGpsSession,
  type RemoteHealth,
  type RemotePosition,
  type RemoteContinuityAlert,
  type RemoteContinuityPage,
} from './remote.js';
import {
  continuityDisplay,
  continuityFailure,
  continuityLabel,
  continuityReason,
  continuityResolution,
} from './continuity-model.js';
import {
  deviceNames,
  effectiveSession,
  GAP_MS,
  localInputValue,
  LOW_ACCURACY_M,
  presetPeriod,
  routeSegments,
  sortAndDedupe,
  validatePeriod,
  zonedDateTime,
  type Period,
  type TimePreset,
} from './tracking-model.js';

const remote = new GpsRemote();
const LOCATION_REASON = 'Consulta operativa de ubicaciones desde GEOPS Web';
const HEALTH_REASON = 'Consulta operativa de salud desde GEOPS Web';
const CONTINUITY_REASON = 'Consulta operativa de alertas de continuidad GPS';
const presets: Array<[TimePreset, string]> = [
  ['now', 'Ahora'],
  ['today', 'Hoy'],
  ['hour', 'Última hora'],
  ['sixHours', 'Últimas 6 horas'],
  ['day', 'Últimas 24 horas'],
  ['yesterday', 'Ayer'],
  ['custom', 'Personalizado'],
];
const initialZone = import.meta.env.VITE_GPS_TIME_ZONE || 'America/Costa_Rica';
function format(value: string | null | undefined, zone: string): string {
  return value
    ? new Intl.DateTimeFormat('es-CR', {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'No disponible';
}
function delay(captured: string, received: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(received) - Date.parse(captured)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
function age(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return 'hace menos de 1 min';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `hace ${hours} h` : `hace ${Math.floor(hours / 24)} d`;
}
function ContinuityIcon({ state }: { state: ReturnType<typeof continuityDisplay> }) {
  const path =
    state === 'NORMAL'
      ? 'M5 10l3 3 6-7'
      : state === 'OUT_OF_HOURS'
        ? 'M9 4v5l3 2'
        : state === 'UNKNOWN'
          ? 'M7 7a2 2 0 1 1 3 2c-1 1-1 1-1 2m0 3h.01'
          : 'M9 5v5m0 3h.01';
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="9" r="7" />
      <path d={path} />
    </svg>
  );
}
function sessionName(
  session: RemoteGpsSession,
  zone: string,
  sessions: RemoteGpsSession[],
): string {
  const base = `Sesión ${format(session.scheduled_start_at, zone)} · ${session.state}`;
  const duplicates = sessions.filter(
    (item) =>
      item.scheduled_start_at === session.scheduled_start_at && item.state === session.state,
  );
  return duplicates.length > 1
    ? `${base} · ${(session.session_id ?? session.scheduled_session_id).replaceAll('-', '').slice(-6)}`
    : base;
}
export function GpsDeviceWorkspace() {
  const { profile } = useAuth();
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [devices, setDevices] = useState<RemoteGpsDevice[]>([]);
  const [selected, setSelected] = useState('');
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [sessions, setSessions] = useState<RemoteGpsSession[]>([]);
  const [sessionsError, setSessionsError] = useState<unknown>(null);
  const [health, setHealth] = useState<RemoteHealth | null>(null);
  const [healthError, setHealthError] = useState<unknown>(null);
  const [fleetAlerts, setFleetAlerts] = useState<RemoteContinuityAlert[]>([]);
  const [fleetHasMore, setFleetHasMore] = useState(false);
  const [continuity, setContinuity] = useState<RemoteContinuityPage | null>(null);
  const [resolvedAlerts, setResolvedAlerts] = useState<RemoteContinuityPage | null>(null);
  const [continuityError, setContinuityError] = useState<unknown>(null);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [continuityUnavailable, setContinuityUnavailable] = useState(false);
  const [continuityLoading, setContinuityLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openLoading, setOpenLoading] = useState(false);
  const [continuityAt, setContinuityAt] = useState(0);
  const [historyWindow, setHistoryWindow] = useState<{
    opened_from: string;
    opened_before: string;
  } | null>(null);
  const [severityFilter, setSeverityFilter] = useState<'' | 'WARNING' | 'CRITICAL'>('');
  const [preset, setPreset] = useState<TimePreset>('day');
  const [zone, setZone] = useState(initialZone);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customPeriod, setCustomPeriod] = useState<Period | null>(null);
  const [filterSession, setFilterSession] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    key: string;
    items: RemotePosition[];
    cursor: string | null;
    period: Period;
    queriedAt: string;
  } | null>(null);
  const [positionError, setPositionError] = useState<unknown>(null);
  const [positionLoading, setPositionLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [overviewToken, setOverviewToken] = useState(0);
  const names = useMemo(() => deviceNames(devices), [devices]);
  const active = devices.find((item) => item.device_id === selected);
  const canRead = capabilities?.includes('gps.location.read') ?? false;
  const canSessions = capabilities?.includes('gps.session.read') ?? false;
  const canContinuity = canRead && canSessions && tenantIds.length > 0;
  const queryKey = `${selected}|${preset}|${zone}|${filterSession}|${customPeriod?.from ?? ''}|${customPeriod?.to ?? ''}|${refreshToken}`;
  const currentKey = useRef(queryKey);
  currentKey.current = queryKey;
  const visible = result?.key === queryKey ? result : null;
  const positions = useMemo(() => sortAndDedupe(visible?.items ?? []), [visible]);
  const latest = positions.at(-1);
  const selectedPosition = positions.find((item) => item.event_id === selectedPoint) ?? latest;
  const segments = routeSegments(positions);
  const display =
    continuity && !continuityError && !continuityUnavailable
      ? continuityDisplay(continuity.items, sessions, health, positions, continuityAt)
      : 'UNKNOWN';
  const shownOpen =
    continuity?.items.filter((alert) => !severityFilter || alert.severity === severityFilter) ?? [];
  const shownResolved =
    resolvedAlerts?.items.filter((alert) => !severityFilter || alert.severity === severityFilter) ??
    [];
  const positionSession = (id: string) => {
    const match = sessions.find((item) => item.session_id === id);
    return match ? sessionName(match, zone, sessions) : `Sesión ${id.slice(0, 8)}`;
  };

  useEffect(() => {
    void overviewToken;
    if (!profile) {
      setOverviewError(new ApiClientError(401, 'unauthorized'));
      setOverviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setOverviewLoading(true);
    setOverviewError(null);
    void remote
      .capabilities(controller.signal)
      .then(async ({ capabilities: rights, tenant_ids: tenants }) => {
        if (controller.signal.aborted) return { items: [] as RemoteGpsDevice[] };
        setCapabilities(rights);
        setTenantIds(tenants);
        return rights.includes('gps.session.read')
          ? remote.devices(controller.signal)
          : { items: [] as RemoteGpsDevice[] };
      })
      .then((page) => {
        if (controller.signal.aborted) return;
        setDevices(page.items);
        setSelected((current) =>
          page.items.some((item) => item.device_id === current)
            ? current
            : (page.items[0]?.device_id ?? ''),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOverviewError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setOverviewLoading(false);
      });
    return () => controller.abort();
  }, [profile, overviewToken]);

  useEffect(() => {
    void refreshToken;
    setSessions([]);
    setHealth(null);
    setSessionsError(null);
    setHealthError(null);
    if (!selected || !canSessions) return;
    const controller = new AbortController();
    void remote
      .sessions(selected, undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setSessions(page.items);
          setFilterSession((current) => effectiveSession(current, page.items, false));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSessionsError(error);
      });
    void remote
      .health(selected, HEALTH_REASON, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setHealth(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setHealthError(error);
      });
    return () => controller.abort();
  }, [selected, canSessions, refreshToken]);

  useEffect(() => {
    void refreshToken;
    setContinuity(null);
    setResolvedAlerts(null);
    setFleetAlerts([]);
    setFleetHasMore(false);
    setContinuityError(null);
    setHistoryError(null);
    setContinuityUnavailable(false);
    if (!selected || !canContinuity) return;
    const controller = new AbortController();
    let discovered = false;
    const now = Date.now();
    const period = {
      opened_from: new Date(now - 30 * 86_400_000).toISOString(),
      opened_before: new Date(now + 1000).toISOString(),
    };
    setHistoryWindow(period);
    setContinuityLoading(true);
    void remote
      .continuityAlerts({ status: 'OPEN', limit: 100 }, CONTINUITY_REASON, controller.signal)
      .then(async (fleet) => {
        if (controller.signal.aborted) return;
        discovered = true;
        setFleetAlerts(fleet.items);
        setFleetHasMore(fleet.next_cursor !== null);
        const [open, history] = await Promise.allSettled([
          remote.continuityAlerts(
            { device_id: selected, status: 'OPEN', limit: 100 },
            CONTINUITY_REASON,
            controller.signal,
          ),
          remote.continuityAlerts(
            {
              device_id: selected,
              status: 'RESOLVED',
              limit: 25,
              ...period,
            },
            CONTINUITY_REASON,
            controller.signal,
          ),
        ]);
        if (!controller.signal.aborted) {
          if (open.status === 'fulfilled') setContinuity(open.value);
          else setContinuityError(open.reason);
          if (history.status === 'fulfilled') setResolvedAlerts(history.value);
          else setHistoryError(history.reason);
          setContinuityAt(Date.now());
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (continuityFailure(error, discovered) === 'UNAVAILABLE') {
          // The unfiltered discovery request is the only 404 that means an old API.
          setContinuityUnavailable(true);
        } else setContinuityError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setContinuityLoading(false);
      });
    return () => controller.abort();
  }, [selected, canContinuity, refreshToken]);

  async function loadMoreOpen() {
    if (!selected || !continuity?.next_cursor || openLoading) return;
    const cursor = continuity.next_cursor;
    setOpenLoading(true);
    setContinuityError(null);
    try {
      const page = await remote.continuityAlerts(
        {
          device_id: selected,
          status: 'OPEN',
          limit: 100,
          cursor,
        },
        CONTINUITY_REASON,
      );
      setContinuity((current) =>
        current?.next_cursor === cursor
          ? { ...current, items: [...current.items, ...page.items], next_cursor: page.next_cursor }
          : current,
      );
    } catch (error) {
      setContinuityError(error);
    } finally {
      setOpenLoading(false);
    }
  }

  async function loadMoreResolved() {
    if (!selected || !resolvedAlerts?.next_cursor || !historyWindow || historyLoading) return;
    const cursor = resolvedAlerts.next_cursor;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await remote.continuityAlerts(
        {
          device_id: selected,
          status: 'RESOLVED',
          limit: 25,
          ...historyWindow,
          cursor,
        },
        CONTINUITY_REASON,
      );
      setResolvedAlerts((current) =>
        current?.next_cursor === cursor
          ? { ...current, items: [...current.items, ...page.items], next_cursor: page.next_cursor }
          : current,
      );
    } catch (error) {
      setHistoryError(error);
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    void refreshToken;
    if (!selected || !canRead || (preset === 'custom' && !customPeriod)) {
      setPositionLoading(false);
      return;
    }
    const controller = new AbortController();
    setPositionLoading(true);
    setPositionError(null);
    setSelectedPoint(null);
    let period: Period;
    try {
      period = preset === 'custom' ? (customPeriod as Period) : presetPeriod(preset, zone);
      const validation = validatePeriod(period);
      if (validation) {
        setFilterError(validation);
        setPositionLoading(false);
        return;
      }
      setFilterError(null);
    } catch (error) {
      setFilterError(error instanceof Error ? error.message : 'Período inválido.');
      setPositionLoading(false);
      return;
    }
    void remote
      .positions(
        selected,
        LOCATION_REASON,
        period.from,
        period.to,
        undefined,
        controller.signal,
        filterSession || undefined,
      )
      .then((page) => {
        if (!controller.signal.aborted)
          setResult({
            key: queryKey,
            items: sortAndDedupe(page.items),
            cursor: page.next_cursor,
            period,
            queriedAt: new Date().toISOString(),
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPositionError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPositionLoading(false);
      });
    return () => controller.abort();
  }, [selected, canRead, preset, zone, customPeriod, filterSession, refreshToken, queryKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus())
        setRefreshToken((old) => old + 1);
    }, 120_000);
    return () => window.clearInterval(timer);
  }, []);

  function changeDevice(value: string) {
    setSelected(value);
    setFilterSession('');
    setResult(null);
    setSelectedPoint(null);
    setPositionError(null);
  }
  function changePreset(value: TimePreset) {
    setPreset(value);
    setResult(null);
    setFilterError(null);
    setPositionError(null);
    if (value === 'custom') setCustomPeriod(null);
    if (value === 'custom' && !customFrom) {
      const now = new Date();
      setCustomFrom(localInputValue(new Date(now.getTime() - 60 * 60_000), zone));
      setCustomTo(localInputValue(now, zone));
    }
  }
  function applyCustom() {
    try {
      const next = {
        from: zonedDateTime(customFrom, zone).toISOString(),
        to: zonedDateTime(customTo, zone).toISOString(),
      };
      const error = validatePeriod(next);
      if (error) {
        setFilterError(error);
        return;
      }
      setFilterError(null);
      setCustomPeriod(next);
      setResult(null);
    } catch (error) {
      setFilterError(error instanceof Error ? error.message : 'Fechas inválidas.');
    }
  }
  async function loadMore() {
    const cursor = visible?.cursor;
    if (!cursor || moreLoading) return;
    const snapshot = visible;
    setMoreLoading(true);
    try {
      const page = await remote.positions(
        selected,
        LOCATION_REASON,
        snapshot.period.from,
        snapshot.period.to,
        cursor,
        undefined,
        filterSession || undefined,
      );
      setResult((current) =>
        current?.key === snapshot.key
          ? {
              ...current,
              items: sortAndDedupe([...current.items, ...page.items]),
              cursor: page.next_cursor,
              queriedAt: new Date().toISOString(),
            }
          : current,
      );
    } catch (error) {
      if (currentKey.current === snapshot.key) setPositionError(error);
    } finally {
      setMoreLoading(false);
    }
  }

  return (
    <section className="gps-live gps-device-workspace" aria-label="Seguimiento de dispositivos GPS">
      <header className="gps-device-heading">
        <div>
          <h2>Dispositivos GPS</h2>
          <p>Ubicaciones recibidas por GEOPS · las consultas quedan auditadas.</p>
        </div>
        <button
          type="button"
          onClick={() => setOverviewToken((old) => old + 1)}
          disabled={overviewLoading}
        >
          Actualizar listado
        </button>
      </header>
      {overviewLoading && <p role="status">Cargando dispositivos autorizados…</p>}
      {overviewError !== null && <p role="alert">{gpsReadErrorMessage(overviewError)}</p>}
      {!overviewLoading && !overviewError && !devices.length && (
        <p>
          No hay dispositivos GPS activos autorizados para esta cuenta. Los suspendidos y retirados
          permanecen en <Link to="/inventory">Inventario</Link> según tus permisos.
        </p>
      )}
      {!!devices.length && (
        <div className="gps-device-grid">
          <aside className="gps-device-sidebar" aria-label="Dispositivo y estado">
            <label className="gps-device-selector">
              Dispositivo
              <select value={selected} onChange={(event) => changeDevice(event.target.value)}>
                {devices.map((item) => (
                  <option key={item.device_id} value={item.device_id}>
                    {names.get(item.device_id)}
                  </option>
                ))}
              </select>
            </label>
            <div className="gps-device-status">
              <strong>{names.get(selected)}</strong>
              <span>
                {health
                  ? `${health.state} · ${health.source === 'DEVICE_OBSERVATION' ? 'observado por dispositivo' : 'inferido por servidor'}`
                  : 'Estado de salud sin consultar'}
              </span>
              <small>Última comunicación: {format(health?.latest?.received_at, zone)}</small>
              {canContinuity && continuity && (
                <span className={`gps-continuity-status is-${display.toLowerCase()}`}>
                  <ContinuityIcon state={display} />
                  {continuityLabel[display]}
                </span>
              )}
            </div>
            <details className="gps-device-identity-details">
              <summary>Estado e identidad</summary>
              <dl className="gps-device-identity">
                <div>
                  <dt>Identidad</dt>
                  <dd>{active?.identity_state === 'ACTIVE' ? 'Inscrito' : 'No disponible'}</dd>
                </div>
                <div>
                  <dt>Instalación GPS</dt>
                  <dd>{active?.installation_id ? 'Activa' : 'Sin activar'}</dd>
                </div>
                <div>
                  <dt>Seguimiento</dt>
                  <dd>{latest ? 'Ubicaciones recibidas' : 'Sin datos suficientes'}</dd>
                </div>
              </dl>
            </details>
            <details className="gps-device-technical">
              <summary>Detalles técnicos y permisos</summary>
              <dl>
                <div>
                  <dt>ID de dispositivo</dt>
                  <dd>
                    <code>{selected}</code>{' '}
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(selected)}
                    >
                      Copiar ID
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>Empresa</dt>
                  <dd>{active?.tenant_id ?? 'No disponible'}</dd>
                </div>
                <div>
                  <dt>Instalación</dt>
                  <dd>
                    <code>{active?.installation_id ?? 'No disponible'}</code>
                  </dd>
                </div>
                <div>
                  <dt>Versión asignada</dt>
                  <dd>{active?.assignment_version ?? 'No disponible'}</dd>
                </div>
                <div>
                  <dt>Empresas autorizadas</dt>
                  <dd>{tenantIds.join(', ') || 'Ninguna'}</dd>
                </div>
                <div>
                  <dt>Capacidades</dt>
                  <dd>{capabilities?.join(', ') || 'Ninguna'}</dd>
                </div>
              </dl>
            </details>
          </aside>
          <div className="gps-device-main">
            <section className="gps-continuity" aria-label="Alertas de continuidad GPS">
              <div className="gps-section-heading">
                <h3>Continuidad GPS</h3>
                <button
                  type="button"
                  onClick={() => setRefreshToken((old) => old + 1)}
                  disabled={continuityLoading}
                >
                  Actualizar alertas
                </button>
              </div>
              {!canContinuity && (
                <p>
                  No tienes los permisos de sesiones y ubicaciones, o acceso a la empresa, para
                  consultar alertas.
                </p>
              )}
              {continuityLoading && <p role="status">Consultando alertas…</p>}
              {continuityUnavailable && (
                <p role="status">Alertas aún no disponibles en este servidor.</p>
              )}
              {continuityError !== null && !continuityUnavailable && (
                <p role="alert">Alertas: {gpsReadErrorMessage(continuityError)}</p>
              )}
              {continuity && !continuityError && (
                <>
                  <p className={`gps-continuity-status is-${display.toLowerCase()}`}>
                    <ContinuityIcon state={display} />
                    {continuityLabel[display]}
                    {display === 'NORMAL' && ' · posición y salud recibidas recientemente'}
                    {display === 'UNKNOWN' && ' · una lista vacía no confirma seguimiento activo'}
                  </p>
                  <p className="gps-continuity-note">
                    Evaluación consultada {format(new Date(continuityAt).toISOString(), zone)}. Una
                    alerta es una inferencia del servidor; el silencio no identifica la causa.
                  </p>
                  <label className="gps-continuity-filter">
                    Severidad
                    <select
                      value={severityFilter}
                      onChange={(event) =>
                        setSeverityFilter(event.target.value as typeof severityFilter)
                      }
                    >
                      <option value="">Todas</option>
                      <option value="WARNING">Aviso</option>
                      <option value="CRITICAL">Crítica</option>
                    </select>
                  </label>
                  {shownOpen.length === 0 && <p>No hay alertas abiertas con este filtro.</p>}
                  <ul className="gps-continuity-list">
                    {shownOpen.map((alert) => (
                      <li key={alert.alert_id}>
                        <strong>
                          {alert.severity === 'CRITICAL' ? 'Crítica' : 'Aviso'} ·{' '}
                          {continuityReason[alert.reason_code]}
                        </strong>
                        <span>
                          Inferido por servidor · evaluado{' '}
                          {format(alert.inference.evaluated_at, zone)}
                        </span>
                        <span>
                          Última evidencia: {format(alert.inference.evidence_at, zone)} · antigüedad
                          al evaluar: {Math.floor(alert.inference.age_s / 60)} min · umbral{' '}
                          {Math.floor(alert.inference.threshold_s / 60)} min
                        </span>
                        <span>
                          Observado por dispositivo:{' '}
                          {alert.observed.tracking_state ?? 'desconocido'} · telemetría{' '}
                          {format(alert.observed.last_health_observed_at, zone)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {continuity.next_cursor && (
                    <button
                      type="button"
                      disabled={openLoading}
                      onClick={() => void loadMoreOpen()}
                    >
                      {openLoading ? 'Cargando…' : 'Más alertas abiertas'}
                    </button>
                  )}
                  {fleetAlerts.length > 0 && (
                    <details className="gps-continuity-fleet">
                      <summary>
                        Alertas de los dispositivos autorizados ({fleetAlerts.length}
                        {fleetHasMore ? '+' : ''})
                      </summary>
                      <ul>
                        {fleetAlerts.map((alert) => (
                          <li key={alert.alert_id}>
                            <button type="button" onClick={() => changeDevice(alert.device_id)}>
                              {names.get(alert.device_id) ?? 'Dispositivo autorizado'}
                            </button>
                            {' · '}
                            {alert.severity === 'CRITICAL' ? 'Crítica' : 'Aviso'} ·{' '}
                            {continuityReason[alert.reason_code]}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <details className="gps-continuity-history">
                    <summary>Historial de alertas resueltas</summary>
                    <p>
                      Detectadas en los últimos 30 días. La resolución de una alerta no confirma por
                      sí sola que volvió la captura.
                    </p>
                    {historyError !== null && (
                      <p role="alert">Historial: {gpsReadErrorMessage(historyError)}</p>
                    )}
                    {resolvedAlerts && shownResolved.length === 0 && (
                      <p>No hay alertas resueltas con este filtro.</p>
                    )}
                    <ul className="gps-continuity-list">
                      {shownResolved.map((alert) => (
                        <li key={alert.alert_id}>
                          <strong>
                            {continuityReason[alert.reason_code]} ·{' '}
                            {alert.severity === 'CRITICAL' ? 'Crítica' : 'Aviso'}
                          </strong>
                          <span>
                            Detectada {format(alert.opened_at, zone)} · resuelta{' '}
                            {format(alert.resolved_at, zone)}
                          </span>
                          <span>
                            Motivo de cierre:{' '}
                            {alert.resolution_reason
                              ? continuityResolution[alert.resolution_reason]
                              : 'Desconocido'}
                          </span>
                          <span>
                            Última evaluación: {format(alert.inference.evaluated_at, zone)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {resolvedAlerts?.next_cursor && (
                      <button
                        type="button"
                        disabled={historyLoading}
                        onClick={() => void loadMoreResolved()}
                      >
                        {historyLoading ? 'Cargando…' : 'Más alertas resueltas'}
                      </button>
                    )}
                  </details>
                </>
              )}
            </section>
            <section className="gps-period" aria-label="Período de ubicaciones">
              <div className="gps-period-head">
                <h3>Ubicaciones</h3>
              </div>
              <fieldset className="gps-presets" aria-label="Filtros rápidos">
                {presets.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={preset === key}
                    onClick={() => changePreset(key)}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
              {!canRead && <p role="alert">No tienes permiso para consultar ubicaciones.</p>}
              {filterError && <p role="alert">{filterError}</p>}
              {positionLoading && <p role="status">Consultando ubicaciones…</p>}
              {positionError !== null && <p role="alert">{gpsReadErrorMessage(positionError)}</p>}
            </section>
            <section className="gps-map-section" aria-label="Mapa y recorrido">
              <div className="gps-section-heading">
                <h3>Mapa y recorrido</h3>
                <span>
                  {positions.length} posiciones recibidas
                  {segments.length > 1
                    ? ` · ${segments.length - 1} ${segments.length === 2 ? 'interrupción' : 'interrupciones'} de más de ${GAP_MS / 60_000} min o cambio de sesión`
                    : ''}
                </span>
              </div>
              <GpsMap
                positions={positions}
                selectedId={selectedPosition?.event_id ?? null}
                onSelect={setSelectedPoint}
                zone={zone}
              />
              {visible && !positions.length && !positionLoading && !positionError && (
                <p>
                  No hay ubicaciones observadas en este período. Revisa el horario, la sesión o la
                  sincronización del teléfono.
                </p>
              )}
              {selectedPosition && (
                <div className="gps-selected-point">
                  <strong>
                    {selectedPosition.event_id === latest?.event_id
                      ? preset === 'day' && !filterSession
                        ? 'Última ubicación conocida en 24 h'
                        : 'Última posición del período'
                      : 'Posición seleccionada'}
                  </strong>
                  <span>
                    Capturada {format(selectedPosition.captured_at, zone)} · recibida{' '}
                    {format(selectedPosition.received_at, zone)} · retraso{' '}
                    {delay(selectedPosition.captured_at, selectedPosition.received_at)}
                  </span>
                  <span>Antigüedad de la captura: {age(selectedPosition.captured_at)}</span>
                  <span>{positionSession(selectedPosition.session_id)}</span>
                  <span>
                    Precisión ±{selectedPosition.accuracy_m} m
                    {selectedPosition.accuracy_m >= LOW_ACCURACY_M ? ' · precisión baja' : ''}
                  </span>
                  {Date.now() - Date.parse(selectedPosition.captured_at) > 10 * 60_000 && (
                    <span>Dato histórico: la captura tiene más de 10 minutos.</span>
                  )}
                </div>
              )}
            </section>
            <section className="gps-period gps-period-options" aria-label="Opciones de consulta">
              <h3>Opciones de consulta</h3>
              <div className="gps-period-actions">
                <label>
                  Zona horaria
                  <select
                    value={zone}
                    onChange={(event) => {
                      setZone(event.target.value);
                      setResult(null);
                      setCustomPeriod(null);
                      setCustomFrom('');
                      setCustomTo('');
                    }}
                  >
                    <option value="America/Costa_Rica">Costa Rica</option>
                    <option value="America/Guatemala">Guatemala</option>
                    <option value="UTC">UTC</option>
                  </select>
                </label>
              </div>
              {preset === 'custom' && (
                <div className="gps-custom-period">
                  <label>
                    Desde
                    <input
                      type="datetime-local"
                      value={customFrom}
                      onChange={(event) => setCustomFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    Hasta, exclusivo
                    <input
                      type="datetime-local"
                      value={customTo}
                      onChange={(event) => setCustomTo(event.target.value)}
                    />
                  </label>
                  <button type="button" onClick={applyCustom}>
                    Aplicar período
                  </button>
                </div>
              )}
              <div className="gps-period-actions">
                <label>
                  Sesión efectiva
                  <select
                    value={filterSession}
                    onChange={(event) => {
                      setFilterSession(event.target.value);
                      setResult(null);
                    }}
                  >
                    <option value="">Todas las sesiones</option>
                    {sessions
                      .filter((item) => item.session_id)
                      .map((item) => (
                        <option key={item.session_id} value={item.session_id}>
                          {sessionName(item, zone, sessions)}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => setRefreshToken((old) => old + 1)}
                  disabled={!canRead || positionLoading || moreLoading}
                >
                  Actualizar
                </button>
              </div>
              {sessionsError !== null && (
                <p role="alert">Sesiones: {gpsReadErrorMessage(sessionsError)}</p>
              )}
              {visible && (
                <p className="gps-period-summary">
                  Período consultado: {format(visible.period.from, zone)} –{' '}
                  {format(visible.period.to, zone)} (fin exclusivo) · última consulta{' '}
                  {format(visible.queriedAt, zone)}
                </p>
              )}
            </section>
            <section className="gps-position-section">
              <h3>Posiciones</h3>
              <div className="gps-table-scroll">
                <table>
                  <caption>
                    Ubicaciones autorizadas de {names.get(selected)} ordenadas por hora de captura
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Captura</th>
                      <th scope="col">Recepción</th>
                      <th scope="col">Retraso</th>
                      <th scope="col">Precisión</th>
                      <th scope="col">Sesión</th>
                      <th scope="col">Coordenadas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((item, index) => (
                      <tr
                        key={item.event_id}
                        className={
                          item.event_id === selectedPosition?.event_id ? 'is-selected' : undefined
                        }
                      >
                        <td>
                          <button
                            type="button"
                            onClick={() => setSelectedPoint(item.event_id)}
                            aria-label={`Seleccionar posición ${index + 1}`}
                          >
                            {format(item.captured_at, zone)}
                          </button>
                        </td>
                        <td>{format(item.received_at, zone)}</td>
                        <td>{delay(item.captured_at, item.received_at)}</td>
                        <td>
                          ±{item.accuracy_m} m{item.accuracy_m >= LOW_ACCURACY_M ? ' · baja' : ''}
                        </td>
                        <td>{positionSession(item.session_id)}</td>
                        <td>
                          {item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visible?.cursor && (
                <button type="button" disabled={moreLoading} onClick={() => void loadMore()}>
                  {moreLoading ? 'Cargando…' : 'Más posiciones'}
                </button>
              )}
            </section>
            <section className="gps-diagnostics">
              <h3>Sincronización y salud</h3>
              <dl>
                <div>
                  <dt>Última captura recibida</dt>
                  <dd>{format(latest?.captured_at, zone)}</dd>
                </div>
                <div>
                  <dt>Última recepción de ubicación</dt>
                  <dd>{format(latest?.received_at, zone)}</dd>
                </div>
                <div>
                  <dt>Última sincronización confirmada</dt>
                  <dd>No disponible</dd>
                </div>
                <div>
                  <dt>Posiciones pendientes en el teléfono</dt>
                  <dd>No disponible</dd>
                </div>
                <div>
                  <dt>Estado de sesión</dt>
                  <dd>
                    {sessions[0]
                      ? `${sessions[0].state} · ${sessions[0].evidence_state}`
                      : 'Sin datos suficientes'}
                  </dd>
                </div>
                <div>
                  <dt>Salud observada</dt>
                  <dd>{format(health?.observed_at, zone)}</dd>
                </div>
                <div>
                  <dt>Última comunicación de salud</dt>
                  <dd>{format(health?.latest?.received_at, zone)}</dd>
                </div>
              </dl>
              {healthError !== null && (
                <p role="alert">Salud: {gpsReadErrorMessage(healthError)}</p>
              )}
              <p>
                Un intervalo sin posiciones no demuestra pérdida: Android puede no entregar una
                lectura o el teléfono puede sincronizar después.
              </p>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
