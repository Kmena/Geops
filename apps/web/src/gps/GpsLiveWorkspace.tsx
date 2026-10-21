import { useEffect, useMemo, useState } from 'react';
import { ApiClientError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { GpsDeviceWorkspace } from './GpsDeviceWorkspace.js';
import { GpsPolicyEditor } from './GpsPolicyEditor.js';
import { gpsReadErrorMessage, loadGpsOverview } from './load.js';
import {
  GpsRemote,
  type RemoteGpsDevice,
  type RemoteGpsSession,
  type RemotePolicy,
} from './remote.js';
import { deviceNames } from './tracking-model.js';

type Section = 'policies' | 'devices' | 'sessions' | 'executive';
const remote = new GpsRemote();
const format = (value: string | undefined | null): string =>
  value
    ? new Intl.DateTimeFormat('es-CR', {
        timeZone: 'America/Costa_Rica',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'No disponible';

export function GpsLiveWorkspace({ section }: { section: Section }) {
  if (section === 'devices') return <GpsDeviceWorkspace />;
  return <GpsOtherWorkspace section={section} />;
}

function GpsOtherWorkspace({ section }: { section: Exclude<Section, 'devices'> }) {
  const { profile } = useAuth();
  const [revision, setRevision] = useState(0);
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [policies, setPolicies] = useState<RemotePolicy[]>([]);
  const [devices, setDevices] = useState<RemoteGpsDevice[]>([]);
  const [selected, setSelected] = useState('');
  const [sessions, setSessions] = useState<RemoteGpsSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const names = useMemo(() => deviceNames(devices), [devices]);
  const refresh = () => setRevision((old) => old + 1);

  useEffect(() => {
    void revision;
    if (!profile) {
      setError(new ApiClientError(401, 'unauthorized'));
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void loadGpsOverview(remote, controller.signal, (rights, tenants) => {
      if (!controller.signal.aborted) {
        setCapabilities(rights);
        setTenantIds(tenants);
      }
    })
      .then((overview) => {
        if (controller.signal.aborted) return;
        setPolicies(overview.policies);
        setDevices(overview.devices);
        setSelected((current) =>
          overview.devices.some((item) => item.device_id === current)
            ? current
            : (overview.devices[0]?.device_id ?? ''),
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [profile, revision]);

  useEffect(() => {
    setSessions([]);
    setSessionCursor(null);
    setSessionError(null);
    if (section !== 'sessions' || !selected || !capabilities?.includes('gps.session.read')) return;
    const controller = new AbortController();
    setSessionLoading(true);
    void remote
      .sessions(selected, undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setSessions(page.items);
          setSessionCursor(page.next_cursor);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setSessionError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSessionLoading(false);
      });
    return () => controller.abort();
  }, [section, selected, capabilities]);

  async function moreSessions() {
    if (!sessionCursor || sessionLoading) return;
    setSessionLoading(true);
    setSessionError(null);
    try {
      const page = await remote.sessions(selected, sessionCursor);
      setSessions((current) => [...current, ...page.items]);
      setSessionCursor(page.next_cursor);
    } catch (failure) {
      setSessionError(failure);
    } finally {
      setSessionLoading(false);
    }
  }

  return (
    <section className="gps-live" aria-label="Administración GPS">
      <div className="gps-live-toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          Actualizar datos
        </button>
      </div>
      {loading && <p role="status">Cargando datos autorizados…</p>}
      {error !== null && <p role="alert">{gpsReadErrorMessage(error)}</p>}
      {!loading && error === null && capabilities?.length === 0 && (
        <p>Esta cuenta no tiene capacidades GPS concedidas.</p>
      )}
      {!loading && error === null && section === 'policies' && (
        <div>
          <h2>Políticas publicadas y borradores</h2>
          {!capabilities?.includes('gps.policy.read') ? (
            <p>Sin permiso de lectura de políticas.</p>
          ) : policies.length === 0 ? (
            <p>No hay políticas visibles.</p>
          ) : (
            <ul>
              {policies.map((item) => (
                <li key={item.id}>
                  <strong>{item.policy.name}</strong> · {item.state} · revisión {item.revision}
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
      {!loading && error === null && section === 'executive' && (
        <div>
          <h2>Preparación técnica</h2>
          <p>
            {policies.length} políticas visibles · {devices.length} dispositivos autorizados.
          </p>
          <p>Estas cifras describen configuración técnica; no son métricas de productividad.</p>
        </div>
      )}
      {!loading && error === null && section === 'sessions' && (
        <div>
          <h2>Sesiones GPS</h2>
          {devices.length === 0 ? (
            <p>No hay dispositivos visibles para las empresas concedidas.</p>
          ) : (
            <>
              <label>
                Dispositivo
                <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                  {devices.map((item) => (
                    <option key={item.device_id} value={item.device_id}>
                      {names.get(item.device_id)}
                    </option>
                  ))}
                </select>
              </label>
              {sessionLoading && <p role="status">Cargando sesiones…</p>}
              {sessionError !== null && <p role="alert">{gpsReadErrorMessage(sessionError)}</p>}
              {!sessionLoading && sessions.length === 0 && sessionError === null && (
                <p>No hay sesiones programadas o efectivas.</p>
              )}
              <ul>
                {sessions.map((item) => (
                  <li key={`${item.scheduled_session_id}:${item.session_id ?? ''}`}>
                    <strong>{item.state}</strong> · {item.evidence_state} · ventana{' '}
                    {format(item.scheduled_start_at)}–{format(item.scheduled_end_at)} · inicio
                    efectivo {format(item.started_at)} · fin efectivo {format(item.stopped_at)} ·
                    interrupciones {item.interruption_count}
                  </li>
                ))}
              </ul>
              {sessionCursor && (
                <button type="button" disabled={sessionLoading} onClick={() => void moreSessions()}>
                  Más sesiones
                </button>
              )}
            </>
          )}
        </div>
      )}
      <details className="gps-device-technical">
        <summary>Permisos y empresas de esta cuenta</summary>
        <p>{capabilities?.join(' · ') || 'Sin capacidades GPS'}</p>
        <p>{tenantIds.join(', ') || 'Sin empresas concedidas'}</p>
      </details>
    </section>
  );
}
