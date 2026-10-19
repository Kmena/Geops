import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  devices,
  fixtureCapabilities,
  groups,
  historicalExperiment,
  policies,
  sessions,
  type Capability,
  type DeviceFixture,
  type Evidence,
  type HealthFact,
  type PolicyFixture,
  type SessionFixture,
} from './fixtures.js';
import {
  assignedDevices,
  assignmentConflicts,
  can,
  days,
  statusLabel,
  validateDraft,
} from './model.js';
import './gps.css';
import { GpsLiveWorkspace } from './GpsLiveWorkspace.js';

export type GpsSection = 'policies' | 'devices' | 'sessions' | 'executive';
type Scenario = 'normal' | 'empty' | 'loading' | 'error';
type AccessMode = 'operator' | 'reader' | 'denied';

const links: Array<{ path: string; label: string; section: GpsSection }> = [
  { path: '/gps/policies', label: 'Políticas', section: 'policies' },
  { path: '/gps/devices', label: 'Dispositivos', section: 'devices' },
  { path: '/gps/sessions', label: 'Sesiones', section: 'sessions' },
  { path: '/gps/executive', label: 'Resumen ejecutivo', section: 'executive' },
];

function permissions(mode: AccessMode): Capability[] {
  if (mode === 'operator') return fixtureCapabilities;
  if (mode === 'reader') return ['gps.policy.read', 'gps.session.read'];
  return [];
}

function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
}) {
  return <span className={`gps-tag gps-tag--${tone}`}>{children}</span>;
}

function SourceTag({ evidence }: { evidence: Evidence }) {
  return (
    <Tag tone={evidence === 'OBSERVADO' ? 'good' : evidence === 'INFERIDO' ? 'warn' : 'neutral'}>
      {evidence === 'OBSERVADO'
        ? 'Observado'
        : evidence === 'INFERIDO'
          ? 'Inferido'
          : 'Desconocido'}
    </Tag>
  );
}

function DataState({ scenario, noun }: { scenario: Scenario; noun: string }) {
  if (scenario === 'loading')
    return (
      <div role="status" className="gps-state gps-loading">
        <span className="gps-skeleton" />
        <span className="gps-skeleton short" />
        <p>Cargando {noun} de prueba…</p>
      </div>
    );
  if (scenario === 'error')
    return (
      <div role="alert" className="gps-state gps-state--error">
        <strong>No se pudo mostrar {noun}.</strong>
        <p>Selecciona «Datos de prueba» para volver a cargar esta vista sintética.</p>
      </div>
    );
  return (
    <div className="gps-state">
      <strong>No hay {noun} en este escenario.</strong>
      <p>
        La ausencia de registros no confirma que el dispositivo esté apagado o que una política haya
        fallado.
      </p>
    </div>
  );
}

function PageIntro({
  title,
  description,
  aside,
}: {
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <div className="gps-intro">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {aside}
    </div>
  );
}

function Fact<T>({
  label,
  fact,
  format = String,
}: {
  label: string;
  fact: HealthFact<T>;
  format?: (value: T) => string;
}) {
  return (
    <div className="gps-fact">
      <dt>{label}</dt>
      <dd>
        <strong>{fact.value === null ? 'Sin dato' : format(fact.value)}</strong>
        <SourceTag evidence={fact.evidence} />
        {fact.observedAt && <small>Última muestra: {fact.observedAt}</small>}
      </dd>
    </div>
  );
}

function AccessDenied({ permission }: { permission: string }) {
  return (
    <div role="status" className="gps-state gps-state--locked">
      <strong>Sin capacidad para esta vista.</strong>
      <p>
        El fixture actual no incluye <code>{permission}</code>. El backend vuelve a verificar cada
        solicitud.
      </p>
    </div>
  );
}

function clonePolicy(base: PolicyFixture, fresh: boolean): PolicyFixture {
  return {
    ...base,
    id: fresh ? 'BORRADOR-LOCAL' : base.id,
    name: fresh ? '' : base.name,
    state: 'DRAFT',
    revision: fresh ? 0 : base.revision + 1,
    daysIso: [...base.daysIso],
    deviceIds: fresh ? [] : [...base.deviceIds],
    groupIds: fresh ? [] : [...base.groupIds],
    history: fresh ? [] : [...base.history],
  };
}

function PolicyEditor({
  initial,
  all,
  capabilities,
  onClose,
}: {
  initial: PolicyFixture;
  all: readonly PolicyFixture[];
  capabilities: readonly Capability[];
  onClose(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [reviewed, setReviewed] = useState(false);
  const [notice, setNotice] = useState('');
  const errors = validateDraft(draft);
  const conflicts = assignmentConflicts(draft, all);
  const update = <K extends keyof PolicyFixture>(key: K, value: PolicyFixture[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setReviewed(false);
    setNotice('');
  };
  const assignAllowed = can(capabilities, 'gps.policy.assign');
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReviewed(true);
    setNotice(
      errors.length || conflicts.length
        ? 'Corrige los puntos señalados antes de solicitar publicación.'
        : 'Borrador revisado en memoria. No se ha guardado ni publicado en el servidor.',
    );
  }
  return (
    <section className="gps-panel gps-editor" aria-labelledby="draft-title">
      <div className="gps-panel-head">
        <div>
          <h2 id="draft-title">
            {initial.revision === 0 ? 'Crear política' : `Nueva versión · v${initial.revision}`}
          </h2>
          <p>
            Edición local. La publicación requiere `If-Match`, `Idempotency-Key` y validación
            transaccional del backend.
          </p>
        </div>
        <button type="button" className="gps-button ghost" onClick={onClose}>
          Cerrar borrador
        </button>
      </div>
      <form onSubmit={review} noValidate>
        <div className="gps-form-grid">
          <label className="gps-field wide">
            Nombre de política
            <input
              value={draft.name}
              maxLength={120}
              onChange={(e) => update('name', e.target.value)}
              required
            />
          </label>
          <fieldset className="gps-field wide gps-days">
            <legend>Días de inicio · ISO</legend>
            {days.map((day) => (
              <label key={day.id}>
                <input
                  type="checkbox"
                  checked={draft.daysIso.includes(day.id)}
                  onChange={(e) =>
                    update(
                      'daysIso',
                      e.target.checked
                        ? [...draft.daysIso, day.id].sort()
                        : draft.daysIso.filter((id) => id !== day.id),
                    )
                  }
                />
                {day.label}
              </label>
            ))}
          </fieldset>
          <label className="gps-field">
            Inicio local
            <input
              type="time"
              value={draft.startLocal}
              onChange={(e) => update('startLocal', e.target.value)}
            />
          </label>
          <label className="gps-field">
            Fin local
            <input
              type="time"
              value={draft.endLocal}
              onChange={(e) => update('endLocal', e.target.value)}
            />
          </label>
          <label className="gps-field wide">
            Zona horaria IANA
            <input
              list="gps-zones"
              value={draft.timeZone}
              onChange={(e) => update('timeZone', e.target.value)}
            />
            <datalist id="gps-zones">
              <option value="America/Guatemala" />
              <option value="America/Mexico_City" />
              <option value="America/New_York" />
              <option value="UTC" />
            </datalist>
            <small>
              La zona del teléfono no cambia este horario. Una ventana que cruza medianoche conserva
              el día de inicio.
            </small>
          </label>
          <label className="gps-field">
            GPS · segundos
            <input
              type="number"
              min="30"
              max="300"
              value={draft.captureIntervalS}
              onChange={(e) => update('captureIntervalS', Number(e.target.value))}
            />
          </label>
          <label className="gps-field">
            Sincronización · segundos
            <input
              type="number"
              min="60"
              max="900"
              value={draft.syncIntervalS}
              onChange={(e) => update('syncIntervalS', Number(e.target.value))}
            />
          </label>
          <label className="gps-field">
            Salud · segundos
            <input
              type="number"
              min="60"
              max="3600"
              value={draft.healthIntervalS}
              onChange={(e) => update('healthIntervalS', Number(e.target.value))}
            />
          </label>
          <label className="gps-field">
            Alerta por silencio · segundos
            <input
              type="number"
              min="300"
              max="7200"
              value={draft.heartbeatMissingAfterS}
              onChange={(e) => update('heartbeatMissingAfterS', Number(e.target.value))}
            />
          </label>
          <label className="gps-field">
            Vigente desde · UTC
            <input
              type="datetime-local"
              value={draft.validFrom}
              onChange={(e) => update('validFrom', e.target.value)}
            />
          </label>
          <label className="gps-field">
            Vigente hasta · UTC
            <input
              type="datetime-local"
              value={draft.validUntil}
              onChange={(e) => update('validUntil', e.target.value)}
            />
          </label>
        </div>
        <div className="gps-assignment">
          <div>
            <h3>Asignación</h3>
            <p>
              Dispositivo y grupo no tienen precedencia. Cualquier vigencia superpuesta para un
              equipo se rechaza.
            </p>
          </div>
          <div className="gps-assignment-grid">
            <fieldset disabled={!assignAllowed}>
              <legend>Dispositivos</legend>
              {devices.map((device) => (
                <label key={device.id}>
                  <input
                    type="checkbox"
                    checked={draft.deviceIds.includes(device.id)}
                    onChange={(e) =>
                      update(
                        'deviceIds',
                        e.target.checked
                          ? [...draft.deviceIds, device.id]
                          : draft.deviceIds.filter((id) => id !== device.id),
                      )
                    }
                  />
                  {device.label}
                </label>
              ))}
            </fieldset>
            <fieldset disabled={!assignAllowed}>
              <legend>Grupos GPS</legend>
              {groups.map((group) => (
                <label key={group.id}>
                  <input
                    type="checkbox"
                    checked={draft.groupIds.includes(group.id)}
                    onChange={(e) =>
                      update(
                        'groupIds',
                        e.target.checked
                          ? [...draft.groupIds, group.id]
                          : draft.groupIds.filter((id) => id !== group.id),
                      )
                    }
                  />
                  {group.name}
                </label>
              ))}
            </fieldset>
          </div>
          {!assignAllowed && (
            <p className="gps-helper">Falta `gps.policy.assign` en el fixture de acceso.</p>
          )}
        </div>
        <div className="gps-review" aria-live="polite">
          <h3>Vista de impacto</h3>
          <p>
            {assignedDevices(draft).length} equipos sintéticos alcanzados · revisión local v
            {draft.revision || 1}
          </p>
          {conflicts.length > 0 ? (
            <div className="gps-alert bad">
              <strong>Conflicto de vigencia y asignación</strong>
              <p>
                {conflicts.join(', ')} ya tiene una política activa en ese intervalo. El servidor
                decidirá el conflicto definitivo con locks y exclusión temporal.
              </p>
            </div>
          ) : (
            <p className="gps-helper">
              Sin solape detectado en fixtures. Esto no sustituye la validación del servidor, DST ni
              `If-Match`.
            </p>
          )}
          {reviewed && errors.length > 0 && (
            <ul className="gps-errors" aria-label="Errores del borrador">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="gps-actions">
          <button type="submit" className="gps-button">
            Revisar borrador local
          </button>
          <button
            type="button"
            className="gps-button ghost"
            disabled
            title="Publicación real bloqueada hasta cerrar gates"
          >
            Publicar en servidor · bloqueado
          </button>
        </div>
        {notice && (
          <p role="status" className="gps-inline-status">
            {notice}
          </p>
        )}
      </form>
    </section>
  );
}

function PoliciesView({
  scenario,
  capabilities,
}: {
  scenario: Scenario;
  capabilities: readonly Capability[];
}) {
  const [selectedId, setSelectedId] = useState(policies[0]?.id ?? '');
  const [draft, setDraft] = useState<PolicyFixture | null>(null);
  const selected = policies.find((policy) => policy.id === selectedId) ?? policies[0];
  if (!can(capabilities, 'gps.policy.read')) return <AccessDenied permission="gps.policy.read" />;
  if (scenario !== 'normal') return <DataState scenario={scenario} noun="políticas GPS" />;
  return (
    <div className="gps-policy-layout">
      <section className="gps-panel gps-policy-list" aria-labelledby="policy-list-title">
        <div className="gps-panel-head">
          <h2 id="policy-list-title">Políticas</h2>
          <Tag>{policies.length} sintéticas</Tag>
        </div>
        <div className="gps-list-buttons">
          {policies.map((policy) => (
            <button
              key={policy.id}
              type="button"
              className={selectedId === policy.id ? 'selected' : ''}
              aria-current={selectedId === policy.id ? 'true' : undefined}
              onClick={() => {
                setSelectedId(policy.id);
                setDraft(null);
              }}
            >
              <span>
                <strong>{policy.name}</strong>
                <small>
                  {policy.id} · v{policy.revision}
                </small>
              </span>
              <Tag tone={policy.state === 'ACTIVE' ? 'good' : 'neutral'}>
                {statusLabel(policy.state)}
              </Tag>
            </button>
          ))}
        </div>
        {can(capabilities, 'gps.policy.write') ? (
          <button
            type="button"
            className="gps-button secondary gps-full"
            onClick={() => {
              if (policies[0]) setDraft(clonePolicy(policies[0], true));
            }}
          >
            Crear borrador local
          </button>
        ) : (
          <p className="gps-helper">La creación requiere `gps.policy.write`.</p>
        )}
      </section>
      <div className="gps-policy-detail">
        {draft ? (
          <PolicyEditor
            key={`${draft.id}-${draft.revision}`}
            initial={draft}
            all={policies}
            capabilities={capabilities}
            onClose={() => setDraft(null)}
          />
        ) : (
          selected && (
            <>
              <section className="gps-panel">
                <div className="gps-panel-head">
                  <div>
                    <h2>{selected.name}</h2>
                    <p>
                      {selected.id} · revisión publicada v{selected.revision}
                    </p>
                  </div>
                  <Tag tone="good">Publicada</Tag>
                </div>
                <dl className="gps-summary-grid">
                  <div>
                    <dt>Ventana local</dt>
                    <dd>
                      {selected.startLocal}–{selected.endLocal}
                    </dd>
                  </div>
                  <div>
                    <dt>Zona IANA</dt>
                    <dd>{selected.timeZone}</dd>
                  </div>
                  <div>
                    <dt>Días ISO</dt>
                    <dd>
                      {selected.daysIso
                        .map((id) => days.find((d) => d.id === id)?.label)
                        .join(' · ')}
                    </dd>
                  </div>
                  <div>
                    <dt>Vigencia UTC</dt>
                    <dd>
                      {selected.validFrom.replace('T', ' ')} →{' '}
                      {selected.validUntil.replace('T', ' ')}
                    </dd>
                  </div>
                  <div>
                    <dt>GPS / sincronización</dt>
                    <dd>
                      {selected.captureIntervalS} s / {selected.syncIntervalS} s
                    </dd>
                  </div>
                  <div>
                    <dt>Salud / silencio</dt>
                    <dd>
                      {selected.healthIntervalS} s / {selected.heartbeatMissingAfterS} s
                    </dd>
                  </div>
                </dl>
                <div className="gps-detail-footer">
                  <span>Ámbito: {assignedDevices(selected).join(', ') || 'Sin dispositivos'}</span>
                  {can(capabilities, 'gps.policy.write') && (
                    <button
                      type="button"
                      className="gps-button"
                      onClick={() => setDraft(clonePolicy(selected, false))}
                    >
                      Editar nueva versión local
                    </button>
                  )}
                </div>
              </section>
              <section className="gps-panel" aria-labelledby="history-title">
                <h2 id="history-title">Historial de versiones</h2>
                <ol className="gps-history">
                  {selected.history.map((entry) => (
                    <li key={entry.revision}>
                      <span className="gps-version">v{entry.revision}</span>
                      <div>
                        <strong>{entry.summary}</strong>
                        <small>
                          {entry.date} · {entry.state}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )
        )}
      </div>
    </div>
  );
}

function DeviceHealth({ device, onClose }: { device: DeviceFixture; onClose(): void }) {
  const [reason, setReason] = useState('');
  const [accessReason, setAccessReason] = useState<string | null>(null);
  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length >= 8 && trimmed.length <= 240) setAccessReason(trimmed);
  }
  return (
    <section className="gps-panel gps-health" aria-labelledby="health-title">
      <div className="gps-panel-head">
        <div>
          <h2 id="health-title">Salud · {device.label}</h2>
          <p>Último estado conocido del fixture. Cada campo conserva su fuente.</p>
        </div>
        <button type="button" className="gps-button ghost" onClick={onClose}>
          Cerrar detalle
        </button>
      </div>
      {!accessReason ? (
        <form className="gps-reason" onSubmit={open}>
          <label>
            Motivo de consulta
            <input
              value={reason}
              minLength={8}
              maxLength={240}
              required
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej. revisar interrupción reportada"
            />
          </label>
          <p>
            El contrato exige motivo y auditoría en el servidor. Aquí solo se registra en memoria de
            esta maqueta.
          </p>
          <button type="submit" className="gps-button">
            Consultar fixture de salud
          </button>
        </form>
      ) : (
        <>
          <p role="status" className="gps-inline-status">
            Consulta sintética abierta con motivo válido. No se envió ni se auditó en servidor.
          </p>
          <dl className="gps-health-grid">
            <Fact label="Última comunicación" fact={device.lastCommunication} />
            <Fact label="GPS" fact={device.gps} />
            <Fact label="Batería" fact={device.battery} format={(n) => `${n}%`} />
            <Fact label="Carga" fact={device.charging} />
            <Fact label="Ahorro de energía" fact={device.powerSave} />
            <Fact label="Conectividad" fact={device.connectivity} />
          </dl>
          {device.possibleBatteryDepletion && (
            <div className="gps-alert warn">
              <strong>Posible agotamiento de batería</strong>
              <p>
                La última muestra fue de 2% y después hubo silencio. La causa no está confirmada.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function DevicesView({
  scenario,
  capabilities,
}: {
  scenario: Scenario;
  capabilities: readonly Capability[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!can(capabilities, 'gps.session.read')) return <AccessDenied permission="gps.session.read" />;
  if (scenario !== 'normal') return <DataState scenario={scenario} noun="dispositivos GPS" />;
  const detail = devices.find((device) => device.id === selected);
  return (
    <div className="gps-stack">
      <section className="gps-panel" aria-labelledby="devices-title">
        <div className="gps-panel-head">
          <div>
            <h2 id="devices-title">Monitoreo de dispositivos</h2>
            <p>Identificadores inventados; sin coordenadas ni datos de teléfonos físicos.</p>
          </div>
          <Tag tone="info">{devices.length} fixtures</Tag>
        </div>
        <div className="gps-device-list">
          {devices.map((device) => (
            <article key={device.id} className="gps-device-row">
              <div>
                <strong>{device.label}</strong>
                <small>
                  {device.id} · {device.policyId ?? 'Sin política'}
                </small>
              </div>
              <div className="gps-device-meta">
                <span>
                  Aplicada:{' '}
                  {device.appliedRevision === null ? 'Desconocida' : `v${device.appliedRevision}`}
                </span>
                <span>
                  Publicada:{' '}
                  {device.publishedRevision === null ? '—' : `v${device.publishedRevision}`}
                </span>
              </div>
              <Tag
                tone={
                  device.state === 'ONLINE'
                    ? 'good'
                    : device.state === 'UNKNOWN'
                      ? 'neutral'
                      : 'warn'
                }
              >
                {statusLabel(device.state)}
              </Tag>
              <button
                type="button"
                className="gps-button secondary"
                aria-expanded={selected === device.id}
                onClick={() => setSelected(selected === device.id ? null : device.id)}
              >
                Ver salud
              </button>
            </article>
          ))}
        </div>
      </section>
      {detail && <DeviceHealth key={detail.id} device={detail} onClose={() => setSelected(null)} />}
      <p className="gps-footnote">
        «Sin comunicación» es una inferencia del servidor durante una ventana. Versión aplicada y
        muestras de salud son observaciones distintas; un dato ausente permanece desconocido.
      </p>
    </div>
  );
}

function SessionRow({ session }: { session: SessionFixture }) {
  const effective = session.effectiveStart !== null;
  return (
    <article className="gps-session-row">
      <div className="gps-session-top">
        <div>
          <strong>{session.deviceId}</strong>
          <span>{session.window}</span>
        </div>
        <Tag
          tone={
            session.state === 'MISSED_START'
              ? 'bad'
              : session.state === 'PENDING'
                ? 'neutral'
                : session.state === 'INTERRUPTED'
                  ? 'warn'
                  : 'good'
          }
        >
          {statusLabel(session.state)}
        </Tag>
      </div>
      <dl className="gps-session-data">
        <div>
          <dt>Programada</dt>
          <dd>
            {session.scheduledStart}–{session.scheduledEnd}
          </dd>
        </div>
        <div>
          <dt>Inicio efectivo</dt>
          <dd>{effective ? session.effectiveStart : 'No confirmado'}</dd>
        </div>
        <div>
          <dt>Fin efectivo</dt>
          <dd>{session.effectiveEnd ?? (effective ? 'Sin evento de fin' : 'No confirmado')}</dd>
        </div>
        <div>
          <dt>Eventos pendientes</dt>
          <dd>{session.pendingEvents}</dd>
        </div>
        <div>
          <dt>Sincronización</dt>
          <dd>{session.sync}</dd>
        </div>
      </dl>
      <div className="gps-session-footer">
        <SourceTag evidence={session.evidence} />
        {session.interruption && <span>{session.interruption}</span>}
      </div>
    </article>
  );
}

function SessionsView({
  scenario,
  capabilities,
}: {
  scenario: Scenario;
  capabilities: readonly Capability[];
}) {
  const [filter, setFilter] = useState('all');
  if (!can(capabilities, 'gps.session.read')) return <AccessDenied permission="gps.session.read" />;
  if (scenario !== 'normal') return <DataState scenario={scenario} noun="sesiones GPS" />;
  const shown = sessions.filter((session) => filter === 'all' || session.deviceId === filter);
  return (
    <section className="gps-panel">
      <div className="gps-panel-head">
        <div>
          <h2>Ventanas y sesiones</h2>
          <p>Una ventana programada no crea por sí misma una sesión efectiva.</p>
        </div>
        <label className="gps-compact-field">
          Equipo
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Todos</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="gps-session-list">
        {shown.length ? (
          shown.map((session) => <SessionRow key={session.id} session={session} />)
        ) : (
          <DataState scenario="empty" noun="sesiones para este filtro" />
        )}
      </div>
      <p className="gps-footnote">
        MISSED_START es diagnóstico. Un evento pendiente no recibe ACK hasta persistirse; un fin
        ausente no se inventa.
      </p>
    </section>
  );
}

function ExecutiveView({ scenario }: { scenario: Scenario }) {
  if (scenario !== 'normal') return <DataState scenario={scenario} noun="resumen ejecutivo" />;
  return (
    <div className="gps-stack">
      <section className="gps-panel gps-executive-lead">
        <h2>Preparación de la operación</h2>
        <p>
          Esta vista comunica readiness del producto. No mide productividad, asistencia ni desempeño
          de personas.
        </p>
        <div className="gps-readiness">
          <div>
            <strong>25</strong>
            <span>teléfonos previstos</span>
          </div>
          <div>
            <strong>0</strong>
            <span>teléfonos validados para GPS real</span>
          </div>
          <div>
            <strong>W1-D</strong>
            <span>interfaz con fixtures</span>
          </div>
        </div>
      </section>
      <section className="gps-panel" aria-labelledby="gates-title">
        <div className="gps-panel-head">
          <h2 id="gates-title">Gates de integración</h2>
          <Tag tone="warn">W1-E pendiente</Tag>
        </div>
        <ul className="gps-gates">
          <li>
            <span>Identidad y configuración PoP reales</span>
            <Tag tone="warn">Pendiente</Tag>
          </li>
          <li>
            <span>Concesiones de tenant y capacidades operativas</span>
            <Tag tone="warn">Pendiente</Tag>
          </li>
          <li>
            <span>Scheduler, retención y backups</span>
            <Tag tone="warn">Pendiente</Tag>
          </li>
          <li>
            <span>Seguridad independiente y Android físico</span>
            <Tag tone="warn">Pendiente</Tag>
          </li>
        </ul>
      </section>
      <section className="gps-panel" aria-labelledby="experiment-title">
        <div className="gps-panel-head">
          <h2 id="experiment-title">Referencia histórica agregada</h2>
          <Tag>Experimento · no operativo</Tag>
        </div>
        <p>{historicalExperiment.note}</p>
        <dl className="gps-experiment">
          <div>
            <dt>Posiciones</dt>
            <dd>{historicalExperiment.positions}</dd>
          </div>
          <div>
            <dt>Sesiones inferidas</dt>
            <dd>{historicalExperiment.inferredSessions}</dd>
          </div>
          <div>
            <dt>Intervalos en 60 ± 15 s</dt>
            <dd>{historicalExperiment.cadenceWithinTolerance}</dd>
          </div>
          <div>
            <dt>Sincronizaciones tardías</dt>
            <dd>{historicalExperiment.lateSyncs}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function GpsWorkspace({
  section,
  initialMode = 'live',
}: {
  section: GpsSection;
  initialMode?: 'live' | 'preview';
}) {
  const [mode, setMode] = useState<'live' | 'preview'>(initialMode);
  const [access, setAccess] = useState<AccessMode>('operator');
  const [scenario, setScenario] = useState<Scenario>('normal');
  const capabilities = permissions(access);
  const titles: Record<GpsSection, [string, string]> = {
    policies: [
      'Políticas GPS',
      'Configura horarios y versiones en una vista previa local. Ningún cambio llega a dispositivos.',
    ],
    devices: ['Dispositivos', 'Estado técnico y telemetría con fuente explícita para cada dato.'],
    sessions: ['Sesiones', 'Distingue calendario, eventos efectivos y diagnósticos pendientes.'],
    executive: [
      'Resumen ejecutivo',
      'Decisiones de preparación y evidencia agregada, separadas de la operación diaria.',
    ],
  };
  return (
    <div className="gps-workspace">
      <fieldset className="gps-live-toolbar" aria-label="Fuente de datos GPS">
        <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>
          Backend sintético
        </button>
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
          Vista previa con fixtures
        </button>
      </fieldset>
      {mode === 'live' ? (
        <GpsLiveWorkspace section={section} />
      ) : (
        <>
          <div className="gps-banner" role="note">
            <strong>W1-D · datos sintéticos</strong>
            <span>
              Interfaz de preparación. Sin GPS real, edición de servidor ni conexión a teléfonos.
            </span>
          </div>
          <PageIntro title={titles[section][0]} description={titles[section][1]} />
          <nav className="gps-tabs" aria-label="Administración GPS">
            {links.map((link) => (
              <NavLink
                key={link.path}
                to={link.path}
                aria-current={section === link.section ? 'page' : undefined}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="gps-toolbar">
            <div>
              <strong>Escenarios de prueba</strong>
              <span>Controles de la maqueta; no son permisos reales.</span>
            </div>
            <label>
              Acceso simulado
              <select value={access} onChange={(e) => setAccess(e.target.value as AccessMode)}>
                <option value="operator">Operación local</option>
                <option value="reader">Solo lectura</option>
                <option value="denied">Sin capacidad GPS</option>
              </select>
            </label>
            <label>
              Estado de vista
              <select value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)}>
                <option value="normal">Datos de prueba</option>
                <option value="empty">Vacío</option>
                <option value="loading">Carga</option>
                <option value="error">Error</option>
              </select>
            </label>
          </div>
          {section === 'policies' && (
            <PoliciesView scenario={scenario} capabilities={capabilities} />
          )}
          {section === 'devices' && <DevicesView scenario={scenario} capabilities={capabilities} />}
          {section === 'sessions' && (
            <SessionsView scenario={scenario} capabilities={capabilities} />
          )}
          {section === 'executive' && <ExecutiveView scenario={scenario} />}
        </>
      )}
    </div>
  );
}
