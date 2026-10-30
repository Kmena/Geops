import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiClientError,
  type CompliancePage,
  type ComplianceVisit,
  type VisitEvaluationHistory,
  type VisitEvidenceInterval,
  type VisitOutsideInterval,
  type VisitMapData,
  type VisitTechnicalPreview,
} from './api/client.js';
import { ComplianceMap } from './ComplianceMap.js';
import { VisitEvidenceMap } from './VisitEvidenceMap.js';
import { useAuth } from './auth.js';

const statusLabels: Record<string, string> = {
  COMPLETED: 'Completada',
  IN_PROGRESS: 'En progreso',
  PENDING: 'Pendiente de evaluación',
  INCOMPLETE: 'Permanencia insuficiente',
  NOT_VISITED: 'Sin visita acreditada',
  INSUFFICIENT_EVIDENCE: 'Evidencia insuficiente',
  UNATTRIBUTABLE: 'Sin atribución',
  CANCELLED: 'Cancelada',
};
const syncLabels: Record<string, string> = {
  UNKNOWN: 'Sin información de envío',
  BACKLOG_REPORTED: 'Ubicaciones pendientes de enviar',
  ACK_RECENT: 'Envío reciente confirmado',
  NO_RECENT_ACK: 'Sin envío reciente',
};
const processingLabels: Record<string, string> = {
  PENDING: 'Pendiente de cálculo',
  RUNNING: 'Calculando',
  DONE: 'Cálculo guardado',
  FAILED: 'No se pudo calcular',
  NOT_QUEUED: 'Cálculo no iniciado',
};
const label = (status: string) => statusLabels[status] ?? `Estado desconocido: ${status}`;
const routeLabel = (status: string) =>
  status === 'INCOMPLETE'
    ? 'Ruta sin acreditar por completo'
    : status === 'PENDING'
      ? 'Ruta pendiente de cálculo'
      : label(status);
const visitLabel = (visit: ComplianceVisit) =>
  visit.status === 'INCOMPLETE' && visit.non_compliance_enabled
    ? 'Incumplimiento con cobertura suficiente'
    : label(visit.status);
const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString('es-GT') : 'Sin registro';
const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;
const errorText = (error: unknown) =>
  error instanceof ApiClientError && error.status === 403
    ? 'No tienes permiso para consultar resultados de visitas.'
    : 'No se pudo cargar la información. Inténtalo de nuevo.';
const today = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guatemala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const fields = [
  'from',
  'to',
  'agent_id',
  'route_id',
  'assignment_id',
  'client_id',
  'status',
  'sync_state',
] as const;
type Field = (typeof fields)[number];
type Filters = Record<Field, string>;
const parseFilters = (params: URLSearchParams): Filters => ({
  from: params.get('from') ?? today(),
  to: params.get('to') ?? params.get('from') ?? today(),
  agent_id: params.get('agent_id') ?? '',
  route_id: params.get('route_id') ?? '',
  assignment_id: params.get('assignment_id') ?? '',
  client_id: params.get('client_id') ?? '',
  status: params.get('status') ?? '',
  sync_state: params.get('sync_state') ?? '',
});

function VisitDetail({
  visit,
  onClose,
  onQueued,
  canRequest,
  algorithmApproved,
  technicalAvailable,
  locationAccess,
  csrf,
}: {
  visit: ComplianceVisit;
  onClose: () => void;
  onQueued: () => Promise<void>;
  canRequest: boolean;
  algorithmApproved: boolean;
  technicalAvailable: boolean;
  locationAccess: boolean;
  csrf: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [history, setHistory] = useState<VisitEvaluationHistory[]>([]);
  const [intervals, setIntervals] = useState<VisitEvidenceInterval[]>([]);
  const [outsideIntervals, setOutsideIntervals] = useState<VisitOutsideInterval[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [evidenceRequested, setEvidenceRequested] = useState(false);
  const [queueReason, setQueueReason] = useState(`Revisión de visita del ${visit.local_date}`);
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [queueMessage, setQueueMessage] = useState('');
  const [mapReason, setMapReason] = useState(`Revisión GPS de visita del ${visit.local_date}`);
  const [mapData, setMapData] = useState<VisitMapData | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState('');
  const [previewReason, setPreviewReason] = useState(
    `Simulación técnica de visita del ${visit.local_date}`,
  );
  const [preview, setPreview] = useState<VisitTechnicalPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setHistory((previous) => (previous[0]?.id === visit.evaluation_id ? previous : []));
    setIntervals([]);
    setOutsideIntervals([]);
    setEvidenceRequested(false);
    void api
      .visitHistory(visit.assignment_id, visit.stop_id)
      .then((page) => {
        if (live) setHistory(page.items);
      })
      .catch((failure) => {
        if (live) setError(errorText(failure));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [visit.assignment_id, visit.stop_id, visit.evaluation_id]);
  const loadEvidence = async () => {
    if (!visit.evaluation_id) return;
    setError('');
    try {
      const page = await api.visitEvidence(
        visit.assignment_id,
        visit.stop_id,
        visit.evaluation_id,
        'Consulta administrativa de evidencia',
      );
      setIntervals(page.items);
      setOutsideIntervals(page.outside_items ?? []);
      setEvidenceRequested(true);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const requestEvaluation = async (event: FormEvent) => {
    event.preventDefault();
    setQueueError('');
    setQueueMessage('');
    setQueueing(true);
    try {
      await api.requestVisitEvaluation(visit.assignment_id, queueReason.trim(), csrf);
      setQueueMessage(
        'Evaluación solicitada. El resultado se actualizará cuando termine el cálculo.',
      );
      await onQueued();
    } catch (failure) {
      setQueueError(
        failure instanceof ApiClientError && failure.code === 'algorithm_not_approved'
          ? 'La regla de permanencia aún no está aprobada para visitas reales.'
          : failure instanceof ApiClientError && failure.status === 403
            ? 'No tienes permiso para solicitar esta evaluación.'
            : 'No se pudo solicitar la evaluación. Actualiza el estado e inténtalo de nuevo.',
      );
    } finally {
      setQueueing(false);
    }
  };
  const loadMap = async (event: FormEvent) => {
    event.preventDefault();
    setMapLoading(true);
    setMapError('');
    try {
      setMapData(await api.visitMap(visit.assignment_id, visit.stop_id, mapReason.trim()));
    } catch (failure) {
      setMapError(
        failure instanceof ApiClientError && failure.status === 403
          ? 'No tienes permiso para consultar las coordenadas de esta visita.'
          : 'No se pudieron consultar las posiciones de esta visita.',
      );
    } finally {
      setMapLoading(false);
    }
  };
  const simulateVisit = async (event: FormEvent) => {
    event.preventDefault();
    setPreviewLoading(true);
    setPreviewError('');
    setPreview(null);
    try {
      setPreview(
        await api.visitTechnicalPreview(visit.assignment_id, visit.stop_id, previewReason.trim()),
      );
    } catch (failure) {
      setPreviewError(
        failure instanceof ApiClientError && failure.status === 403
          ? 'Tu cuenta necesita permiso para consultar la evidencia GPS de esta visita.'
          : 'No se pudo simular la visita. Actualiza la página e inténtalo de nuevo.',
      );
    } finally {
      setPreviewLoading(false);
    }
  };
  const activeJob = visit.processing_state === 'PENDING' || visit.processing_state === 'RUNNING';
  const eligible = visit.status !== 'CANCELLED' && Date.now() >= Date.parse(visit.ends_at);
  return (
    <aside className="compliance-detail" aria-label="Detalle de visita">
      <div className="compliance-detail-head">
        <div>
          <span className="compliance-eyebrow">Evidencia histórica</span>
          <h2 ref={headingRef} tabIndex={-1}>
            {visit.client_name} · {visit.site_name}
          </h2>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar detalle
        </button>
      </div>
      <dl className="compliance-facts">
        <div>
          <dt>Estado</dt>
          <dd>
            {visitLabel(visit)}
            {visit.provisional ? ' · Provisional' : ''}
          </dd>
        </div>
        <div>
          <dt>Dispositivo / agente</dt>
          <dd>{visit.agent_name}</dd>
        </div>
        <div>
          <dt>Ruta</dt>
          <dd>
            {visit.route_name} · versión {visit.route_revision}
          </dd>
        </div>
        <div>
          <dt>Jornada</dt>
          <dd>
            {visit.local_date} · {dateTime(visit.starts_at)} a {dateTime(visit.ends_at)}
          </dd>
        </div>
        <div>
          <dt>Permanencia</dt>
          <dd>
            {visit.evaluation_id
              ? `${minutes(visit.credited_s)} de ${minutes(visit.required_s)} acreditados`
              : 'Aún sin cálculo'}
          </dd>
        </div>
        <div>
          <dt>Geozona histórica</dt>
          <dd>
            Versión {visit.geofence_revision} · radio {visit.radius_m} m
          </dd>
        </div>
        <div>
          <dt>Cobertura GPS</dt>
          <dd>
            {visit.coverage_percent === null ? 'Aún sin cálculo' : `${visit.coverage_percent}%`}
          </dd>
        </div>
        <div>
          <dt>Tiempo fuera / desconocido</dt>
          <dd>
            {visit.outside_credited_s === null || visit.unknown_s === null
              ? 'Aún sin cálculo'
              : `${minutes(visit.outside_credited_s)} fuera · ${minutes(visit.unknown_s)} sin clasificar`}
          </dd>
        </div>
        <div>
          <dt>Tiempo potencial dentro de la zona</dt>
          <dd>
            {visit.potential_inside_upper_s === null
              ? 'Aún sin cálculo'
              : minutes(visit.potential_inside_upper_s)}
          </dd>
        </div>
        <div>
          <dt>Cálculo</dt>
          <dd>
            {processingLabels[visit.processing_state] ?? visit.processing_state}
            {visit.job_error_code ? ' · requiere revisión' : ''}
          </dd>
        </div>
        <div>
          <dt>Sincronización GPS</dt>
          <dd>
            {syncLabels[visit.sync_state] ?? visit.sync_state} · última confirmación:{' '}
            {dateTime(visit.last_ack_at)}
            {visit.backlog_reported !== null
              ? ` · ubicaciones pendientes de enviar: ${visit.backlog_reported}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Evaluación</dt>
          <dd>{dateTime(visit.evaluated_at)}</dd>
        </div>
        <div>
          <dt>Primera / última evidencia</dt>
          <dd>
            {dateTime(visit.first_qualified_at)} / {dateTime(visit.last_qualified_at)}
          </dd>
        </div>
        <div>
          <dt>Cumplimiento</dt>
          <dd>{dateTime(visit.completed_at)}</dd>
        </div>
        <div>
          <dt>Regla de cálculo</dt>
          <dd>
            {visit.algorithm_id
              ? visit.algorithm_scope === 'TECHNICAL_ONLY'
                ? 'Prueba técnica: no declara incumplimientos oficiales'
                : `Revisión ${visit.algorithm_revision} aprobada`
              : 'Aún sin evaluación'}
          </dd>
        </div>
        <div>
          <dt>Dispositivo vinculado</dt>
          <dd>{visit.device_id ?? 'Sin vínculo temporal demostrado'}</dd>
        </div>
      </dl>
      <p className="compliance-note">
        Se usan la ruta y la zona definidas para esta jornada. Si llegan ubicaciones nuevas, el
        resultado puede actualizarse.
      </p>
      {!visit.evaluation_id && (
        <p className="compliance-note" role="status">
          Todavía no se ha calculado la permanencia. Esto no confirma incumplimiento.
        </p>
      )}
      {canRequest && (
        <form
          className="compliance-evaluation-action"
          onSubmit={(event) => void requestEvaluation(event)}
        >
          <label>
            Motivo de la evaluación
            <input
              value={queueReason}
              onChange={(event) => setQueueReason(event.target.value)}
              minLength={8}
              maxLength={240}
              required
            />
          </label>
          <button
            type="submit"
            disabled={
              (!algorithmApproved && !technicalAvailable) || !eligible || activeJob || queueing
            }
          >
            {queueing
              ? 'Solicitando…'
              : technicalAvailable && !algorithmApproved
                ? visit.evaluation_id
                  ? 'Reevaluar en prueba técnica'
                  : 'Solicitar prueba técnica'
                : visit.evaluation_id
                  ? 'Reevaluar visita'
                  : 'Evaluar visita'}
          </button>
          {technicalAvailable && !algorithmApproved && (
            <p>
              Resultado técnico de staging, sin incumplimiento oficial. El scheduler también calcula
              y guarda automáticamente las visitas al terminar su jornada.
            </p>
          )}
          {!algorithmApproved && !technicalAvailable && (
            <p>La regla de permanencia requiere aprobación antes de evaluar visitas reales.</p>
          )}
          {!eligible && visit.status !== 'CANCELLED' && (
            <p>La evaluación estará disponible al terminar la jornada.</p>
          )}
          {activeJob && <p role="status">La evaluación está en cola o en proceso.</p>}
          {queueMessage && <p role="status">{queueMessage}</p>}
          {queueError && <p role="alert">{queueError}</p>}
        </form>
      )}
      {technicalAvailable && locationAccess && (
        <section aria-label="Simulación técnica de permanencia">
          <h3>Simulación técnica de permanencia</h3>
          <p className="compliance-note">
            Calcula con la geozona histórica y las posiciones vinculadas. No guarda una evaluación
            ni modifica la visita; la revisión 3 no emite incumplimientos oficiales.
          </p>
          <form
            className="compliance-evaluation-action"
            onSubmit={(event) => void simulateVisit(event)}
          >
            <label>
              Motivo de la simulación
              <input
                value={previewReason}
                onChange={(event) => setPreviewReason(event.target.value)}
                minLength={8}
                maxLength={240}
                required
              />
            </label>
            <button type="submit" disabled={previewLoading}>
              {previewLoading ? 'Calculando…' : 'Simular permanencia sin guardar'}
            </button>
          </form>
          {previewError && <p role="alert">{previewError}</p>}
          {preview && (
            <div role="status">
              <p>
                <strong>{label(preview.status)}</strong> · {minutes(preview.credited_s)} de{' '}
                {minutes(preview.required_s)} acreditados · {preview.sample_count} posiciones
                examinadas por el cálculo.
              </p>
              <p>
                {preview.outside_credited_s === null || preview.unknown_s === null
                  ? 'Tiempo fuera y desconocido: sin cálculo.'
                  : `${minutes(preview.outside_credited_s)} fuera · ${minutes(preview.unknown_s)} desconocido.`}{' '}
                Cobertura:{' '}
                {preview.coverage_percent === null ? 'sin cálculo' : `${preview.coverage_percent}%`}
                .
              </p>
              <p>
                {preview.credited_intervals.length} intervalos acreditados · última evidencia
                recibida: {dateTime(preview.source_watermark)}.
              </p>
              <small>
                Vista técnica calculada ahora; no aparece en el historial de evaluaciones.
              </small>
            </div>
          )}
        </section>
      )}
      {locationAccess && (
        <section aria-label="Mapa de evidencia GPS">
          <h3>Geozona y posiciones de la visita</h3>
          <form className="compliance-evaluation-action" onSubmit={(event) => void loadMap(event)}>
            <label>
              Motivo de consulta de ubicaciones
              <input
                value={mapReason}
                onChange={(event) => setMapReason(event.target.value)}
                minLength={8}
                maxLength={240}
                required
              />
            </label>
            <button type="submit" className="secondary" disabled={mapLoading}>
              {mapLoading ? 'Consultando…' : 'Mostrar mapa y puntos GPS'}
            </button>
          </form>
          {mapError && <p role="alert">{mapError}</p>}
          {mapData && <VisitEvidenceMap data={mapData} />}
        </section>
      )}
      <h3>Historial de evaluaciones</h3>
      {loading && <p role="status">Cargando historial…</p>}
      {!loading && !history.length && <p>No hay evaluaciones registradas.</p>}
      {!!history.length && (
        <ol className="compliance-history">
          {history.map((entry, index) => {
            const previous = history[index + 1];
            return (
              <li key={entry.id}>
                <strong>
                  #{entry.evaluation_no} · {label(entry.status)}
                </strong>
                <span>
                  {dateTime(entry.evaluated_at)} · {minutes(entry.credited_s)} ·{' '}
                  {entry.algorithm_id} v{entry.algorithm_revision}
                </span>
                {entry.supersedes_id && <span>Reprocesó la evaluación {entry.supersedes_id}</span>}
                {previous && (
                  <span>
                    Cambio: {label(previous.status)} → {label(entry.status)}; permanencia{' '}
                    {minutes(previous.credited_s)} → {minutes(entry.credited_s)}.
                  </span>
                )}
                <span>
                  Motivo registrado:{' '}
                  {entry.trigger_reason ?? 'No disponible para esta revisión histórica'}
                </span>
                <span>
                  Muestras {entry.sample_count}; incertidumbre {entry.uncertain_count}; huecos{' '}
                  {entry.gap_count}
                </span>
                {entry.coverage_percent !== null && (
                  <span>
                    Cobertura {entry.coverage_percent}% · fuera{' '}
                    {minutes(entry.outside_credited_s ?? 0)} · desconocido{' '}
                    {minutes(entry.unknown_s ?? 0)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {visit.evaluation_id && (
        <button type="button" onClick={() => void loadEvidence()}>
          Consultar intervalos y referencias GPS
        </button>
      )}
      {evidenceRequested && (
        <div>
          <h3>Intervalos acreditados</h3>
          {!intervals.length && (
            <p>
              No hay intervalos acreditados; las referencias GPS no están disponibles para esta
              evaluación.
            </p>
          )}
          {!!intervals.length && (
            <ol className="compliance-history">
              {intervals.map((item) => (
                <li key={item.interval_no}>
                  <strong>
                    {dateTime(item.from_at)} a {dateTime(item.to_at)}
                  </strong>
                  <span>
                    {minutes(item.credited_s)} acreditados · dispositivo {item.device_id}
                  </span>
                  <span>
                    Eventos {item.event_id_a} / {item.event_id_b}
                  </span>
                  <span>
                    Captura A/B: {dateTime(item.event_a_captured_at)} /{' '}
                    {dateTime(item.event_b_captured_at)} · recepción A/B:{' '}
                    {dateTime(item.event_a_received_at)} / {dateTime(item.event_b_received_at)}
                  </span>
                  <span>
                    Precisión A/B: {item.event_a_accuracy_m ?? '—'} /{' '}
                    {item.event_b_accuracy_m ?? '—'} m
                  </span>
                  {(!item.event_a_available || !item.event_b_available) && (
                    <span>
                      Evento fuente no disponible; pudo expirar por retención. Se conserva el
                      intervalo acreditado.
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          <h3>Intervalos acreditados fuera</h3>
          {!outsideIntervals.length && (
            <p>No hay intervalos exteriores certificados en esta evaluación.</p>
          )}
          {!!outsideIntervals.length && (
            <ol className="compliance-history">
              {outsideIntervals.map((item) => (
                <li key={item.interval_no}>
                  {dateTime(item.from_at)} a {dateTime(item.to_at)} · {minutes(item.seconds)} fuera{' '}
                  · eventos {item.event_id_a} / {item.event_id_b}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}

export function ComplianceDashboard() {
  const { profile } = useAuth();
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const [params, setParams] = useSearchParams();
  const applied = useMemo(() => parseFilters(params), [params]);
  const [draft, setDraft] = useState<Filters>(applied);
  const [page, setPage] = useState<CompliancePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ComplianceVisit | null>(null);
  const [tab, setTab] = useState<'visits' | 'routes' | 'agents' | 'clients' | 'map'>('routes');
  useEffect(() => {
    setDraft(applied);
    setOffset(0);
    setSelected(null);
  }, [applied]);
  const reload = useCallback(
    async (silent = false) => {
      const query: Record<string, string> = {
        from: applied.from,
        to: applied.to,
        limit: '50',
        offset: String(offset),
      };
      for (const field of fields)
        if (field !== 'from' && field !== 'to' && applied[field]) query[field] = applied[field];
      if (!silent) {
        setLoading(true);
        setError('');
      }
      try {
        const next = await api.compliance(query);
        setPage(next);
        setLastUpdatedAt(new Date());
        setError('');
        setSelected((current) =>
          current
            ? (next.items.find(
                (item) =>
                  item.assignment_id === current.assignment_id && item.stop_id === current.stop_id,
              ) ?? current)
            : null,
        );
      } catch (failure) {
        if (!silent) setPage(null);
        setError(
          silent
            ? 'No se pudo actualizar. Comprueba la conexión y pulsa Actualizar.'
            : errorText(failure),
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [applied, offset],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void reload(true);
    };
    const timer = window.setInterval(refreshWhenVisible, 60_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [reload]);
  useEffect(() => {
    if (!selected || !['PENDING', 'RUNNING'].includes(selected.processing_state)) return;
    const timer = setInterval(() => void reload(true), 3000);
    return () => clearInterval(timer);
  }, [selected, reload]);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const field of fields) if (draft[field]) next.set(field, draft[field]);
    setParams(next);
  };
  const change = (field: Field, value: string) =>
    setDraft((current) => ({ ...current, assignment_id: '', [field]: value }));
  const showVisits = (field: 'agent_id' | 'assignment_id' | 'client_id', value: string) => {
    const next = new URLSearchParams(params);
    if (field === 'assignment_id') {
      next.delete('client_id');
      next.delete('status');
      next.delete('sync_state');
    } else next.delete('assignment_id');
    next.set(field, value);
    setParams(next);
    setTab('visits');
  };
  const openDetail = (visit: ComplianceVisit, trigger?: HTMLButtonElement) => {
    detailTrigger.current = trigger ?? null;
    setSelected(visit);
  };
  const closeDetail = () => {
    setSelected(null);
    window.requestAnimationFrame(() => detailTrigger.current?.focus());
  };
  const indicators = page?.indicators;
  const tiles = indicators
    ? ([
        ['Agentes con rutas', indicators.agents_with_routes],
        ['Rutas programadas', indicators.scheduled_routes],
        ['Visitas programadas', indicators.scheduled_visits],
        ['Completadas', indicators.completed_visits],
        ['En progreso', indicators.in_progress_visits],
        ['Pendientes', indicators.pending_visits],
        ['Evidencia insuficiente', indicators.insufficient_evidence_visits],
        ['Sin atribución', indicators.unattributable_visits],
        ['Rutas completadas', indicators.completed_routes],
        ['Rutas incompletas', indicators.incomplete_routes],
      ] as const)
    : [];
  return (
    <div className="compliance-page">
      <header className="compliance-hero">
        <div>
          <h1>Verificación de rutas</h1>
          <p>Revisa cuántas visitas obligatorias quedaron acreditadas en cada ruta.</p>
        </div>
        <div className="compliance-refresh">
          {lastUpdatedAt && (
            <span role="status">
              Actualizado a las{' '}
              {lastUpdatedAt.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button type="button" className="secondary" onClick={() => void reload()}>
            Actualizar
          </button>
        </div>
      </header>
      <form className="compliance-filters" onSubmit={apply} aria-label="Filtros de cumplimiento">
        <label>
          Desde
          <input
            type="date"
            value={draft.from}
            onChange={(event) => change('from', event.target.value)}
            required
          />
        </label>
        <label>
          Hasta
          <input
            type="date"
            value={draft.to}
            onChange={(event) => change('to', event.target.value)}
            required
          />
        </label>
        <label>
          Dispositivo / agente
          <input
            list="compliance-agents"
            value={draft.agent_id}
            onChange={(event) => change('agent_id', event.target.value)}
            placeholder="Todos · busca por ID"
          />
        </label>
        <label>
          Ruta
          <input
            list="compliance-routes"
            value={draft.route_id}
            onChange={(event) => change('route_id', event.target.value)}
            placeholder="Todas · busca por ID"
          />
        </label>
        <label>
          Cliente
          <input
            list="compliance-clients"
            value={draft.client_id}
            onChange={(event) => change('client_id', event.target.value)}
            placeholder="Todos · busca por ID"
          />
        </label>
        <datalist id="compliance-agents">
          {page?.agents.map((item) => (
            <option key={item.id} value={item.id} label={item.name} />
          ))}
        </datalist>
        <datalist id="compliance-routes">
          {page?.routes.map((item) => (
            <option key={item.assignment_id} value={item.route_id} label={item.route_name} />
          ))}
        </datalist>
        <datalist id="compliance-clients">
          {page?.clients.map((item) => (
            <option key={item.id} value={item.id} label={item.name} />
          ))}
        </datalist>
        <label>
          Estado
          <select value={draft.status} onChange={(event) => change('status', event.target.value)}>
            <option value="">Todos</option>
            {Object.entries(statusLabels).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sincronización GPS
          <select
            value={draft.sync_state}
            onChange={(event) => change('sync_state', event.target.value)}
          >
            <option value="">Todos</option>
            {Object.entries(syncLabels).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Aplicar filtros</button>
      </form>
      {loading && <p role="status">Cargando cumplimiento…</p>}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {page && (
        <>
          <div className="compliance-warning" role="status">
            Los resultados pueden cambiar si llegan ubicaciones GPS más tarde. Cuando faltan datos,
            no se confirma ni la visita ni la ausencia del agente.
          </div>
          <section aria-label="Indicadores de cumplimiento" className="compliance-indicators">
            {tiles.map(([title, value]) => (
              <div key={title} className="compliance-tile">
                <span>{title}</span>
                <strong>{value}</strong>
              </div>
            ))}
            <div className="compliance-tile compliance-highlight">
              <span>Cumplimiento acreditado</span>
              <strong>
                {indicators?.accredited_compliance_percent === null
                  ? '—'
                  : `${indicators?.accredited_compliance_percent}%`}
              </strong>
              <small>
                {indicators?.compliance_denominator ?? 0} visitas obligatorias activas · provisional
              </small>
            </div>
          </section>
          <div className="compliance-tabs" role="tablist" aria-label="Vistas de cumplimiento">
            {(
              [
                ['visits', 'Visitas'],
                ['routes', 'Rutas'],
                ['agents', 'Dispositivos / agentes'],
                ['clients', 'Clientes'],
                ['map', 'Mapa'],
              ] as const
            ).map(([value, title]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {title}
              </button>
            ))}
          </div>
          {tab === 'visits' && (
            <section aria-label="Visitas">
              {applied.assignment_id && (
                <div className="compliance-scope">
                  <span>
                    Visitas de {page.routes[0]?.route_name ?? 'la ruta seleccionada'} ·{' '}
                    {page.routes[0]?.local_date ?? 'jornada seleccionada'}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.delete('assignment_id');
                      setParams(next);
                      setTab('routes');
                    }}
                  >
                    Volver a rutas
                  </button>
                </div>
              )}
              <p>
                {page.total_visits} visitas coinciden con los filtros. Se muestran{' '}
                {page.items.length} en esta página.
              </p>
              <div className="compliance-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Dispositivo / agente</th>
                      <th>Ruta</th>
                      <th>Cliente / sede</th>
                      <th>Permanencia</th>
                      <th>Estado</th>
                      <th>Sincronización GPS</th>
                      <th>Evaluación</th>
                      <th>Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((visit) => (
                      <tr key={`${visit.assignment_id}:${visit.stop_id}`}>
                        <td>{visit.local_date}</td>
                        <td>{visit.agent_name}</td>
                        <td>
                          {visit.route_name} v{visit.route_revision}
                        </td>
                        <td>
                          {visit.client_name} · {visit.site_name}
                        </td>
                        <td>
                          {visit.evaluation_id
                            ? `${minutes(visit.credited_s)} / ${minutes(visit.required_s)}`
                            : 'Aún sin cálculo'}
                        </td>
                        <td>
                          <span
                            className={`compliance-status status-${visit.status.toLowerCase()}`}
                          >
                            {visitLabel(visit)}
                          </span>
                          {visit.provisional && <small>Provisional</small>}
                        </td>
                        <td>{syncLabels[visit.sync_state] ?? visit.sync_state}</td>
                        <td>
                          {processingLabels[visit.processing_state] ?? visit.processing_state}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={(event) => openDetail(visit, event.currentTarget)}
                          >
                            Ver evidencia
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!page.items.length && (
                <p className="compliance-empty">
                  No hay visitas para estos filtros. Ajusta fechas o criterios.
                </p>
              )}
              <div className="compliance-pager">
                <button
                  type="button"
                  className="secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Anterior
                </button>
                <span>Página {Math.floor(offset / 50) + 1}</span>
                <button
                  type="button"
                  className="secondary"
                  disabled={page.next_offset === null}
                  onClick={() => setOffset(page.next_offset ?? offset)}
                >
                  Siguiente
                </button>
              </div>
            </section>
          )}
          {tab === 'routes' && (
            <section aria-label="Cumplimiento por ruta" className="compliance-cards">
              {page.routes.map((route) => (
                <article key={route.assignment_id}>
                  <h2>
                    {route.route_name} <small>v{route.route_revision}</small>
                  </h2>
                  <p>
                    {route.agent_name} · {route.local_date}
                  </p>
                  <strong>
                    {route.completed_required_visits} / {route.required_visits} visitas obligatorias
                    acreditadas
                  </strong>
                  <p>
                    {route.visits} visitas programadas · {minutes(route.credited_s)} acreditados
                  </p>
                  <span
                    className={`compliance-status compliance-route-status status-${route.status.toLowerCase()}`}
                  >
                    {routeLabel(route.status)}
                  </span>
                  <small className="compliance-route-note">Resultado provisional</small>
                  <p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => showVisits('assignment_id', route.assignment_id)}
                    >
                      Ver visitas y permanencia
                    </button>
                  </p>
                </article>
              ))}
              {!page.routes.length && <p>No hay rutas para estos filtros.</p>}
            </section>
          )}
          {(tab === 'agents' || tab === 'clients') && (
            <section
              aria-label={tab === 'agents' ? 'Cumplimiento por agente' : 'Cumplimiento por cliente'}
              className="compliance-cards"
            >
              {page[tab].map((item) => (
                <article key={item.id}>
                  <h2>{item.name}</h2>
                  <p>
                    {item.routes} rutas · {item.visits} visitas
                  </p>
                  <strong>
                    {item.completed_required_visits} / {item.required_visits} obligatorias
                    acreditadas
                  </strong>
                  <p>
                    {minutes(item.credited_s)} acreditados · {item.pending_visits} aún sin completar
                  </p>
                  <small>Provisional</small>
                  {tab === 'agents' && (
                    <p>
                      Dispositivos vinculados en las jornadas:{' '}
                      {item.device_ids.length
                        ? item.device_ids.join(', ')
                        : 'Sin vínculo consultable'}
                    </p>
                  )}
                  <p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        showVisits(tab === 'agents' ? 'agent_id' : 'client_id', item.id)
                      }
                    >
                      Ver asignaciones y visitas
                    </button>
                  </p>
                </article>
              ))}
              {!page[tab].length && <p>No hay datos para estos filtros.</p>}
            </section>
          )}
          {tab === 'map' && (
            <section aria-label="Mapa de cumplimiento">
              <p>
                Geozonas históricas de las visitas en esta página ({page.items.length} de{' '}
                {page.total_visits}). Selecciona un marcador para consultar la evidencia.
              </p>
              <ComplianceMap visits={page.items} locations={page.locations} onSelect={openDetail} />
              {page.location_access ? (
                <div className="compliance-device-list">
                  <h2>Comunicación de dispositivos vinculados</h2>
                  {!page.locations.length && (
                    <p>No hay ubicaciones ni reportes para los agentes filtrados.</p>
                  )}
                  {page.locations.map((location) => (
                    <p key={`${location.agent_id}:${location.device_id}`}>
                      <strong>{location.device_id}</strong> ·{' '}
                      {location.communication_state === 'RECENT_REPORT'
                        ? 'Reporte reciente'
                        : location.communication_state === 'NETWORK_UNAVAILABLE_REPORTED'
                          ? 'Red no disponible reportada'
                          : 'Sin comunicación reciente'}{' '}
                      · último health: {dateTime(location.last_health_received_at)} · última
                      ubicación de esta jornada: {dateTime(location.captured_at)}. Una muestra
                      histórica no representa ubicación actual.
                    </p>
                  ))}
                </div>
              ) : (
                <p>Las ubicaciones requieren permiso GPS adicional.</p>
              )}
              <div className="compliance-legend">
                {Object.entries(statusLabels).map(([value, text]) => (
                  <span key={value}>
                    <i className={`status-${value.toLowerCase()}`} />
                    {text}
                  </span>
                ))}
              </div>
              <div className="compliance-pager">
                <button
                  type="button"
                  className="secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Anterior
                </button>
                <span>Página {Math.floor(offset / 50) + 1}</span>
                <button
                  type="button"
                  className="secondary"
                  disabled={page.next_offset === null}
                  onClick={() => setOffset(page.next_offset ?? offset)}
                >
                  Siguiente
                </button>
              </div>
            </section>
          )}
        </>
      )}
      {selected && (
        <VisitDetail
          key={`${selected.assignment_id}:${selected.stop_id}`}
          visit={selected}
          onClose={closeDetail}
          onQueued={() => reload(true)}
          canRequest={page?.evaluation_access.can_request ?? false}
          algorithmApproved={page?.evaluation_access.algorithm_approved ?? false}
          technicalAvailable={page?.evaluation_access.technical_available ?? false}
          locationAccess={page?.location_access ?? false}
          csrf={profile?.csrf_token ?? ''}
        />
      )}
    </div>
  );
}
