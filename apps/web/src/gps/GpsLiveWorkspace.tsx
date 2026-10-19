import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClientError } from '../api/client.js';
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
function message(error: unknown): string {
  if (!(error instanceof ApiClientError))
    return 'No se pudo completar la consulta. Inténtalo de nuevo.';
  if (error.status === 401) return 'La sesión expiró. Vuelve a iniciar sesión.';
  if (error.status === 403) return 'No tienes la capacidad necesaria para esta consulta.';
  if (error.status === 409) return 'Los datos cambiaron. Actualiza la vista antes de continuar.';
  if (error.status === 429) return 'Se alcanzó la cuota. Espera antes de reintentar.';
  return error.status === 404
    ? 'El dispositivo no está disponible en tu tenant.'
    : 'Consulta inválida o servicio no disponible.';
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
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [policies, setPolicies] = useState<RemotePolicy[]>([]);
  const [devices, setDevices] = useState<RemoteGpsDevice[]>([]);
  const [selected, setSelected] = useState('');
  const [sessions, setSessions] = useState<RemoteGpsSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [health, setHealth] = useState<RemoteHealth | null>(null);
  const [positions, setPositions] = useState<RemotePosition[]>([]);
  const [positionCursor, setPositionCursor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterSession, setFilterSession] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const allowed = useCallback(
    (permission: string) => capabilities.includes(permission),
    [capabilities],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await remote.session(controller.signal);
        const access = await remote.capabilities(controller.signal);
        const rights = access.capabilities;
        setCapabilities(rights);
        const [policyPage, devicePage] = await Promise.all([
          rights.includes('gps.policy.read')
            ? remote.policies(undefined, controller.signal)
            : Promise.resolve({ items: [], next_cursor: null }),
          rights.includes('gps.session.read')
            ? remote.devices(controller.signal)
            : Promise.resolve({ items: [] }),
        ]);
        if (controller.signal.aborted) return;
        setPolicies(policyPage.items);
        setDevices(devicePage.items);
        setSelected((current) =>
          devicePage.items.some((item) => item.device_id === current)
            ? current
            : (devicePage.items[0]?.device_id ?? ''),
        );
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

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

  const active = useMemo(
    () => devices.find((item) => item.device_id === selected),
    [devices, selected],
  );
  async function loadHealth() {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setHealth(await remote.health(selected, reason));
    } catch (failure) {
      setDetailError(failure);
    } finally {
      setDetailLoading(false);
    }
  }
  async function loadPositions(cursor?: string) {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const page = await remote.positions(
        selected,
        reason,
        new Date(from).toISOString(),
        new Date(to).toISOString(),
        cursor,
        undefined,
        filterSession || undefined,
      );
      setPositions((current) => (cursor ? [...current, ...page.items] : page.items));
      setPositionCursor(page.next_cursor);
    } catch (failure) {
      setDetailError(failure);
    } finally {
      setDetailLoading(false);
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
        <span>{capabilities.length} capacidades GPS vigentes</span>
      </div>
      {loading && <p role="status">Cargando datos autorizados…</p>}
      {error !== null && <p role="alert">{message(error)}</p>}
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
            capabilities={capabilities}
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
              {detailError !== null && <p role="alert">{message(detailError)}</p>}
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
                <h3>Consultas sensibles</h3>
                <label>
                  Motivo de consulta{' '}
                  <input
                    value={reason}
                    minLength={8}
                    maxLength={240}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Explica el motivo de acceso"
                  />
                </label>
                <button
                  type="button"
                  disabled={reason.trim().length < 8 || !allowed('gps.session.read')}
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
                        required
                      />
                    </label>
                    <label>
                      Hasta{' '}
                      <input
                        type="datetime-local"
                        value={to}
                        onChange={(event) => setTo(event.target.value)}
                        required
                      />
                    </label>
                    <button type="submit" disabled={reason.trim().length < 8}>
                      Consultar posiciones
                    </button>
                  </form>
                )}
                {positions.length > 0 && (
                  <>
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
