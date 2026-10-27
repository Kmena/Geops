import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiClientError,
  type CatalogRoute,
  type AgentDeviceCandidate,
  type AgentIdentity,
  type AgentResponsibility,
  type ScheduleAgent,
  type ScheduleAssignment,
  type ScheduleRule,
} from './api/client.js';
import { useAuth } from './auth.js';
import { RouteMap } from './RouteMap.js';

const iso = (date: Date) => date.toISOString().slice(0, 10);
const shift = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
};
const moveMonth = (value: string, months: number) => {
  const date = new Date(`${value}T12:00:00Z`);
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return iso(first);
};
const bounds = (anchor: string, mode: 'week' | 'month') => {
  const day = new Date(`${anchor}T12:00:00Z`);
  if (mode === 'week') {
    const from = shift(anchor, -((day.getUTCDay() + 6) % 7));
    return { from, to: shift(from, 6) };
  }
  return {
    from: iso(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))),
    to: iso(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0))),
  };
};
const dates = (from: string, to: string) => {
  const result: string[] = [];
  for (let date = from; date <= to; date = shift(date, 1)) result.push(date);
  return result;
};
const todayInZone = (zone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
};
const message = (error: unknown) => {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'No tienes permiso para administrar el calendario.';
    if (error.status === 412 || error.status === 428)
      return 'El registro cambió. Actualiza la vista antes de guardar.';
    if (error.code === 'overlapping_assignment')
      return 'El agente ya tiene una ruta en ese horario.';
    if (error.status === 409) return 'El código o el horario entra en conflicto con otro registro.';
    if (error.status === 422) return 'Revisa fechas, horario, zona horaria y campos obligatorios.';
  }
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
};

export function VisitSchedule() {
  const { profile } = useAuth();
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [agents, setAgents] = useState<ScheduleAgent[]>([]);
  const [routes, setRoutes] = useState<CatalogRoute[]>([]);
  const [rules, setRules] = useState<ScheduleRule[]>([]);
  const [ruleDetail, setRuleDetail] = useState<ScheduleRule | null>(null);
  const [assignments, setAssignments] = useState<ScheduleAssignment[]>([]);
  const [anchor, setAnchor] = useState(() => {
    const saved = window.sessionStorage.getItem('geops-schedule-anchor');
    return saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : iso(new Date());
  });
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [agentFilter, setAgentFilter] = useState('');
  const [routeFilter, setRouteFilter] = useState('');
  const [selected, setSelected] = useState<ScheduleAssignment | null>(null);
  const [agentCode, setAgentCode] = useState('');
  const [agentName, setAgentName] = useState('');
  const [registrationDevice, setRegistrationDevice] = useState('');
  const [registrationResponsible, setRegistrationResponsible] = useState('');
  const [deviceCandidates, setDeviceCandidates] = useState<AgentDeviceCandidate[]>([]);
  const [deviceAccess, setDeviceAccess] = useState(false);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [responsibilityHistory, setResponsibilityHistory] = useState<AgentResponsibility[]>([]);
  const [responsibleName, setResponsibleName] = useState('');
  const [responsibleReason, setResponsibleReason] = useState('');
  const [reconciliationDevice, setReconciliationDevice] = useState('');
  const [reconciliationReason, setReconciliationReason] = useState('');
  const [agentEdit, setAgentEdit] = useState('');
  const [agentEditName, setAgentEditName] = useState('');
  const [assignmentAgent, setAssignmentAgent] = useState('');
  const [assignmentRoute, setAssignmentRoute] = useState('');
  const [assignmentDate, setAssignmentDate] = useState(() => iso(new Date()));
  const [assignmentStart, setAssignmentStart] = useState('08:00');
  const [assignmentEnd, setAssignmentEnd] = useState('10:00');
  const [timeZone, setTimeZone] = useState('America/Guatemala');
  const [extraordinary, setExtraordinary] = useState(false);
  const [ruleDays, setRuleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [ruleEnd, setRuleEnd] = useState('');
  const [ruleId, setRuleId] = useState('');
  const [exceptionDate, setExceptionDate] = useState(() => iso(new Date()));
  const [exceptionAction, setExceptionAction] = useState<'SKIP' | 'CANCEL' | 'REPLACE'>('SKIP');
  const [replacementRoute, setReplacementRoute] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const range = useMemo(() => bounds(anchor, mode), [anchor, mode]);
  useEffect(() => {
    window.sessionStorage.setItem('geops-schedule-anchor', anchor);
  }, [anchor]);
  const canRead = capabilities.includes('visit.schedule.read');
  const canWrite = capabilities.includes('visit.schedule.write');
  const csrf = profile?.csrf_token ?? '';
  const published = routes.filter(
    (route) => route.state === 'ACTIVE' && route.published_revision > 0,
  );

  const loadCatalog = useCallback(async () => {
    const [agentPage, firstRoutePage, rulePage] = await Promise.all([
      api.agents(),
      api.routes({ state: 'ACTIVE', limit: 100 }),
      api.scheduleRules(),
    ]);
    const allRoutes = [...firstRoutePage.items];
    let nextRouteCursor = firstRoutePage.next_cursor;
    while (nextRouteCursor) {
      const page = await api.routes({ state: 'ACTIVE', limit: 100, cursor: nextRouteCursor });
      allRoutes.push(...page.items);
      nextRouteCursor = page.next_cursor;
    }
    setAgents(agentPage.items);
    setRoutes(allRoutes);
    setRules(rulePage.items);
  }, []);
  const loadCalendar = useCallback(async () => {
    const items: ScheduleAssignment[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.calendar({
        ...range,
        ...(agentFilter ? { agent_id: agentFilter } : {}),
        ...(routeFilter ? { route_id: routeFilter } : {}),
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    setAssignments(items);
  }, [range, agentFilter, routeFilter]);
  const loadDevices = useCallback(async () => {
    try {
      const result = await api.availableAgentDevices();
      setDeviceCandidates(result.items);
      setDeviceAccess(true);
    } catch (failure) {
      setDeviceAccess(false);
      if (!(failure instanceof ApiClientError && failure.status === 403))
        setError(message(failure));
    }
  }, []);
  useEffect(() => {
    if (!profile) return;
    let live = true;
    void api
      .scheduleCapabilities()
      .then((result) => {
        if (live) setCapabilities(result.capabilities);
      })
      .catch((failure) => {
        if (live) setError(message(failure));
      });
    return () => {
      live = false;
    };
  }, [profile]);
  useEffect(() => {
    if (!canRead) return;
    void loadCatalog().catch((failure) => setError(message(failure)));
  }, [canRead, loadCatalog]);
  useEffect(() => {
    if (!canRead) return;
    void loadCalendar().catch((failure) => setError(message(failure)));
  }, [canRead, loadCalendar]);
  useEffect(() => {
    if (canRead) void loadDevices();
  }, [canRead, loadDevices]);
  const refresh = async () => {
    await Promise.all([
      loadCatalog(),
      loadCalendar(),
      loadDevices(),
      ruleId ? api.scheduleRule(ruleId).then(setRuleDetail) : Promise.resolve(),
    ]);
  };
  const inspectAgent = async (agentId: string) => {
    try {
      const [nextIdentity, history] = await Promise.all([
        api.agentIdentity(agentId),
        api.agentResponsibilityHistory(agentId),
      ]);
      setIdentity(nextIdentity);
      setResponsibilityHistory(history.items);
      setResponsibleName(nextIdentity.responsible?.person_name ?? '');
    } catch (failure) {
      setError(message(failure));
    }
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  const chooseAssignment = async (id: string) => {
    try {
      setSelected(await api.assignment(id));
    } catch (failure) {
      setError(message(failure));
    }
  };
  const createAgent = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const created = await api.registerAgentDevice(
        {
          device_id: registrationDevice,
          code: agentCode,
          name: agentName,
          ...(registrationResponsible.trim()
            ? { person_name: registrationResponsible.trim() }
            : {}),
          reason: 'Registro administrativo del dispositivo operativo',
        },
        csrf,
      );
      setAgentCode('');
      setAgentName('');
      setRegistrationDevice('');
      setRegistrationResponsible('');
      await inspectAgent(created.id);
      setNotice('Dispositivo registrado como agente operativo.');
    });
  };
  const changeResponsible = (event: FormEvent) => {
    event.preventDefault();
    if (!identity?.device) return;
    void perform(async () => {
      await api.setAgentResponsible(identity.agent.id, responsibleName, responsibleReason, csrf);
      await inspectAgent(identity.agent.id);
      setResponsibleReason('');
      setNotice('Responsable actualizado; el historial anterior se conserva.');
    });
  };
  const reconcileAgent = (event: FormEvent) => {
    event.preventDefault();
    if (!identity || !reconciliationDevice) return;
    void perform(async () => {
      await api.linkAgentDevice(
        identity.agent.id,
        reconciliationDevice,
        reconciliationReason,
        csrf,
      );
      await inspectAgent(identity.agent.id);
      setReconciliationDevice('');
      setReconciliationReason('');
      setNotice(
        'Dispositivo vinculado al agente existente; las asignaciones históricas se conservaron.',
      );
    });
  };
  const saveAgent = (event: FormEvent) => {
    event.preventDefault();
    const agent = agents.find((item) => item.id === agentEdit);
    if (!agent) return;
    void perform(async () => {
      await api.patchAgent(agent.id, agent.version, { name: agentEditName }, csrf);
      setNotice('Agente actualizado.');
    });
  };
  const createAssignment = (event: FormEvent) => {
    event.preventDefault();
    const route = published.find((item) => item.id === assignmentRoute);
    if (!route) return;
    void perform(async () => {
      const created = await api.createAssignment(
        {
          agent_id: assignmentAgent,
          route_id: route.id,
          route_revision: route.published_revision,
          local_date: assignmentDate,
          time_zone: timeZone,
          starts_local: assignmentStart,
          ends_local: assignmentEnd,
          reason: 'Planificación administrativa',
          origin: extraordinary ? 'EXTRAORDINARY' : 'MANUAL',
        },
        csrf,
      );
      setAnchor(assignmentDate);
      setSelected(created);
      setNotice('Asignación creada.');
    });
  };
  const createRule = (event: FormEvent) => {
    event.preventDefault();
    const route = published.find((item) => item.id === assignmentRoute);
    if (!route) return;
    void perform(async () => {
      const created = await api.createScheduleRule(
        {
          agent_id: assignmentAgent,
          route_id: route.id,
          route_revision: route.published_revision,
          start_date: assignmentDate,
          ...(ruleEnd ? { end_date: ruleEnd } : {}),
          days_iso: ruleDays,
          time_zone: timeZone,
          starts_local: assignmentStart,
          ends_local: assignmentEnd,
          reason: 'Planificación semanal',
        },
        csrf,
      );
      setRuleId(created.id);
      setNotice('Recurrencia creada. Materializa una ventana de hasta 31 días.');
      setRuleDetail(created);
    });
  };
  const saveException = (event: FormEvent) => {
    event.preventDefault();
    const rule = rules.find((item) => item.id === ruleId);
    const route = published.find((item) => item.id === replacementRoute);
    if (!rule) return;
    void perform(async () => {
      await api.putScheduleException(
        rule.id,
        exceptionDate,
        rule.version,
        {
          action: exceptionAction,
          reason: 'Excepción administrativa',
          ...(exceptionAction === 'REPLACE' && route
            ? {
                replacement_route_id: route.id,
                replacement_revision: route.published_revision,
              }
            : {}),
        },
        csrf,
      );
      setNotice('Excepción guardada. Materializa la ventana afectada para aplicarla.');
    });
  };
  const materialize = () => {
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) return;
    void perform(async () => {
      const from =
        range.from > todayInZone(rule.time_zone) ? range.from : todayInZone(rule.time_zone);
      const to = mode === 'month' && shift(from, 30) < range.to ? shift(from, 30) : range.to;
      const result = await api.materializeScheduleRule(rule.id, rule.version, from, to, csrf);
      setNotice(
        `Ventana materializada: ${result.generated} creadas, ${result.cancelled} canceladas, ${result.unchanged} sin cambios.`,
      );
    });
  };
  const currentRule =
    ruleDetail?.id === ruleId ? ruleDetail : rules.find((item) => item.id === ruleId);

  return (
    <div className="schedule-page">
      <h1>Dispositivos / agentes y calendario</h1>
      <p className="lead">
        El dispositivo es el agente operativo. La persona responsable puede cambiar sin alterar sus
        rutas ni visitas históricas.
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!canRead ? (
        <p>No tienes acceso al calendario o se están verificando los permisos.</p>
      ) : (
        <>
          <section className="panel schedule-section" aria-labelledby="agents-title">
            <h2 id="agents-title">Dispositivos / agentes</h2>
            <ul className="schedule-agent-list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <strong>
                    {agent.code} · {agent.name}
                  </strong>{' '}
                  <span>{agent.state === 'ACTIVE' ? 'Activo' : 'Inactivo'}</span>
                  {deviceAccess && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void inspectAgent(agent.id)}
                    >
                      Ver dispositivo y responsable
                    </button>
                  )}
                  {canWrite && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await api.patchAgent(
                            agent.id,
                            agent.version,
                            { state: agent.state === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
                            csrf,
                          );
                          setNotice('Estado del agente actualizado.');
                        })
                      }
                    >
                      {agent.state === 'ACTIVE' ? 'Desactivar' : 'Activar'}
                    </button>
                  )}
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => {
                        setAgentEdit(agent.id);
                        setAgentEditName(agent.name);
                      }}
                    >
                      Editar
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canWrite && !deviceAccess && (
              <p>
                Para registrar dispositivos como agentes se requieren los permisos de dispositivo.
              </p>
            )}
            {canWrite && deviceAccess && (
              <form onSubmit={createAgent} className="schedule-form">
                <label>
                  Dispositivo GEOPS existente
                  <select
                    required
                    value={registrationDevice}
                    onChange={(event) => setRegistrationDevice(event.target.value)}
                  >
                    <option value="">Selecciona un dispositivo autorizado</option>
                    {deviceCandidates.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.display_label} · {device.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Código operativo del dispositivo
                  <input
                    required
                    value={agentCode}
                    onChange={(event) => setAgentCode(event.target.value)}
                  />
                </label>
                <label>
                  Nombre visible del agente
                  <input
                    required
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                  />
                </label>
                <label>
                  Responsable actual (opcional)
                  <input
                    maxLength={160}
                    value={registrationResponsible}
                    onChange={(event) => setRegistrationResponsible(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Registrar dispositivo como agente
                </button>
              </form>
            )}
            {identity && deviceAccess && (
              <div className="panel" aria-live="polite">
                <h3>
                  {identity.agent.code} · {identity.agent.name}
                </h3>
                {identity.device ? (
                  <>
                    <p>
                      Dispositivo: {identity.device.display_label} ({identity.device.device_id}) ·{' '}
                      {identity.device.status}
                    </p>
                    <p>
                      MDM:{' '}
                      {identity.device.mdm_provider
                        ? `${identity.device.mdm_provider} · ${identity.device.mdm_device_id}`
                        : 'Sin vinculación MDM activa'}
                    </p>
                    <p>
                      Última comunicación:{' '}
                      {identity.device.last_communication_at
                        ? new Date(identity.device.last_communication_at).toLocaleString('es-GT')
                        : 'Sin evidencia'}
                    </p>
                    <p>Responsable actual: {identity.responsible?.person_name ?? 'Sin asignar'}</p>
                    <p>
                      Rutas en el período visible:{' '}
                      {assignments.filter((item) => item.agent_id === identity.agent.id).length}
                    </p>
                    {canWrite && (
                      <form onSubmit={changeResponsible} className="schedule-form">
                        <label>
                          Nuevo responsable
                          <input
                            required
                            maxLength={160}
                            value={responsibleName}
                            onChange={(event) => setResponsibleName(event.target.value)}
                          />
                        </label>
                        <label>
                          Motivo del cambio
                          <input
                            required
                            minLength={8}
                            maxLength={240}
                            value={responsibleReason}
                            onChange={(event) => setResponsibleReason(event.target.value)}
                          />
                        </label>
                        <button type="submit" disabled={busy}>
                          Guardar responsable
                        </button>
                      </form>
                    )}
                    <h4>Historial de responsables</h4>
                    <ul>
                      {responsibilityHistory.map((entry) => (
                        <li key={entry.id}>
                          {entry.person_name} · {new Date(entry.valid_from).toLocaleString('es-GT')}
                          {' — '}
                          {entry.valid_to
                            ? new Date(entry.valid_to).toLocaleString('es-GT')
                            : 'actual'}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <p>
                      Agente B30 sin dispositivo conciliado. Sus rutas y visitas históricas se
                      conservan.
                    </p>
                    {canWrite && (
                      <form onSubmit={reconcileAgent} className="schedule-form">
                        <label>
                          Dispositivo GEOPS existente
                          <select
                            required
                            value={reconciliationDevice}
                            onChange={(event) => setReconciliationDevice(event.target.value)}
                          >
                            <option value="">Selecciona un dispositivo</option>
                            {deviceCandidates.map((device) => (
                              <option key={device.id} value={device.id}>
                                {device.display_label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Motivo de conciliación
                          <input
                            required
                            minLength={8}
                            maxLength={240}
                            value={reconciliationReason}
                            onChange={(event) => setReconciliationReason(event.target.value)}
                          />
                        </label>
                        <button type="submit" disabled={busy}>
                          Vincular dispositivo
                        </button>
                      </form>
                    )}
                  </>
                )}
              </div>
            )}
            {canWrite && agentEdit && (
              <form onSubmit={saveAgent} className="schedule-form">
                <label>
                  Nombre a editar
                  <input
                    required
                    value={agentEditName}
                    onChange={(event) => setAgentEditName(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Guardar agente
                </button>
              </form>
            )}
          </section>
          {canWrite && (
            <section className="panel schedule-section" aria-labelledby="planning-title">
              <h2 id="planning-title">Planificación</h2>
              <div className="schedule-form">
                <label>
                  Dispositivo / agente
                  <select
                    value={assignmentAgent}
                    onChange={(event) => setAssignmentAgent(event.target.value)}
                  >
                    <option value="">Selecciona dispositivo / agente</option>
                    {agents
                      .filter((item) => item.state === 'ACTIVE')
                      .map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.code} · {agent.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Ruta publicada
                  <select
                    value={assignmentRoute}
                    onChange={(event) => setAssignmentRoute(event.target.value)}
                  >
                    <option value="">Selecciona ruta</option>
                    {published.map((route) => (
                      <option key={route.id} value={route.id}>
                        {route.code} · {route.name} · v{route.published_revision}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Fecha
                  <input
                    type="date"
                    required
                    value={assignmentDate}
                    onChange={(event) => setAssignmentDate(event.target.value)}
                  />
                </label>
                <label>
                  Inicio
                  <input
                    type="time"
                    required
                    value={assignmentStart}
                    onChange={(event) => setAssignmentStart(event.target.value)}
                  />
                </label>
                <label>
                  Fin
                  <input
                    type="time"
                    required
                    value={assignmentEnd}
                    onChange={(event) => setAssignmentEnd(event.target.value)}
                  />
                </label>
                <label>
                  Zona horaria
                  <input
                    required
                    value={timeZone}
                    onChange={(event) => setTimeZone(event.target.value)}
                  />
                </label>
              </div>
              <form onSubmit={createAssignment} className="schedule-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={extraordinary}
                    onChange={(event) => setExtraordinary(event.target.checked)}
                  />{' '}
                  Extraordinaria
                </label>
                <button type="submit" disabled={busy || !assignmentAgent || !assignmentRoute}>
                  Asignar ruta
                </button>
              </form>
              <form onSubmit={createRule} className="schedule-recurrence">
                <h3>Recurrencia semanal</h3>
                <div className="schedule-day-options">
                  {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((day, index) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        checked={ruleDays.includes(index + 1)}
                        onChange={(event) =>
                          setRuleDays((current) =>
                            event.target.checked
                              ? [...current, index + 1].sort()
                              : current.filter((value) => value !== index + 1),
                          )
                        }
                      />{' '}
                      {day}
                    </label>
                  ))}
                </div>
                <label>
                  Fecha final opcional
                  <input
                    type="date"
                    value={ruleEnd}
                    onChange={(event) => setRuleEnd(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || !assignmentAgent || !assignmentRoute || !ruleDays.length}
                >
                  Crear recurrencia
                </button>
              </form>
            </section>
          )}
          <section className="panel schedule-section" aria-labelledby="calendar-title">
            <h2 id="calendar-title">Calendario</h2>
            <div className="schedule-toolbar">
              <button
                type="button"
                onClick={() =>
                  setAnchor(mode === 'week' ? shift(anchor, -7) : moveMonth(anchor, -1))
                }
              >
                Anterior
              </button>
              <button type="button" onClick={() => setAnchor(iso(new Date()))}>
                Hoy
              </button>
              <button
                type="button"
                onClick={() => setAnchor(mode === 'week' ? shift(anchor, 7) : moveMonth(anchor, 1))}
              >
                Siguiente
              </button>
              <label>
                Vista
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as 'week' | 'month')}
                >
                  <option value="week">Semana</option>
                  <option value="month">Mes</option>
                </select>
              </label>
              <label>
                Filtrar agente
                <select
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                >
                  <option value="">Todos</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.code}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Filtrar ruta
                <select
                  value={routeFilter}
                  onChange={(event) => setRouteFilter(event.target.value)}
                >
                  <option value="">Todas</option>
                  {routes.map((route) => (
                    <option key={route.id} value={route.id}>
                      {route.code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              {range.from} al {range.to}. Varias rutas del mismo agente se muestran por separado.
            </p>
            <div className="schedule-grid">
              {dates(range.from, range.to).map((date) => (
                <section key={date} className="schedule-day" aria-label={date}>
                  <h3>
                    {new Intl.DateTimeFormat('es-GT', {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC',
                    }).format(new Date(`${date}T12:00:00Z`))}
                  </h3>
                  {assignments
                    .filter((item) => item.local_date === date)
                    .map((item) => (
                      <button
                        type="button"
                        className={`schedule-event ${item.state === 'CANCELLED' ? 'cancelled' : ''}`}
                        key={item.id}
                        onClick={() => void chooseAssignment(item.id)}
                      >
                        <strong>
                          {item.agent_code} · {item.route_code} v{item.route_revision}
                        </strong>
                        <span>
                          {new Date(item.starts_at).toLocaleTimeString('es-GT', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: item.time_zone,
                          })}
                          –
                          {new Date(item.ends_at).toLocaleTimeString('es-GT', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: item.time_zone,
                          })}
                        </span>
                        {item.state === 'CANCELLED' && <span>Cancelada</span>}
                      </button>
                    ))}
                </section>
              ))}
            </div>
          </section>
          {selected && (
            <section className="panel schedule-section" aria-labelledby="snapshot-title">
              <h2 id="snapshot-title">Snapshot de asignación</h2>
              <p>
                {selected.agent_name} · {selected.route_name} · versión publicada{' '}
                {selected.route_revision} · {selected.local_date} · {selected.state}
              </p>
              <p>
                Origen: {selected.origin}. Zona horaria: {selected.time_zone}. Huella:{' '}
                <code>{selected.snapshot_hash}</code>
              </p>
              <Link to={`/routes/${selected.route_id}`}>Abrir ruta actual</Link>
              <ol>
                {selected.visits?.map((visit) => (
                  <li key={visit.stop_id}>
                    {visit.client_name} · {visit.site_name} · geozona circular {visit.radius_m} m ·
                    permanencia mínima {Math.ceil(visit.min_dwell_effective_s / 60)} min ·{' '}
                    {visit.required ? 'obligatoria' : 'opcional'} · orden sugerido{' '}
                    {visit.suggested_order ?? 'libre'}
                  </li>
                ))}
              </ol>
              {selected.visits && <RouteMap stops={selected.visits} />}
              {canWrite && selected.state === 'PLANNED' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api.cancelAssignment(
                        selected.id,
                        selected.version,
                        'Cancelación administrativa',
                        csrf,
                      );
                      setSelected(await api.assignment(selected.id));
                      setNotice('Asignación cancelada.');
                    })
                  }
                >
                  Cancelar asignación
                </button>
              )}
            </section>
          )}
          <section className="panel schedule-section" aria-labelledby="rules-title">
            <h2 id="rules-title">Recurrencias y excepciones</h2>
            <label>
              Regla semanal
              <select
                value={ruleId}
                onChange={(event) => {
                  setRuleId(event.target.value);
                  setRuleDetail(null);
                  if (event.target.value)
                    void api
                      .scheduleRule(event.target.value)
                      .then(setRuleDetail)
                      .catch((failure) => setError(message(failure)));
                }}
              >
                <option value="">Selecciona regla</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {agents.find((agent) => agent.id === rule.agent_id)?.code} ·{' '}
                    {routes.find((route) => route.id === rule.route_id)?.code} · {rule.start_date} ·{' '}
                    {rule.state}
                  </option>
                ))}
              </select>
            </label>
            {currentRule && (
              <>
                <p>
                  Días ISO: {currentRule.days_iso.join(', ')}. Versión de ruta{' '}
                  {currentRule.route_revision}. Zona: {currentRule.time_zone}. Horario{' '}
                  {currentRule.starts_local.slice(0, 5)}–{currentRule.ends_local.slice(0, 5)}.
                </p>
                {canWrite && (
                  <div className="schedule-actions">
                    <button
                      type="button"
                      disabled={busy || range.to < todayInZone(currentRule.time_zone)}
                      onClick={materialize}
                    >
                      Materializar ventana visible
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await api.patchScheduleRule(
                            currentRule.id,
                            currentRule.version,
                            {
                              state: currentRule.state === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              reason: 'Cambio administrativo',
                            },
                            csrf,
                          );
                          setNotice('Estado de recurrencia actualizado.');
                        })
                      }
                    >
                      {currentRule.state === 'ACTIVE' ? 'Desactivar regla' : 'Activar regla'}
                    </button>
                  </div>
                )}
                <ul>
                  {currentRule.exceptions?.map((item) => (
                    <li key={item.local_date}>
                      {item.local_date}: {item.action}
                      {item.replacement_route_id ? ` · ruta ${item.replacement_route_id}` : ''}
                    </li>
                  ))}
                </ul>
                {canWrite && (
                  <form onSubmit={saveException} className="schedule-form">
                    <label>
                      Fecha de excepción
                      <input
                        required
                        type="date"
                        value={exceptionDate}
                        onChange={(event) => setExceptionDate(event.target.value)}
                      />
                    </label>
                    <label>
                      Acción
                      <select
                        value={exceptionAction}
                        onChange={(event) =>
                          setExceptionAction(event.target.value as 'SKIP' | 'CANCEL' | 'REPLACE')
                        }
                      >
                        <option value="SKIP">Omitir día</option>
                        <option value="CANCEL">Cancelar ocurrencia</option>
                        <option value="REPLACE">Reemplazar ruta</option>
                      </select>
                    </label>
                    {exceptionAction === 'REPLACE' && (
                      <label>
                        Ruta de reemplazo
                        <select
                          required
                          value={replacementRoute}
                          onChange={(event) => setReplacementRoute(event.target.value)}
                        >
                          <option value="">Selecciona ruta</option>
                          {published.map((route) => (
                            <option key={route.id} value={route.id}>
                              {route.code} v{route.published_revision}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button type="submit" disabled={busy}>
                      Guardar excepción
                    </button>
                  </form>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
