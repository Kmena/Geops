import { useEffect, useState, type FormEvent } from 'react';
import { ApiClientError } from '../api/client.js';
import { useAuth } from '../auth.js';
import {
  GpsRemote,
  type RemoteAssignment,
  type RemoteGpsDevice,
  type RemotePolicy,
  type RemotePolicySpec,
} from './remote.js';
import { deviceNames } from './tracking-model.js';

const remote = new GpsRemote();
const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const defaultSpec = (): RemotePolicySpec => ({
  name: '',
  days_iso: [1, 2, 3, 4, 5],
  start_local: '08:00',
  end_local: '17:00',
  time_zone: 'America/Guatemala',
  capture_interval_s: 60,
  sync_interval_s: 300,
  heartbeat_missing_after_s: 900,
  health_interval_s: 300,
  valid_from: new Date().toISOString(),
  valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
});
function localInput(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function errorText(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'La sesión expiró.';
    if (error.status === 403) return 'Falta autorización administrativa.';
    if (error.status === 409) return 'La política cambió. Recárgala antes de editar.';
    if (error.status === 422) return 'Revisa horario, vigencia y asignaciones.';
    if (error.status === 429) return 'Límite de solicitudes alcanzado.';
  }
  return 'No se pudo guardar la política.';
}

export function GpsPolicyEditor({
  policies,
  devices,
  capabilities,
  refresh,
}: {
  policies: RemotePolicy[];
  devices: RemoteGpsDevice[];
  capabilities: string[];
  refresh: () => void;
}) {
  const { profile } = useAuth();
  const [id, setId] = useState('');
  const [current, setCurrent] = useState<RemotePolicy | null>(null);
  const [spec, setSpec] = useState<RemotePolicySpec>(defaultSpec);
  const [assignments, setAssignments] = useState<RemoteAssignment[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canWrite = capabilities.includes('gps.policy.write');
  const canAssign = capabilities.includes('gps.policy.assign');
  const canActivate = capabilities.includes('gps.policy.activate') && canWrite;
  const deviceLabels = deviceNames(devices);

  useEffect(() => {
    if (!id) {
      setCurrent(null);
      setSpec(defaultSpec());
      setAssignments([]);
      setSelectedDevices([]);
      return;
    }
    let active = true;
    setBusy(true);
    setError(null);
    void remote
      .policy(id)
      .then((policy) => {
        if (!active) return;
        setCurrent(policy);
        setSpec(policy.policy);
        setAssignments(policy.assignments ?? []);
        setSelectedDevices(
          (policy.assignments ?? [])
            .filter((item) => item.scope_type === 'DEVICE')
            .map((item) => item.scope_id),
        );
      })
      .catch((failure: unknown) => {
        if (active) setError(failure);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  function update<K extends keyof RemotePolicySpec>(key: K, value: RemotePolicySpec[K]) {
    setSpec((old) => ({ ...old, [key]: value }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !canWrite) return;
    setBusy(true);
    setError(null);
    try {
      const changed = current
        ? await remote.editPolicy(current.id, spec, current.etag, profile.csrf_token)
        : await remote.createPolicy(spec, profile.csrf_token);
      setCurrent(changed);
      setId(changed.id);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function assign() {
    if (!profile || !current || !canAssign) return;
    setBusy(true);
    setError(null);
    try {
      const retained = assignments.filter((item) => item.scope_type === 'GROUP');
      const existing = assignments.filter((item) => item.scope_type === 'DEVICE');
      const next: RemoteAssignment[] = [
        ...retained,
        ...selectedDevices.map(
          (deviceId) =>
            existing.find((item) => item.scope_id === deviceId) ?? {
              scope_type: 'DEVICE' as const,
              scope_id: deviceId,
              valid_from: current.policy.valid_from,
              valid_until: current.policy.valid_until,
            },
        ),
      ];
      const changed = await remote.assignPolicy(current.id, next, current.etag, profile.csrf_token);
      const reloaded = await remote.policy(changed.id);
      setCurrent(reloaded);
      setAssignments(reloaded.assignments ?? []);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function transition(action: 'publish' | 'resume' | 'pause' | 'revoke') {
    if (!profile || !current || !canActivate) return;
    setBusy(true);
    setError(null);
    try {
      const changed = await remote.transitionPolicy(
        current.id,
        action,
        reason,
        current.etag,
        profile.csrf_token,
      );
      setCurrent(changed);
      setReason('');
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gps-policy-editor" aria-labelledby="policy-editor-title">
      <h3 id="policy-editor-title">Configuración remota</h3>
      <label>
        Política
        <select value={id} onChange={(event) => setId(event.target.value)}>
          <option value="">Nueva política</option>
          {policies.map((item) => (
            <option key={item.id} value={item.id}>
              {item.policy.name} · {item.state} · rev. {item.revision}
              {policies.filter((other) => other.policy.name === item.policy.name).length > 1
                ? ` · ${item.id.replaceAll('-', '').slice(-6)}`
                : ''}
            </option>
          ))}
        </select>
      </label>
      {canWrite ? (
        <form onSubmit={(event) => void save(event)}>
          <label>
            Nombre
            <input
              value={spec.name}
              maxLength={120}
              required
              onChange={(event) => update('name', event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Días laborales</legend>
            {names.map((name, index) => (
              <label key={name} className="day-checkbox">
                <input
                  type="checkbox"
                  checked={spec.days_iso.includes(index + 1)}
                  onChange={(event) =>
                    update(
                      'days_iso',
                      event.target.checked
                        ? [...spec.days_iso, index + 1].sort()
                        : spec.days_iso.filter((day) => day !== index + 1),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </fieldset>
          <div className="gps-form-grid">
            <label>
              Inicio local
              <input
                type="time"
                required
                value={spec.start_local}
                onChange={(event) => update('start_local', event.target.value)}
              />
            </label>
            <label>
              Fin local
              <input
                type="time"
                required
                value={spec.end_local}
                onChange={(event) => update('end_local', event.target.value)}
              />
            </label>
            <label>
              Zona horaria IANA
              <input
                required
                value={spec.time_zone}
                onChange={(event) => update('time_zone', event.target.value)}
              />
            </label>
            <label>
              GPS cada (s)
              <input
                type="number"
                min={30}
                max={300}
                required
                value={spec.capture_interval_s}
                onChange={(event) => update('capture_interval_s', Number(event.target.value))}
              />
            </label>
            <label>
              Sincronización cada (s)
              <input
                type="number"
                min={60}
                max={900}
                required
                value={spec.sync_interval_s}
                onChange={(event) => update('sync_interval_s', Number(event.target.value))}
              />
            </label>
            <label>
              Salud cada (s)
              <input
                type="number"
                min={60}
                max={3600}
                required
                value={spec.health_interval_s}
                onChange={(event) => update('health_interval_s', Number(event.target.value))}
              />
            </label>
            <label>
              Umbral sin comunicación (s)
              <input
                type="number"
                min={300}
                max={7200}
                required
                value={spec.heartbeat_missing_after_s}
                onChange={(event) =>
                  update('heartbeat_missing_after_s', Number(event.target.value))
                }
              />
            </label>
            <label>
              Vigente desde
              <input
                type="datetime-local"
                required
                value={localInput(spec.valid_from)}
                onChange={(event) => {
                  if (event.target.value)
                    update('valid_from', new Date(event.target.value).toISOString());
                }}
              />
            </label>
            <label>
              Vigente hasta
              <input
                type="datetime-local"
                required
                value={localInput(spec.valid_until)}
                onChange={(event) => {
                  if (event.target.value)
                    update('valid_until', new Date(event.target.value).toISOString());
                }}
              />
            </label>
          </div>
          <button disabled={busy || !spec.days_iso.length} type="submit">
            {current ? 'Guardar nueva versión de borrador' : 'Crear borrador'}
          </button>
        </form>
      ) : (
        <p>Sin permiso para editar políticas.</p>
      )}
      {current && (
        <div className="gps-assignment-panel">
          <h4>Asignaciones de borrador</h4>
          {assignments.some((item) => item.scope_type === 'GROUP') && (
            <p>Las asignaciones a grupos existentes se conservan al actualizar dispositivos.</p>
          )}
          {devices.map((device) => (
            <label key={device.device_id} className="day-checkbox">
              <input
                type="checkbox"
                checked={selectedDevices.includes(device.device_id)}
                disabled={!canAssign || busy}
                onChange={(event) =>
                  setSelectedDevices((old) =>
                    event.target.checked
                      ? [...old, device.device_id]
                      : old.filter((value) => value !== device.device_id),
                  )
                }
              />
              {deviceLabels.get(device.device_id)} · {device.tenant_id}
            </label>
          ))}
          <button type="button" disabled={!canAssign || busy} onClick={() => void assign()}>
            Guardar asignaciones
          </button>
          <p>
            Quitar todos los dispositivos revoca sus asignaciones de borrador; la versión activa
            cambia al publicar.
          </p>
          <label>
            Motivo de publicación o cambio de estado
            <input
              value={reason}
              minLength={8}
              maxLength={240}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="enrollment-actions">
            {(['publish', 'resume', 'pause', 'revoke'] as const)
              .filter((action) =>
                action === 'publish'
                  ? current.state === 'DRAFT' || current.state === 'ACTIVE'
                  : action === 'resume'
                    ? current.state === 'PAUSED'
                    : action === 'pause'
                      ? current.state === 'ACTIVE'
                      : current.state !== 'REVOKED',
              )
              .map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={!canActivate || busy || reason.trim().length < 8}
                  onClick={() => void transition(action)}
                >
                  {
                    { publish: 'Publicar', resume: 'Reanudar', pause: 'Pausar', revoke: 'Revocar' }[
                      action
                    ]
                  }
                </button>
              ))}
          </div>
          <p>
            ETag: <code>{current.etag}</code> · Estado: {current.state} · Revisión:{' '}
            {current.revision}
          </p>
        </div>
      )}
      {busy && <p role="status">Guardando o cargando…</p>}
      {error !== null && <p role="alert">{errorText(error)}</p>}
    </section>
  );
}
