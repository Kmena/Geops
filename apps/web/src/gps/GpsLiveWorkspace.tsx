import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClientError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { gpsReadErrorMessage, loadGpsOverview } from './load.js';
import {
  GpsRemote,
  type RemoteGpsDevice,
  type RemoteGpsSession,
  type RemoteHealth,
  type RemotePolicy,
  type RemotePosition,
} from './remote.js';
import { GpsPolicyEditor } from './GpsPolicyEditor.js';

type Section = 'policies' | 'devices' | 'sessions' | 'executive';
const remote = new GpsRemote();
const HEALTH_REASON = 'Consulta operativa de salud desde GEOPS Web';
const LOCATION_REASON = 'Consulta operativa de ubicaciones desde GEOPS Web';
const recentPeriod = () => {
  const end = new Date();
  return {
    from: new Date(end.getTime() - 23 * 60 * 60 * 1000).toISOString(),
    to: end.toISOString(),
  };
};
const format = (value: string | undefined | null): string =>
  value
    ? new Date(value).toLocaleString('es-GT', { timeZone: 'America/Guatemala' })
    : 'Desconocido';
const observed = (value: boolean | null | undefined, yes: string, no: string): string =>
  value === true ? yes : value === false ? no : 'Desconocido';

function PositionTrack({ positions }: { positions: RemotePosition[] }) {
  const ordered = [...positions].sort(
    (a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at),
  );
  const latitudes = ordered.map((item) => item.latitude);
  const longitudes = ordered.map((item) => item.longitude);
  const minLat = Math.min(...latitudes),
    maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes),
    maxLon = Math.max(...longitudes);
  const rangeLat = Math.max(maxLat - minLat, 0.00001);
  const rangeLon = Math.max(maxLon - minLon, 0.00001);
  const xy = (item: RemotePosition) => ({
    x: 20 + ((item.longitude - minLon) / rangeLon) * 600,
    y: 20 + (1 - (item.latitude - minLat) / rangeLat) * 260,
  });
  return (
    <figure className="gps-track">
      <svg
        viewBox="0 0 640 300"
        role="img"
        aria-label={`Recorrido de ${ordered.length} posiciones autorizadas`}
      >
        <polyline
          points={ordered
            .map((item) => {
              const point = xy(item);
              return `${point.x},${point.y}`;
            })
            .join(' ')}
          fill="none"
          stroke="#176b82"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {ordered.map((item, index) => {
          const point = xy(item);
          return (
            <circle
              key={item.event_id}
              cx={point.x}
              cy={point.y}
              r={index === ordered.length - 1 ? 6 : 3}
              fill={index === ordered.length - 1 ? '#b5412c' : '#176b82'}
            />
          );
        })}
      </svg>
      <figcaption>
        Trayectoria relativa de posiciones consultadas · sin mapa base ni envío a terceros. El punto
        rojo es el último de esta consulta.
      </figcaption>
    </figure>
  );
}
export function GpsLiveWorkspace({ section }: { section: Section }) {
  const [revision, setRevision] = useState(0);
  return (
    <GpsLiveContent
      key={revision}
      section={section}
      refresh={() => setRevision((current) => current + 1)}
    />
  );
}

function GpsLiveContent({ section, refresh }: { section: Section; refresh: () => void }) {
  const { profile } = useAuth();
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [policies, setPolicies] = useState<RemotePolicy[]>([]);
  const [devices, setDevices] = useState<RemoteGpsDevice[]>([]);
  const [selected, setSelected] = useState('');
  const [sessions, setSessions] = useState<RemoteGpsSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [health, setHealth] = useState<RemoteHealth | null>(null);
  const [positions, setPositions] = useState<RemotePosition[]>([]);
  const [positionCursor, setPositionCursor] = useState<string | null>(null);
  const [positionPeriod, setPositionPeriod] = useState<{ from: string; to: string } | null>(null);
  const [positionLoading, setPositionLoading] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterSession, setFilterSession] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const allowed = useCallback(
    (permission: string) => capabilities?.includes(permission) ?? false,
    [capabilities],
  );
  useEffect(() => {
    if (!profile) {
      setError(new ApiClientError(401, 'unauthorized'));
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const overview = await loadGpsOverview(remote, controller.signal, (rights, tenants) => {
          if (!controller.signal.aborted) {
            setCapabilities(rights);
            setTenantIds(tenants);
          }
        });
        if (controller.signal.aborted) return;
        setPolicies(overview.policies);
        setDevices(overview.devices);
        setSelected((current) =>
          overview.devices.some((item) => item.device_id === current)
            ? current
            : (overview.devices[0]?.device_id ?? ''),
        );
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [profile]);

  useEffect(() => {
    if (!selected || !allowed('gps.session.read')) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setSessions([]);
    setSessionCursor(null);
    setHealth(null);
    setPositions([]);
    setPositionCursor(null);
    setPositionPeriod(null);
    setPositionLoading(false);
    void remote
      .sessions(selected, undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setSessions(page.items);
          setSessionCursor(page.next_cursor);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setDetailError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selected, allowed]);

  useEffect(() => {
    if (section !== 'devices' || !selected || !allowed('gps.location.read')) return;
    const controller = new AbortController();
    const period = recentPeriod();
    setPositions([]);
    setPositionCursor(null);
    setPositionPeriod(period);
    setPositionLoading(true);
    void remote
      .positions(selected, LOCATION_REASON, period.from, period.to, undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setPositions(page.items);
          setPositionCursor(page.next_cursor);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setDetailError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPositionLoading(false);
      });
    return () => controller.abort();
  }, [section, selected, allowed]);

  const active = useMemo(
    () => devices.find((item) => item.device_id === selected),
    [devices, selected],
  );
  const latestPosition = useMemo(
    () =>
      positions.reduce<RemotePosition | null>(
        (latest, item) =>
          !latest || Date.parse(item.captured_at) > Date.parse(latest.captured_at) ? item : latest,
        null,
      ),
    [positions],
  );
  async function loadHealth() {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setHealth(await remote.health(selected, HEALTH_REASON));
    } catch (failure) {
      setDetailError(failure);
    } finally {
      setDetailLoading(false);
    }
  }
  async function loadPositions(cursor?: string) {
    setDetailLoading(true);
    setPositionLoading(true);
    setDetailError(null);
    try {
      const period =
        cursor && positionPeriod
          ? positionPeriod
          : from && to
            ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
            : recentPeriod();
      const page = await remote.positions(
        selected,
        LOCATION_REASON,
        period.from,
        period.to,
        cursor,
        undefined,
        filterSession || undefined,
      );
      setPositions((current) => (cursor ? [...current, ...page.items] : page.items));
      setPositionCursor(page.next_cursor);
      if (!cursor) setPositionPeriod(period);
    } catch (failure) {
      setDetailError(failure);
    } finally {
      setDetailLoading(false);
      setPositionLoading(false);
    }
  }

  return (
    <section className="gps-live" aria-label="Datos de backend sintético">
      <div className="gps-banner" role="note">
        <strong>Backend sintético autenticado</strong>
        <span>
          Consultas y administración autenticadas del entorno de prueba. Los teléfonos reales
          requieren autorización y gates de seguridad.
        </span>
      </div>
      <div className="gps-live-toolbar">
        <button type="button" onClick={refresh}>
          Actualizar datos
        </button>
        <span>
          {capabilities === null
            ? 'Capacidades GPS sin confirmar'
            : `${capabilities.length} capacidades GPS vigentes`}
        </span>
      </div>
      {capabilities !== null && (
        <section aria-label="Permisos efectivos de esta cuenta">
          <h2>Permisos efectivos</h2>
          <p>{capabilities.length ? capabilities.join(' · ') : 'Sin capacidades GPS concedidas'}</p>
          <p>
            Empresa autorizada: {tenantIds.length ? tenantIds.join(', ') : 'sin acceso a datos GPS'}
          </p>
        </section>
      )}
      {loading && <p role="status">Cargando datos autorizados…</p>}
      {error !== null && <p role="alert">{gpsReadErrorMessage(error)}</p>}
      {!loading && error === null && capabilities?.length === 0 && (
        <p>
          Esta cuenta no tiene capacidades GPS concedidas. Solicita una concesión administrativa
          aprobada.
        </p>
      )}
      {!loading && !error && section === 'policies' && (
        <div>
          <h2>Políticas publicadas y borradores</h2>
          {!allowed('gps.policy.read') ? (
            <p>Sin permiso de lectura de políticas.</p>
          ) : policies.length === 0 ? (
            <p>No hay políticas visibles.</p>
          ) : (
            <ul>
              {policies.map((policy) => (
                <li key={policy.id}>
                  <strong>{policy.policy.name}</strong> · {policy.state} · revisión{' '}
                  {policy.revision}
                </li>
              ))}
            </ul>
          )}
          <GpsPolicyEditor
            policies={policies}
            devices={devices}
            capabilities={capabilities ?? []}
            refresh={refresh}
          />
        </div>
      )}
      {!loading && !error && section === 'executive' && (
        <div>
          <h2>Preparación técnica</h2>
          <p>
            {policies.length} políticas visibles · {devices.length} dispositivos autorizados.
          </p>
          <p>Estas cifras describen configuración técnica; no son métricas de productividad.</p>
        </div>
      )}
      {!loading && !error && (section === 'devices' || section === 'sessions') && (
        <div>
          <h2>{section === 'devices' ? 'Dispositivos autorizados' : 'Sesiones GPS'}</h2>
          {devices.length === 0 ? (
            <p>No hay dispositivos visibles para los tenants concedidos.</p>
          ) : (
            <>
              <label>
                Dispositivo{' '}
                <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                  {devices.map((device) => (
                    <option key={device.device_id} value={device.device_id}>
                      {device.device_id}
                    </option>
                  ))}
                </select>
              </label>
              {active && (
                <p>
                  Tenant: {active.tenant_id} · Instalación:{' '}
                  {active.installation_id ?? 'Desconocida'} · Versión asignada:{' '}
                  {active.assignment_version}
                </p>
              )}
              {detailLoading && <p role="status">Cargando historial…</p>}
              {detailError !== null && <p role="alert">{gpsReadErrorMessage(detailError)}</p>}
              {section === 'sessions' && (
                <>
                  {sessions.length === 0 && !detailLoading ? (
                    <p>No hay sesiones programadas o efectivas.</p>
                  ) : (
                    <ul>
                      {sessions.map((session) => (
                        <li key={`${session.scheduled_session_id}:${session.session_id ?? ''}`}>
                          <strong>{session.state}</strong> · {session.evidence_state} · Ventana{' '}
                          {format(session.scheduled_start_at)}–{format(session.scheduled_end_at)} ·
                          Inicio efectivo: {format(session.started_at)} · Fin efectivo:{' '}
                          {format(session.stopped_at)} · Interrupciones:{' '}
                          {session.interruption_count}
                        </li>
                      ))}
                    </ul>
                  )}
                  {sessionCursor && (
                    <button
                      type="button"
                      onClick={() =>
                        void remote
                          .sessions(selected, sessionCursor)
                          .then((page) => {
                            setSessions((current) => [...current, ...page.items]);
                            setSessionCursor(page.next_cursor);
                          })
                          .catch(setDetailError)
                      }
                    >
                      Más sesiones
                    </button>
                  )}
                </>
              )}
              <div className="gps-live-sensitive">
                <h3>Estado y ubicación</h3>
                <p>Las consultas quedan auditadas y requieren permisos para este dispositivo.</p>
                <button
                  type="button"
                  disabled={!allowed('gps.session.read')}
                  onClick={() => void loadHealth()}
                >
                  Consultar salud
                </button>
                {health && (
                  <div className="gps-health-detail">
                    <p>
                      <strong>Estado:</strong> {health.state} ·{' '}
                      {health.source === 'DEVICE_OBSERVATION'
                        ? 'Observado por dispositivo'
                        : 'Inferencia del servidor'}{' '}
                      · Observado: {format(health.observed_at)}
                    </p>
                    {health.latest ? (
                      <dl>
                        <div>
                          <dt>Batería</dt>
                          <dd>
                            {health.latest.battery_percent === null
                              ? 'Desconocida'
                              : `${health.latest.battery_percent}%`}
                          </dd>
                        </div>
                        <div>
                          <dt>Carga</dt>
                          <dd>{observed(health.latest.charging, 'Cargando', 'Sin carga')}</dd>
                        </div>
                        <div>
                          <dt>Ahorro de energía</dt>
                          <dd>{observed(health.latest.power_save, 'Activado', 'Desactivado')}</dd>
                        </div>
                        <div>
                          <dt>GPS</dt>
                          <dd>
                            {observed(
                              health.latest.provider_available,
                              'Disponible',
                              'No disponible',
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Conectividad</dt>
                          <dd>
                            {observed(
                              health.latest.network_available,
                              'Disponible',
                              'No disponible',
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Servicio</dt>
                          <dd>{health.latest.tracking_state ?? 'Desconocido'}</dd>
                        </div>
                        <div>
                          <dt>Última recepción</dt>
                          <dd>{format(health.latest.received_at)}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p>Sin eventos de salud observados.</p>
                    )}
                    {health.possible_battery_depletion && (
                      <p>
                        Posible apagado por batería: el último nivel observado era crítico; la causa
                        no está confirmada.
                      </p>
                    )}
                  </div>
                )}
                {allowed('gps.location.read') && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void loadPositions();
                    }}
                  >
                    <p>
                      Ubicaciones de las últimas 23 horas. Ajusta el período si necesitas consultar
                      otro momento.
                    </p>
                    <label>
                      Sesión efectiva
                      <select
                        value={filterSession}
                        onChange={(event) => setFilterSession(event.target.value)}
                      >
                        <option value="">Todas las sesiones</option>
                        {sessions
                          .filter((session) => session.session_id)
                          .map((session) => (
                            <option key={session.session_id} value={session.session_id}>
                              {session.session_id}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Desde{' '}
                      <input
                        type="datetime-local"
                        value={from}
                        onChange={(event) => setFrom(event.target.value)}
                      />
                    </label>
                    <label>
                      Hasta{' '}
                      <input
                        type="datetime-local"
                        value={to}
                        onChange={(event) => setTo(event.target.value)}
                      />
                    </label>
                    <button type="submit">Actualizar ubicaciones</button>
                  </form>
                )}
                {positions.length > 0 && (
                  <>
                    {latestPosition && (
                      <p>
                        <strong>Última ubicación observada:</strong>{' '}
                        {format(latestPosition.captured_at)} · {latestPosition.latitude},{' '}
                        {latestPosition.longitude} · precisión ±{latestPosition.accuracy_m} m
                      </p>
                    )}
                    <PositionTrack positions={positions} />
                    <ul>
                      {positions.map((position) => (
                        <li key={position.event_id}>
                          {format(position.captured_at)} · {position.latitude}, {position.longitude}{' '}
                          · ±{position.accuracy_m} m
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {allowed('gps.location.read') &&
                  !positionLoading &&
                  positionPeriod &&
                  positions.length === 0 &&
                  detailError === null && <p>No hay ubicaciones observadas en este período.</p>}
                {positionCursor && (
                  <button type="button" onClick={() => void loadPositions(positionCursor)}>
                    Más posiciones
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
