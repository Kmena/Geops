import { useState, type FormEvent } from 'react';
import { api, ApiClientError, type Device } from './api/client.js';
import { useAuth } from './auth.js';
import { GpsRemote, type RemoteGpsSession } from './gps/remote.js';
import { deviceNames } from './gps/tracking-model.js';

export type DeviceFilter = 'all' | 'active' | 'suspended' | 'noGps' | 'revoked' | 'retired';
export type DeviceAction = 'stopGps' | 'suspend' | 'reactivate' | 'revoke' | 'retire';

const states: Record<string, string> = {
  DRAFT: 'Borrador',
  INVITED: 'Invitado',
  PENDING_CONFIRMATION: 'Confirmación pendiente',
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspendido',
  REVOKED: 'Revocado',
  RETIRED: 'Retirado',
};
const sessionStates: Record<string, string> = {
  OPEN: 'En curso',
  INTERRUPTED: 'Interrumpida',
  STOPPED: 'Finalizada',
  UNKNOWN_END: 'Fin desconocido',
  SCHEDULED: 'Programada',
  MISSED: 'No iniciada',
  CANCELLED: 'Cancelada',
};
const actions: Record<DeviceAction, { title: string; consequence: string }> = {
  stopGps: {
    title: 'Detener seguimiento GPS',
    consequence:
      'Se retirará esta instalación. El servidor rechazará nuevas lecturas; el teléfono desconectado puede tardar en detener su captura local. La identidad y el historial permanecen.',
  },
  suspend: {
    title: 'Suspender dispositivo',
    consequence:
      'Se bloquearán nuevas sesiones, se retirará la instalación GPS y se conservará el historial. Para volver a seguirlo habrá que reactivarlo y activar GPS por separado.',
  },
  reactivate: {
    title: 'Reactivar dispositivo',
    consequence:
      'El servidor comprobará la clave, el vínculo y la política. Esta acción no inicia GPS ni restaura la instalación retirada.',
  },
  revoke: {
    title: 'Revocar identidad definitivamente',
    consequence:
      'Se invalidarán clave, sesiones, invitaciones, vínculo e instalación. El historial permanecerá consultable; esta identidad no podrá reactivarse.',
  },
  retire: {
    title: 'Retirar del inventario operativo',
    consequence:
      'La identidad dejará de operar y pasará a Retirados. Se invalidarán sus autorizaciones y se conservará el historial.',
  },
};

export function filterDevices(devices: Device[], filter: DeviceFilter): Device[] {
  return devices.filter((device) => {
    switch (filter) {
      case 'active':
        return device.status === 'ACTIVE';
      case 'suspended':
        return device.status === 'SUSPENDED';
      case 'noGps':
        return !device.installation_id && !['REVOKED', 'RETIRED'].includes(device.status);
      case 'revoked':
        return device.status === 'REVOKED';
      case 'retired':
        return device.status === 'RETIRED';
      default:
        return true;
    }
  });
}

export function availableActions(device: Device): DeviceAction[] {
  if (device.status === 'RETIRED') return [];
  if (device.status === 'REVOKED') return ['retire'];
  const result: DeviceAction[] = [];
  if (device.installation_id) result.push('stopGps');
  if (device.status === 'ACTIVE') result.push('suspend');
  if (device.status === 'SUSPENDED') result.push('reactivate');
  result.push('revoke', 'retire');
  return result;
}

const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('es-GT') : 'Sin dato';

function requestError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'No tienes permiso o acceso a la empresa de este dispositivo.';
    if (error.status === 404)
      return 'El dispositivo o su vínculo ya no está disponible para esta cuenta. Actualiza Inventario; puede requerir una nueva inscripción autorizada.';
    if (error.status === 409 && error.code === 'key_inactive')
      return 'La clave PoP ya no está activa. Se requiere una nueva inscripción o recuperación autorizada.';
    if (error.status === 409 && error.code === 'policy_inactive')
      return 'La política GPS asignada no está activa. Revisa la política antes de reactivar.';
    if (error.status === 409 && error.code === 'reactivation_conflict')
      return 'Hay una invitación, confirmación o instalación abierta. Resuelve ese estado antes de reactivar.';
    if (error.status === 409)
      return 'El estado o la autorización cambió. Actualiza el inventario y revisa las condiciones.';
    if (error.status === 401) return 'La sesión expiró. Vuelve a entrar.';
  }
  return 'No se pudo completar la operación. Comprueba la conexión y vuelve a intentarlo.';
}

export function DeviceManagement({
  devices,
  capabilities,
  refresh,
}: {
  devices: Device[];
  capabilities: string[];
  refresh: () => void;
}) {
  const { profile } = useAuth();
  const [filter, setFilter] = useState<DeviceFilter>('all');
  const [selectedId, setSelectedId] = useState('');
  const [action, setAction] = useState<DeviceAction | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [locationReason, setLocationReason] = useState('');
  const [lastPositionAt, setLastPositionAt] = useState<string | null>(null);
  const [positionChecked, setPositionChecked] = useState(false);
  const [positionLoading, setPositionLoading] = useState(false);
  const [sessions, setSessions] = useState<RemoteGpsSession[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const visible = filterDevices(devices, filter);
  const names = deviceNames(
    devices.map((device) => ({
      device_id: device.id,
      display_label: device.display_label,
      tenant_id: device.tenant_id,
      installation_id: device.installation_id,
      assignment_version: 0,
    })),
  );
  const selected = devices.find((item) => item.id === selectedId) ?? null;
  const canManage = capabilities.includes('gps.installation.manage');
  const irreversible = action === 'revoke' || action === 'retire';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selected ||
      !action ||
      !profile ||
      reason.trim().length < 8 ||
      (irreversible && !confirmed)
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'stopGps') {
        if (!selected.installation_id) throw new Error('installation_missing');
        await api.retireInstallation(selected.installation_id, profile.csrf_token, reason.trim());
      } else {
        await api.changeDeviceState(selected.id, action, profile.csrf_token, reason.trim());
      }
      setNotice(`${actions[action].title}: operación registrada para ${names.get(selected.id)}.`);
      setAction(null);
      setReason('');
      setConfirmed(false);
      refresh();
    } catch (failure) {
      setError(requestError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function checkLastPosition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selected ||
      !capabilities.includes('gps.location.read') ||
      locationReason.trim().length < 8
    )
      return;
    setPositionLoading(true);
    setError('');
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 86_400_000);
      const page = await new GpsRemote().positions(
        selected.id,
        locationReason.trim(),
        from.toISOString(),
        to.toISOString(),
      );
      setLastPositionAt(page.items[0]?.received_at ?? null);
      setPositionChecked(true);
    } catch (failure) {
      setError(requestError(failure));
    } finally {
      setPositionLoading(false);
    }
  }

  async function checkSessions() {
    if (!selected || !capabilities.includes('gps.session.read')) return;
    setSessionsLoading(true);
    setError('');
    try {
      const page = await new GpsRemote().sessions(selected.id);
      setSessions(page.items);
    } catch (failure) {
      setError(requestError(failure));
    } finally {
      setSessionsLoading(false);
    }
  }

  return (
    <section className="panel device-management" aria-labelledby="device-management-title">
      <div className="panel-head">
        <h2 id="device-management-title">Administrar dispositivos GEOPS</h2>
        <span className="badge">{devices.length} registros</span>
      </div>
      <p>
        Identidad e instalación GPS se administran por separado. «Activo» no significa que el
        teléfono esté enviando ubicaciones.
      </p>
      <fieldset className="device-filters">
        <legend>Filtrar dispositivos</legend>
        {(
          [
            ['all', 'Todos'],
            ['active', 'Activos'],
            ['suspended', 'Suspendidos'],
            ['noGps', 'Sin seguimiento'],
            ['revoked', 'Revocados'],
            ['retired', 'Retirados'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setAction(null);
              setSelectedId('');
            }}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {visible.length === 0 ? (
        <p className="empty">No hay dispositivos en este filtro.</p>
      ) : (
        <ul className="managed-device-list">
          {visible.map((device) => (
            <li key={device.id}>
              <button
                type="button"
                className="managed-device-select"
                aria-pressed={selectedId === device.id}
                onClick={() => {
                  setSelectedId(device.id);
                  setAction(null);
                  setError('');
                  setPositionChecked(false);
                  setLocationReason('');
                  setSessions(null);
                }}
              >
                <strong>{names.get(device.id)}</strong>
                <span>
                  {states[device.status] ?? device.status} · GPS{' '}
                  {device.installation_id
                    ? 'instalado'
                    : device.last_installation_retired_at
                      ? 'detenido'
                      : 'sin instalar'}
                </span>
                {capabilities.includes('gps.policy.read') && (
                  <small>Política: {device.policy_name ?? 'Sin asignación'}</small>
                )}
                <small>Última comunicación: {date(device.last_communication_at)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p role="status">{notice}</p>}
      {selected && (
        <div className="managed-device-detail">
          <h3>{names.get(selected.id)}</h3>
          <div className="managed-device-columns">
            <section aria-label="Identidad">
              <h4>Identidad</h4>
              <dl>
                <div>
                  <dt>Estado</dt>
                  <dd>{states[selected.status] ?? selected.status}</dd>
                </div>
                <div>
                  <dt>Inscripción</dt>
                  <dd>{date(selected.enrolled_at)}</dd>
                </div>
                <div>
                  <dt>Última actividad</dt>
                  <dd>{date(selected.last_communication_at)}</dd>
                </div>
              </dl>
            </section>
            <section aria-label="Seguimiento">
              <h4>Seguimiento</h4>
              <dl>
                <div>
                  <dt>Instalación GPS</dt>
                  <dd>
                    {selected.installation_id
                      ? 'Activa'
                      : selected.last_installation_retired_at
                        ? 'Detenida'
                        : 'Sin instalar'}
                  </dd>
                </div>
                <div>
                  <dt>Política asignada</dt>
                  <dd>
                    {capabilities.includes('gps.policy.read')
                      ? (selected.policy_name ?? 'Sin asignación')
                      : 'Sin permiso de lectura'}
                  </dd>
                </div>
                <div>
                  <dt>Última sesión</dt>
                  <dd>
                    {capabilities.includes('gps.session.read')
                      ? selected.session_state
                        ? (sessionStates[selected.session_state] ?? selected.session_state)
                        : 'Sin sesiones'
                      : 'Sin permiso de lectura'}
                  </dd>
                </div>
                <div>
                  <dt>Última ubicación recibida</dt>
                  <dd>
                    {!capabilities.includes('gps.location.read')
                      ? 'Sin permiso de ubicación'
                      : positionChecked
                        ? lastPositionAt
                          ? date(lastPositionAt)
                          : 'Sin lecturas en las últimas 24 horas'
                        : 'Consulta auditada disponible'}
                  </dd>
                </div>
              </dl>
              {capabilities.includes('gps.location.read') && (
                <form
                  className="managed-location-query"
                  onSubmit={(event) => void checkLastPosition(event)}
                >
                  <label>
                    Motivo para consultar la última recepción (24 horas)
                    <input
                      value={locationReason}
                      minLength={8}
                      maxLength={240}
                      required
                      onChange={(event) => setLocationReason(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={positionLoading || locationReason.trim().length < 8}
                  >
                    {positionLoading ? 'Consultando…' : 'Consultar última recepción'}
                  </button>
                </form>
              )}
              {capabilities.includes('gps.session.read') && (
                <div className="managed-session-history">
                  <button
                    type="button"
                    onClick={() => void checkSessions()}
                    disabled={sessionsLoading}
                  >
                    {sessionsLoading ? 'Consultando…' : 'Consultar sesiones históricas'}
                  </button>
                  {sessions &&
                    (sessions.length === 0 ? (
                      <p>Sin sesiones registradas.</p>
                    ) : (
                      <ul>
                        {sessions.map((session) => (
                          <li key={session.scheduled_session_id}>
                            {sessionStates[session.state] ?? session.state} ·{' '}
                            {date(session.scheduled_start_at)}
                          </li>
                        ))}
                      </ul>
                    ))}
                </div>
              )}
            </section>
          </div>
          {error && <p role="alert">{error}</p>}
          <details className="managed-device-technical">
            <summary>Binding e identificadores técnicos</summary>
            <dl>
              <div>
                <dt>ID GEOPS</dt>
                <dd>
                  <code>{selected.id}</code>
                </dd>
              </div>
              <div>
                <dt>Binding</dt>
                <dd>
                  <code>{selected.mdm_binding_id}</code>
                </dd>
              </div>
              <div>
                <dt>ID MDM</dt>
                <dd>
                  <code>{selected.mdm_device_id}</code>
                </dd>
              </div>
              <div>
                <dt>Tenant</dt>
                <dd>{selected.tenant_id}</dd>
              </div>
            </dl>
          </details>
          {canManage && availableActions(selected).length > 0 && (
            <section aria-label="Acciones administrativas">
              <h4>Administración</h4>
              <div className="managed-device-actions">
                {availableActions(selected).map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAction(value);
                      setReason('');
                      setConfirmed(false);
                      setError('');
                    }}
                  >
                    {actions[value].title}
                  </button>
                ))}
              </div>
              {action && availableActions(selected).includes(action) && (
                <form className="managed-device-confirm" onSubmit={(event) => void submit(event)}>
                  <h5>{actions[action].title}</h5>
                  <p>{actions[action].consequence}</p>
                  <label>
                    Motivo administrativo
                    <textarea
                      required
                      minLength={8}
                      maxLength={240}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  {irreversible && (
                    <label className="managed-device-check">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      Confirmo que esta acción es definitiva para la identidad seleccionada.
                    </label>
                  )}
                  <div className="managed-device-actions">
                    <button
                      type="submit"
                      disabled={busy || reason.trim().length < 8 || (irreversible && !confirmed)}
                    >
                      {busy ? 'Guardando…' : `Confirmar: ${actions[action].title}`}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setAction(null)}>
                      Cancelar
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
