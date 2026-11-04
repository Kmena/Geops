import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { ApiClientError } from '../api/client.js';
import {
  importsApi,
  type Action,
  type Change,
  type ConfirmationPlan,
  type ConfirmationResult,
  type Detail,
  type Facets,
  type Filters,
  type MapPoint,
  type ReviewRow,
  type Session,
  type Summary,
  type Target,
} from './api.js';
import { KmzMap } from './KmzMap.js';
import './imports.css';

const initial: Filters = {
  page: 1,
  limit: 50,
  state: '',
  group: '',
  week: '',
  type: '',
  sort: 'priority',
  search: '',
  record_id: '',
};
const stateName: Record<string, string> = {
  NEW: 'Nuevo',
  EXISTING_MATCH: 'Coincidencia candidata',
  POSSIBLE_DUPLICATE: 'Posible duplicado',
  CONFLICT: 'Conflicto',
  INVALID: 'Inválido',
};
const actionName: Record<Action, string> = {
  CREATE: 'Proponer cliente nuevo',
  LINK: 'Vincular a cliente',
  UPDATE: 'Actualizar campos',
  EXCLUDE: 'Excluir',
  PENDING: 'Pendiente',
};
const friendly = (error: unknown) =>
  error instanceof ApiClientError && error.status === 409
    ? 'Los datos cambiaron. Actualiza la revisión antes de guardar.'
    : error instanceof ApiClientError && error.status === 403
      ? 'No tienes permiso para realizar esta acción.'
      : 'No se pudo completar la operación. Inténtalo de nuevo.';
const number = (value: number | undefined) => new Intl.NumberFormat('es-GT').format(value ?? 0);
const field = (value: unknown) =>
  value === null || value === undefined || value === '' ? 'Sin dato' : String(value);
const recordLabel = (row: ReviewRow) =>
  row.proposed?.name ?? row.normalized.name ?? 'Elemento sin nombre';
const fieldName: Record<string, string> = {
  name: 'Nombre',
  code: 'Código de referencia',
  latitude: 'Latitud',
  longitude: 'Longitud',
  customer: 'Cliente asociado',
  group: 'Ruta o agrupación',
  week: 'Ruta semanal',
};
const typeName: Record<string, string> = {
  CLIENT_CANDIDATE: 'Cliente candidato',
  REFERENCE_POINT: 'Punto de referencia',
  WEEKLY_STOP: 'Parada semanal',
  GEOGRAPHIC_GROUP: 'Agrupación geográfica',
  ROUTE_CANDIDATE: 'Ruta candidata',
  POLYGON: 'Polígono',
  LINE: 'Línea',
  INVALID_OR_OTHER: 'Inválido u otro',
};
const recordTypeName = (row: ReviewRow) =>
  row.route_candidate ? typeName.ROUTE_CANDIDATE : (typeName[row.record_type] ?? 'Elemento KMZ');
const signalName: Record<string, string> = {
  IN_FILE_CODE: 'Mismo código en el archivo',
  IN_FILE_SIMILAR_NAME: 'Nombre parecido en el archivo',
  SAME_PARENT_GROUP: 'Misma agrupación',
  PROXIMITY_HIGH: 'Ubicación muy cercana',
  PROXIMITY_EXTENDED: 'Ubicación cercana',
  LINKED_CUSTOMER: 'Cliente asociado',
};
const flagName: Record<string, string> = {
  CODE_NAME_LOCATION_CONFLICT: 'El código coincide, pero el nombre o la ubicación difieren',
  DUPLICATE_CODE: 'Código repetido',
  DUPLICATE_NAME: 'Nombre repetido',
  INVALID_COORDINATES: 'Coordenadas inválidas',
  MISSING_NAME: 'Falta el nombre',
};

export function KmzWorkspace() {
  const { id } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [newReview, setNewReview] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets>({
    groups: [],
    weeks: [],
    group_choices: [],
  });
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [filters, setFilters] = useState<Filters>(initial);
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'review' | 'preview'>('review');
  const [previewPage, setPreviewPage] = useState(1);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof importsApi.preview>> | null>(
    null,
  );
  const [plan, setPlan] = useState<ConfirmationPlan | null>(null);
  const [applied, setApplied] = useState<ConfirmationResult | null>(null);
  const [confirmationReason, setConfirmationReason] = useState('');
  const [confirmationChecked, setConfirmationChecked] = useState(false);
  const [confirmationKey, setConfirmationKey] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<'CREATE' | 'EXCLUDE' | 'ASSIGN_GROUP'>('EXCLUDE');
  const [bulkReason, setBulkReason] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');
  const [bulkPreview, setBulkPreview] = useState<Awaited<
    ReturnType<typeof importsApi.bulkPreview>
  > | null>(null);
  const canWrite = (capabilities?.includes('catalog.import.write') ?? false) && !applied;
  const canConfirm = capabilities?.includes('catalog.import.confirm') ?? false;
  const refresh = useCallback(async () => {
    if (!id) return;
    const [nextSummary, nextRows, nextFacets, nextPoints] = await Promise.all([
      importsApi.summary(id),
      importsApi.records(id, filters),
      importsApi.facets(id),
      importsApi.map(id),
    ]);
    setSummary(nextSummary);
    setRows(nextRows.items);
    setTotal(nextRows.total);
    setFacets(nextFacets);
    setPoints(nextPoints.items);
  }, [id, filters]);
  useEffect(() => {
    let live = true;
    void importsApi
      .capabilities()
      .then((value) => {
        if (live) setCapabilities(value.capabilities);
      })
      .catch(() => {
        if (live) setCapabilityError(true);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    if (id) return;
    setLoading(true);
    void importsApi
      .sessions()
      .then((value) => {
        if (live) {
          setSessions(value.items);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (live) {
          setError(friendly(failure));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    let live = true;
    if (!id) return;
    setLoading(true);
    setError('');
    void Promise.all([
      importsApi.summary(id),
      importsApi.records(id, filters),
      importsApi.facets(id),
      importsApi.map(id),
    ])
      .then(([a, b, c, d]) => {
        if (live) {
          setSummary(a);
          setRows(b.items);
          setTotal(b.total);
          setFacets(c);
          setPoints(d.items);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (live) {
          setError(friendly(failure));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [id, filters]);
  useEffect(() => {
    let live = true;
    if (!id || !selected) {
      setDetail(null);
      return;
    }
    void importsApi
      .detail(id, selected)
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch(() => {
        if (live) setDetail(null);
      });
    return () => {
      live = false;
    };
  }, [id, selected]);
  useEffect(() => {
    let live = true;
    if (!id || tab !== 'preview' || summary?.reviewed === undefined) return;
    void importsApi
      .preview(id, previewPage)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((failure) => {
        if (live) setError(friendly(failure));
      });
    return () => {
      live = false;
    };
  }, [id, tab, previewPage, summary?.reviewed]);
  useEffect(() => {
    let live = true;
    if (!id) return;
    setApplied(null);
    void importsApi
      .result(id)
      .then((value) => {
        if (live && value.state === 'APPLIED') setApplied(value as ConfirmationResult);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  const selectedPoint = useMemo(
    () => points.find((item) => item.record_id === selected),
    [points, selected],
  );
  function updateFilter(key: keyof Filters, value: string | number) {
    setFilters((previous) => ({ ...previous, [key]: value, record_id: '', page: 1 }));
    setChecked([]);
    setBulkPreview(null);
  }
  function focusRecord(recordId: string) {
    setSelected(recordId);
    setSearchInput('');
    setFilters({ ...initial, record_id: recordId });
    setChecked([]);
    setBulkPreview(null);
    setTab('review');
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !canWrite) return;
    const file = new FormData(event.currentTarget).get('file') as File | null;
    if (!file?.name.toLowerCase().endsWith('.kmz')) {
      setError('Selecciona un archivo KMZ válido.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await importsApi.upload(file, profile.csrf_token, newReview);
      if (session.state === 'READY')
        await importsApi.analyze(session.import_id, profile.csrf_token);
      navigate(`/imports/${session.import_id}`);
    } catch (failure) {
      setError(friendly(failure));
    } finally {
      setBusy(false);
    }
  }
  async function save(change: Change) {
    if (!id || !detail || !profile || !canWrite) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await importsApi.save(id, detail.record_id, detail.revision, change, profile.csrf_token);
      setPlan(null);
      setConfirmationChecked(false);
      await refresh();
      setDetail(await importsApi.detail(id, detail.record_id));
      setNotice('Revisión guardada en precarga. No se modificó el catálogo.');
    } catch (failure) {
      setError(friendly(failure));
      if (failure instanceof ApiClientError && failure.status === 409) {
        await refresh().catch(() => {});
        setDetail(await importsApi.detail(id, detail.record_id).catch(() => null));
      }
    } finally {
      setBusy(false);
    }
  }
  const bulkInput = {
    record_ids: checked,
    action: bulkAction,
    ...(bulkAction === 'EXCLUDE' ? { reason: bulkReason } : {}),
    ...(bulkAction === 'ASSIGN_GROUP' ? { group_id: bulkGroup } : {}),
  };
  async function prepareBulk() {
    if (!id || !profile) return;
    setBusy(true);
    setError('');
    try {
      setBulkPreview(await importsApi.bulkPreview(id, bulkInput, profile.csrf_token));
    } catch (failure) {
      setError(friendly(failure));
    } finally {
      setBusy(false);
    }
  }
  async function applyBulk() {
    if (!id || !profile || !bulkPreview) return;
    setBusy(true);
    setError('');
    try {
      const result = await importsApi.bulkApply(
        id,
        bulkInput,
        bulkPreview.digest,
        profile.csrf_token,
      );
      setNotice(`${result.count} decisiones guardadas en precarga.`);
      setPlan(null);
      setConfirmationChecked(false);
      setChecked([]);
      setBulkPreview(null);
      await refresh();
    } catch (failure) {
      setError(friendly(failure));
      setBulkPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function validateFinal() {
    if (!id || !profile || !canConfirm) return;
    setBusy(true);
    setError('');
    setPlan(null);
    setConfirmationChecked(false);
    setConfirmationKey(null);
    try {
      setPlan(await importsApi.validate(id, profile.csrf_token));
    } catch (failure) {
      setError(friendly(failure));
    } finally {
      setBusy(false);
    }
  }
  async function confirmFinal() {
    if (
      !id ||
      !profile ||
      !plan ||
      !canConfirm ||
      !confirmationChecked ||
      confirmationReason.trim().length < 8
    )
      return;
    const key = confirmationKey ?? crypto.randomUUID();
    setConfirmationKey(key);
    setBusy(true);
    setError('');
    try {
      const result = await importsApi.confirm(
        id,
        plan,
        confirmationReason.trim(),
        key,
        profile.csrf_token,
      );
      setApplied(result);
      setNotice('Importación aplicada. Se guardó el resultado y la auditoría.');
    } catch (failure) {
      setError(friendly(failure));
    } finally {
      setBusy(false);
    }
  }
  if (capabilities === null)
    return capabilityError ? (
      <div role="alert" className="notice error">
        No se pudo comprobar el acceso a importaciones KMZ. Actualiza la página e inténtalo de
        nuevo.
      </div>
    ) : (
      <p role="status" className="kmz-status">
        Comprobando permisos de importación…
      </p>
    );
  if (!capabilities.includes('catalog.import.read'))
    return (
      <div role="alert" className="notice error">
        No tienes permiso para revisar importaciones KMZ.
      </div>
    );
  if (!id)
    return (
      <div className="kmz-workspace">
        <div className="kmz-heading">
          <div>
            <p className="eyebrow">SPEC-03 · W4</p>
            <h1>Importaciones KMZ</h1>
            <p>Prepara clientes y rutas candidatas para revisión administrativa.</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {canWrite && (
          <section className="panel kmz-upload">
            <h2>Cargar un KMZ</h2>
            <p>
              El archivo se analiza en precarga. Ningún cliente ni visita operativa cambia durante
              esta etapa.
            </p>
            <form onSubmit={(event) => void upload(event)}>
              <label>
                Archivo KMZ
                <input
                  type="file"
                  name="file"
                  accept=".kmz,application/vnd.google-earth.kmz"
                  required
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={newReview}
                  onChange={(event) => setNewReview(event.target.checked)}
                />
                Crear una nueva revisión si este archivo ya se cargó
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Analizando archivo…' : 'Cargar y analizar'}
              </button>
            </form>
          </section>
        )}
        <section className="panel">
          <h2>Revisiones recientes</h2>
          {loading ? (
            <p role="status">Cargando importaciones…</p>
          ) : sessions.length === 0 ? (
            <p className="empty">Todavía no hay archivos KMZ en revisión.</p>
          ) : (
            <ul className="kmz-session-list">
              {sessions.map((session) => (
                <li key={session.import_id}>
                  <div>
                    <strong>{session.file_name ?? 'Importación KMZ'}</strong>
                    <small>
                      {new Date(session.created_at).toLocaleString('es-GT')} ·{' '}
                      {number(session.record_count)} registros · {session.state}
                    </small>
                  </div>
                  <Link to={`/imports/${session.import_id}`}>Abrir revisión</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  return (
    <div className="kmz-workspace">
      <div className="kmz-heading">
        <div>
          <Link to="/imports" className="kmz-back">
            ← Importaciones
          </Link>
          <p className="eyebrow">SPEC-03 · Revisión administrativa</p>
          <h1>Revisión KMZ</h1>
          <p>
            Comprueba cada propuesta antes de incorporarla. Las decisiones se guardan solo en
            precarga.
          </p>
        </div>
        <div className="kmz-heading-actions">
          <button
            type="button"
            className={tab === 'review' ? 'active' : ''}
            onClick={() => setTab('review')}
          >
            Revisar registros
          </button>
          <button
            type="button"
            className={tab === 'preview' ? 'active' : ''}
            onClick={() => setTab('preview')}
          >
            Resumen previo
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}{' '}
          <button type="button" onClick={() => void refresh()}>
            Reintentar
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {loading && <p role="status">Cargando revisión…</p>}
      {summary && (
        <>
          <section className="kmz-metrics" aria-label="Resumen de revisión">
            {[
              ['Registros', summary.total],
              ['Clientes candidatos', summary.client_candidates],
              ['Rutas candidatas', summary.route_candidates],
              ['Coincidencias', summary.existing_matches],
              ['Posibles duplicados', summary.possible_duplicates],
              ['Conflictos', summary.conflicts],
              ['Inválidos', summary.invalid],
              ['Revisados', summary.reviewed],
              ['Pendientes', summary.pending],
              ['Excluidos', summary.excluded],
            ].map(([label, value]) => (
              <div className="kmz-metric" key={String(label)}>
                <strong>{number(Number(value))}</strong>
                <span>{label}</span>
              </div>
            ))}
          </section>
          <p className="kmz-count-note">
            {number(summary.candidate_relations)} relaciones candidatas entre registros y catálogo;
            pueden existir varias por registro. Ninguna confirma identidad.
          </p>
        </>
      )}
      {tab === 'preview' ? (
        <section className="panel kmz-preview">
          <h2>Operaciones propuestas</h2>
          <p>
            Valida las decisiones y confirma únicamente las operaciones aprobadas. Las rutas del KMZ
            quedan como candidatas; no se generan visitas.
          </p>
          {summary && (
            <div className="kmz-preview-totals">
              <span>
                Crear <strong>{number(summary.create_count)}</strong>
              </span>
              <span>
                Actualizar <strong>{number(summary.update_count)}</strong>
              </span>
              <span>
                Vincular <strong>{number(summary.link_count)}</strong>
              </span>
              <span>
                Excluir <strong>{number(summary.excluded)}</strong>
              </span>
              <span>
                Pendientes <strong>{number(summary.pending)}</strong>
              </span>
              <span>
                Conflictos <strong>{number(summary.conflicts)}</strong>
              </span>
              <span>
                Inválidos <strong>{number(summary.invalid)}</strong>
              </span>
              <span>
                Advertencias <strong>{number(summary.warnings)}</strong>
              </span>
            </div>
          )}
          {applied ? (
            <div className="notice" role="status">
              <strong>Importación aplicada</strong> · {number(applied.operations.length)}{' '}
              operaciones · {new Date(applied.applied_at).toLocaleString('es-GT')}. Rutas activadas:
              0. Visitas creadas: 0.
            </div>
          ) : canConfirm ? (
            <div className="kmz-confirmation">
              <button type="button" disabled={busy} onClick={() => void validateFinal()}>
                Validar decisiones para confirmar
              </button>
              {plan && (
                <div>
                  <h3>Resumen final validado</h3>
                  <p>
                    Crear {number(plan.counts.create)} · Actualizar {number(plan.counts.update)} ·
                    Vincular {number(plan.counts.link)} · Excluir {number(plan.counts.exclude)} ·
                    Agrupaciones candidatas {number(plan.counts.groups_candidate)} · Rutas
                    candidatas {number(plan.counts.routes_candidate)}.
                  </p>
                  <p>
                    Advertencias: {number(plan.warnings.length)}. Conflictos bloqueantes:{' '}
                    {number(plan.blocking_issues.length)}.
                  </p>
                  {plan.blocking_issues.length > 0 && (
                    <ul aria-label="Conflictos bloqueantes">
                      {plan.blocking_issues.map((issue) => (
                        <li key={`${issue.record_id}:${issue.code}`}>
                          <button type="button" onClick={() => focusRecord(issue.record_id)}>
                            {issue.code.replaceAll('_', ' ')} · Revisar registro
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {plan.operational_confirmation_available && (
                    <div>
                      <label>
                        Motivo de confirmación
                        <textarea
                          value={confirmationReason}
                          maxLength={240}
                          onChange={(event) => {
                            setConfirmationReason(event.target.value);
                            setConfirmationKey(null);
                          }}
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={confirmationChecked}
                          onChange={(event) => setConfirmationChecked(event.target.checked)}
                        />
                        He revisado el resumen y autorizo estas operaciones.
                      </label>
                      <button
                        type="button"
                        disabled={
                          busy || !confirmationChecked || confirmationReason.trim().length < 8
                        }
                        onClick={() => void confirmFinal()}
                      >
                        Confirmar y aplicar importación
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p>Se requiere el permiso de confirmación para aplicar las decisiones revisadas.</p>
          )}
          {preview?.items.length ? (
            <>
              <div className="kmz-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Registro</th>
                      <th>Propuesta</th>
                      <th>Cambios</th>
                      <th>Atención</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((item) => (
                      <tr key={item.record_id}>
                        <td>{field(item.source_name)}</td>
                        <td>{item.action ? field(actionName[item.action]) : 'Pendiente'}</td>
                        <td>
                          {item.proposed
                            ? Object.entries(item.proposed)
                                .map(([key, value]) => `${fieldName[key] ?? key}: ${field(value)}`)
                                .join(' · ')
                            : 'Sin correcciones'}
                        </td>
                        <td>
                          {[...item.conflicts, ...item.warnings]
                            .map(
                              (flag) => flagName[flag] ?? flag.replaceAll('_', ' ').toLowerCase(),
                            )
                            .join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="kmz-pager">
                <button
                  type="button"
                  disabled={previewPage === 1}
                  onClick={() => setPreviewPage(previewPage - 1)}
                >
                  Anterior
                </button>
                <span>Página {previewPage}</span>
                <button
                  type="button"
                  disabled={preview.items.length < 100}
                  onClick={() => setPreviewPage(previewPage + 1)}
                >
                  Siguiente
                </button>
              </div>
            </>
          ) : (
            <p className="empty">No hay operaciones en esta página.</p>
          )}
        </section>
      ) : (
        <>
          <section className="panel kmz-filters" aria-label="Filtros de revisión">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                updateFilter('search', searchInput.trim());
              }}
            >
              <label>
                Buscar por nombre o código
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  maxLength={120}
                  placeholder="Nombre o código KMZ"
                />
              </label>
              <button type="submit">Buscar</button>
            </form>
            <div className="kmz-filter-grid">
              <label>
                Estado
                <select
                  value={filters.state}
                  onChange={(event) => updateFilter('state', event.target.value)}
                >
                  <option value="">Todos</option>
                  {Object.entries(stateName).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ruta o agrupación
                <select
                  value={filters.group}
                  onChange={(event) => updateFilter('group', event.target.value)}
                >
                  <option value="">Todas</option>
                  {facets.groups.map((group) => (
                    <option key={group.path} value={group.path}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ruta semanal
                <select
                  value={filters.week}
                  onChange={(event) => updateFilter('week', event.target.value)}
                >
                  <option value="">Todas</option>
                  {facets.weeks.map((week) => (
                    <option key={week} value={week}>
                      {week}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tipo
                <select
                  value={filters.type}
                  onChange={(event) => updateFilter('type', event.target.value)}
                >
                  <option value="">Todos</option>
                  {[
                    'CLIENT_CANDIDATE',
                    'REFERENCE_POINT',
                    'WEEKLY_STOP',
                    'GEOGRAPHIC_GROUP',
                    'ROUTE_CANDIDATE',
                    'POLYGON',
                    'LINE',
                    'INVALID_OR_OTHER',
                  ].map((type) => (
                    <option key={type} value={type}>
                      {typeName[type] ?? type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Orden
                <select
                  value={filters.sort}
                  onChange={(event) => updateFilter('sort', event.target.value)}
                >
                  <option value="priority">Atención primero</option>
                  <option value="source">Orden del archivo</option>
                  <option value="name">Nombre</option>
                </select>
              </label>
            </div>
          </section>
          <div className="kmz-review-grid">
            <section className="panel kmz-records">
              <div className="panel-head">
                <div>
                  <h2>Registros</h2>
                  <p>
                    {number(total)} con estos filtros · página {filters.page}
                  </p>
                </div>
                {filters.record_id && (
                  <button type="button" onClick={() => setFilters(initial)}>
                    Mostrar todos
                  </button>
                )}
              </div>
              {rows.length === 0 ? (
                <p className="empty">No hay registros con estos filtros. Ajusta la búsqueda.</p>
              ) : (
                <>
                  <div className="kmz-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>
                            <span className="sr-only">Seleccionar</span>
                          </th>
                          <th>Registro KMZ</th>
                          <th>Estado</th>
                          <th>Propuesta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr
                            key={row.record_id}
                            className={selected === row.record_id ? 'selected' : ''}
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Seleccionar ${recordLabel(row)}`}
                                checked={checked.includes(row.record_id)}
                                onChange={(event) => {
                                  setChecked((current) =>
                                    event.target.checked
                                      ? [...current, row.record_id]
                                      : current.filter((value) => value !== row.record_id),
                                  );
                                  setBulkPreview(null);
                                }}
                              />
                            </td>
                            <td>
                              <button
                                className="kmz-row-select"
                                type="button"
                                onClick={() => setSelected(row.record_id)}
                                aria-pressed={selected === row.record_id}
                              >
                                <strong>{recordLabel(row)}</strong>
                                <small>
                                  {row.proposed?.code ?? row.normalized.code ?? 'Sin código'} ·{' '}
                                  {row.source_kind === 'DOCUMENT'
                                    ? 'Documento'
                                    : recordTypeName(row)}
                                </small>
                              </button>
                            </td>
                            <td>
                              <span className={`kmz-state ${row.review_state.toLowerCase()}`}>
                                {stateName[row.review_state] ?? row.review_state}
                              </span>
                              {row.conflicts.length > 0 && (
                                <small>{row.conflicts.length} conflicto(s)</small>
                              )}
                            </td>
                            <td>{row.action ? actionName[row.action] : 'Pendiente'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="kmz-pager">
                    <button
                      type="button"
                      disabled={filters.page === 1}
                      onClick={() => setFilters((value) => ({ ...value, page: value.page - 1 }))}
                    >
                      Anterior
                    </button>
                    <span>
                      {(filters.page - 1) * filters.limit + 1}–
                      {Math.min(filters.page * filters.limit, total)} de {number(total)}
                    </span>
                    <button
                      type="button"
                      disabled={filters.page * filters.limit >= total}
                      onClick={() => setFilters((value) => ({ ...value, page: value.page + 1 }))}
                    >
                      Siguiente
                    </button>
                  </div>
                </>
              )}
              {canWrite && (
                <div className="kmz-bulk">
                  <h3>Acción masiva segura</h3>
                  <p>
                    {checked.length} registros seleccionados. Los conflictos e inválidos no se
                    pueden procesar en conjunto.
                  </p>
                  <label>
                    Acción
                    <select
                      value={bulkAction}
                      onChange={(event) => {
                        setBulkAction(event.target.value as typeof bulkAction);
                        setBulkPreview(null);
                      }}
                    >
                      <option value="EXCLUDE">Excluir</option>
                      <option value="CREATE">Proponer creación</option>
                      <option value="ASSIGN_GROUP">Asignar agrupación</option>
                    </select>
                  </label>
                  {bulkAction === 'EXCLUDE' && (
                    <label>
                      Motivo
                      <input
                        value={bulkReason}
                        onChange={(event) => {
                          setBulkReason(event.target.value);
                          setBulkPreview(null);
                        }}
                        maxLength={500}
                      />
                    </label>
                  )}
                  {bulkAction === 'ASSIGN_GROUP' && (
                    <label>
                      Ruta o agrupación
                      <select
                        value={bulkGroup}
                        onChange={(event) => {
                          setBulkGroup(event.target.value);
                          setBulkPreview(null);
                        }}
                      >
                        <option value="">Seleccionar</option>
                        {facets.group_choices.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={busy || checked.length === 0}
                    onClick={() => void prepareBulk()}
                  >
                    Vista previa
                  </button>
                  {bulkPreview && (
                    <div className="kmz-bulk-confirm">
                      <p>
                        Se guardarán {bulkPreview.count} decisiones de <strong>{bulkAction}</strong>
                        . Revisa los registros:
                      </p>
                      <ul>
                        {bulkPreview.items.map((item) => (
                          <li key={item.record_id}>{field(item.name)}</li>
                        ))}
                      </ul>
                      <button type="button" disabled={busy} onClick={() => void applyBulk()}>
                        Guardar estas decisiones
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setBulkPreview(null)}
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
            <div className="kmz-right">
              <section className="panel kmz-map-panel">
                <div className="panel-head">
                  <h2>Mapa de precarga</h2>
                  <small>{number(points.length)} puntos localizables</small>
                </div>
                <KmzMap
                  points={points}
                  selectedId={selected}
                  candidates={detail?.candidates ?? []}
                  geometry={detail?.geometry ?? null}
                  onSelect={focusRecord}
                />
                {selectedPoint && (
                  <p className="kmz-map-selected">
                    Seleccionado: {field(selectedPoint.name)}.{' '}
                    <button type="button" onClick={() => focusRecord(selectedPoint.record_id)}>
                      Localizar en tabla
                    </button>
                  </p>
                )}
              </section>
              <ReviewDetail
                importId={id}
                detail={detail}
                groups={facets.group_choices}
                canWrite={canWrite}
                busy={busy}
                save={save}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ReviewDetail({
  importId,
  detail,
  groups,
  canWrite,
  busy,
  save,
}: {
  importId: string;
  detail: Detail | null;
  groups: Facets['group_choices'];
  canWrite: boolean;
  busy: boolean;
  save: (change: Change) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Change>({ action: 'PENDING' });
  const [targetSearch, setTargetSearch] = useState('');
  const [searchedCustomers, setSearchedCustomers] = useState<Target[]>([]);
  const [searchedEstablishments, setSearchedEstablishments] = useState<Target[]>([]);
  const [targetError, setTargetError] = useState('');
  const [targetKind, setTargetKind] = useState<'CUSTOMER' | 'ESTABLISHMENT'>('CUSTOMER');
  async function findTarget() {
    setTargetError('');
    try {
      const found = await importsApi.targets(importId, targetKind, targetSearch);
      if (targetKind === 'CUSTOMER') setSearchedCustomers(found.items);
      else setSearchedEstablishments(found.items);
    } catch {
      setTargetError('No se pudo buscar en el catálogo.');
    }
  }
  useEffect(() => {
    if (!detail) return;
    setDraft({
      action: detail.action ?? 'PENDING',
      proposed: {
        name: detail.proposed?.name ?? detail.normalized.name ?? '',
        code: detail.proposed?.code ?? '',
        address: detail.proposed?.address ?? '',
        latitude: detail.proposed?.latitude ?? detail.normalized.point?.latitude,
        longitude: detail.proposed?.longitude ?? detail.normalized.point?.longitude,
        group_id: detail.proposed?.group_id ?? null,
        week_label: detail.proposed?.week_label ?? detail.week_label ?? '',
      },
      target_customer_id: detail.target_customer_id,
      target_customer_version: detail.target_customer_version,
      target_establishment_id: detail.target_establishment_id,
      target_establishment_version: detail.target_establishment_version,
      selected_fields: detail.selected_fields ?? [],
      reason: detail.reason ?? '',
      acknowledged_conflict: detail.acknowledged_conflict ?? false,
    });
  }, [detail]);
  if (!detail)
    return (
      <section className="panel kmz-detail">
        <h2>Comparación</h2>
        <p className="empty">
          Selecciona un registro de la tabla o del mapa para revisar sus datos y candidatos.
        </p>
      </section>
    );
  const candidateCustomers = detail.candidates.filter((item) => item.target_type === 'CUSTOMER');
  const candidateEstablishments = detail.candidates.filter(
    (item) => item.target_type === 'ESTABLISHMENT',
  );
  const customerChoices = [
    ...candidateCustomers.map((item) => ({
      id: item.target_id,
      name: item.target_name ?? 'Cliente sin nombre',
      version: item.target_version ?? 0,
    })),
    ...searchedCustomers,
  ].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  const establishmentChoices = [
    ...candidateEstablishments.map((item) => ({
      id: item.target_id,
      name: item.target_name ?? 'Establecimiento',
      version: item.target_version ?? 0,
    })),
    ...searchedEstablishments,
  ].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  const chosen = customerChoices.find((item) => item.id === draft.target_customer_id);
  const currentCustomer = chosen ?? customerChoices[0];
  const currentEstablishment =
    candidateEstablishments.find((item) => item.target_id === draft.target_establishment_id) ??
    candidateEstablishments[0];
  const groupLabel = (path: string | null | undefined) =>
    path
      ? (groups.find((group) => group.path === path)?.name ?? 'Raíz del archivo')
      : 'Sin agrupación';
  const source = {
    name: currentEstablishment?.target_name ?? currentCustomer?.name,
    code: currentEstablishment?.target_code,
    latitude: currentEstablishment?.latitude,
    longitude: currentEstablishment?.longitude,
    customer: currentCustomer?.name,
    group: null,
    week: null,
  };
  const proposed = {
    name: draft.proposed?.name,
    code: draft.proposed?.code,
    latitude: draft.proposed?.latitude,
    longitude: draft.proposed?.longitude,
    customer: chosen?.name,
    group:
      groups.find((group) => group.id === draft.proposed?.group_id)?.name ??
      groupLabel(detail.parent_path),
    week: draft.proposed?.week_label,
  };
  const update = (key: keyof NonNullable<Change['proposed']>, value: string | number | null) =>
    setDraft((current) => ({ ...current, proposed: { ...current.proposed, [key]: value } }));
  return (
    <section className="panel kmz-detail" aria-labelledby="kmz-detail-title">
      <div className="panel-head">
        <div>
          <h2 id="kmz-detail-title">
            {detail.route_candidate
              ? 'Ruta candidata'
              : detail.record_type === 'GEOGRAPHIC_GROUP'
                ? 'Agrupación'
                : 'Comparación'}
          </h2>
          <p>{detail.normalized.name ?? 'Elemento sin nombre'}</p>
        </div>
        <span className={`kmz-state ${detail.review_state.toLowerCase()}`}>
          {stateName[detail.review_state] ?? detail.review_state}
        </span>
      </div>
      {detail.record_type !== 'GEOGRAPHIC_GROUP' && (
        <p className="kmz-caution">
          Las coincidencias son indicios. Selecciona el cliente explícitamente antes de vincular o
          actualizar.
        </p>
      )}
      <p className="kmz-source-note">
        Origen KMZ: {field(detail.normalized.name)} · código {field(detail.normalized.code)} ·{' '}
        {groupLabel(detail.parent_path)}. El código es una referencia, no una identidad comercial.
      </p>
      {detail.route_candidate && (
        <p className="kmz-caution">
          Ruta candidata del KMZ. Los puntos dentro de esta carpeta se revisan como clientes;
          confirmar clientes no crea ni activa esta ruta.
        </p>
      )}
      {detail.record_type !== 'GEOGRAPHIC_GROUP' && (
        <div className="kmz-compare">
          <div>
            <h3>
              {currentCustomer || currentEstablishment
                ? 'Catálogo actual (candidato)'
                : 'Sin coincidencia en catálogo'}
            </h3>
            <dl>
              {Object.entries(source).map(([key, value]) => (
                <div key={key}>
                  <dt>{fieldName[key] ?? key}</dt>
                  <dd>{field(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3>Datos propuestos</h3>
            <dl>
              {Object.entries(proposed).map(([key, value]) => (
                <div
                  key={key}
                  className={
                    String(value) !== String(source[key as keyof typeof source]) ? 'changed' : ''
                  }
                >
                  <dt>{fieldName[key] ?? key}</dt>
                  <dd>{field(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
      {detail.record_type !== 'GEOGRAPHIC_GROUP' && detail.candidates.length > 0 && (
        <div className="kmz-candidates">
          <h3>Candidatos de coincidencia</h3>
          <ul>
            {detail.candidates.map((item) => (
              <li key={`${item.target_type}:${item.target_id}`}>
                <strong>{item.target_name ?? item.target_type}</strong>
                <span>
                  {item.target_type === 'CUSTOMER' ? 'Cliente' : 'Establecimiento'} ·{' '}
                  {item.distance_m === null
                    ? 'distancia desconocida'
                    : `${Math.round(item.distance_m)} m`}{' '}
                  ·{' '}
                  {item.confidence === 'HIGH'
                    ? 'Confianza alta'
                    : item.confidence === 'MEDIUM'
                      ? 'Confianza media'
                      : 'Confianza baja'}
                </span>
                <small>
                  {item.signals
                    .map((signal) => signalName[signal] ?? 'Otra señal de coincidencia')
                    .join(', ') || 'Sin señales adicionales'}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(detail.conflicts.length > 0 ||
        detail.warnings.length > 0 ||
        detail.parse_errors.length > 0) && (
        <div className="kmz-flags">
          <h3>Advertencias</h3>
          <ul>
            {[...new Set([...detail.conflicts, ...detail.warnings, ...detail.parse_errors])].map(
              (item) => (
                <li key={item}>{flagName[item] ?? item.replaceAll('_', ' ').toLowerCase()}</li>
              ),
            )}
          </ul>
        </div>
      )}
      {canWrite && detail.record_type !== 'GEOGRAPHIC_GROUP' && (
        <form
          className="kmz-edit"
          onSubmit={(event) => {
            event.preventDefault();
            const proposed = { ...draft.proposed };
            if (!proposed.code) delete proposed.code;
            if (!proposed.address) delete proposed.address;
            void save({ ...draft, proposed });
          }}
        >
          <h3>Corregir y decidir</h3>
          <div className="kmz-edit-grid">
            <label>
              Nombre propuesto
              <input
                value={draft.proposed?.name ?? ''}
                onChange={(event) => update('name', event.target.value)}
                maxLength={160}
              />
            </label>
            <label>
              Código GEOPS del cliente (opcional)
              <input
                value={draft.proposed?.code ?? ''}
                onChange={(event) => update('code', event.target.value)}
                maxLength={40}
              />
            </label>
            <label>
              Dirección aprobada (opcional)
              <input
                value={draft.proposed?.address ?? ''}
                onChange={(event) => update('address', event.target.value)}
                maxLength={300}
              />
            </label>
            <label>
              Latitud
              <input
                type="number"
                step="any"
                min="-90"
                max="90"
                value={draft.proposed?.latitude ?? ''}
                onChange={(event) => update('latitude', Number(event.target.value))}
              />
            </label>
            <label>
              Longitud
              <input
                type="number"
                step="any"
                min="-180"
                max="180"
                value={draft.proposed?.longitude ?? ''}
                onChange={(event) => update('longitude', Number(event.target.value))}
              />
            </label>
            <label>
              Ruta semanal candidata
              <input
                value={draft.proposed?.week_label ?? ''}
                onChange={(event) => update('week_label', event.target.value)}
                maxLength={120}
              />
            </label>
            <label>
              Ruta o agrupación propuesta
              <select
                value={draft.proposed?.group_id ?? ''}
                onChange={(event) => update('group_id', event.target.value || null)}
              >
                <option value="">Conservar agrupación de origen</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Acción
              <select
                value={draft.action}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, action: event.target.value as Action }))
                }
              >
                {Object.entries(actionName).map(([action, label]) => (
                  <option key={action} value={action}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(draft.action === 'LINK' || draft.action === 'UPDATE') && (
            <div className="kmz-target-search">
              <label>
                Buscar en catálogo
                <select
                  value={targetKind}
                  onChange={(event) => setTargetKind(event.target.value as typeof targetKind)}
                >
                  <option value="CUSTOMER">Clientes</option>
                  <option value="ESTABLISHMENT">Establecimientos</option>
                </select>
              </label>
              <label>
                Nombre
                <input
                  value={targetSearch}
                  minLength={2}
                  maxLength={120}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder="Escribe al menos dos letras"
                />
              </label>
              <button
                type="button"
                onClick={() => void findTarget()}
                disabled={targetSearch.trim().length < 2}
              >
                Buscar
              </button>
              {targetError && <p role="alert">{targetError}</p>}
            </div>
          )}
          {(draft.action === 'LINK' || draft.action === 'UPDATE') && (
            <>
              <label>
                Cliente existente
                <select
                  value={draft.target_customer_id ?? ''}
                  onChange={(event) => {
                    const match = customerChoices.find((item) => item.id === event.target.value);
                    setDraft((current) => ({
                      ...current,
                      target_customer_id: match?.id ?? null,
                      target_customer_version: match?.version ?? null,
                    }));
                  }}
                  required
                >
                  <option value="">Seleccionar cliente explícitamente</option>
                  {customerChoices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · versión {item.version}
                    </option>
                  ))}
                </select>
              </label>
              {chosen && (
                <p>Seleccionado: {chosen.name}. La distancia por sí sola no valida identidad.</p>
              )}
            </>
          )}
          {establishmentChoices.length > 0 && (
            <label>
              Establecimiento existente (opcional)
              <select
                value={draft.target_establishment_id ?? ''}
                onChange={(event) => {
                  const match = establishmentChoices.find((item) => item.id === event.target.value);
                  setDraft((current) => ({
                    ...current,
                    target_establishment_id: match?.id ?? null,
                    target_establishment_version: match?.version ?? null,
                  }));
                }}
              >
                <option value="">Sin establecimiento asociado</option>
                {establishmentChoices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · versión {item.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.action === 'UPDATE' && (
            <fieldset>
              <legend>Campos a actualizar</legend>
              {[
                ['name', 'Nombre'],
                ['code', 'Código GEOPS del cliente'],
                ['address', 'Dirección'],
                ['coordinates', 'Coordenadas'],
                ['group', 'Agrupación'],
                ['week', 'Ruta semanal'],
              ].map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={draft.selected_fields?.includes(key) ?? false}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        selected_fields: event.target.checked
                          ? [...(current.selected_fields ?? []), key]
                          : (current.selected_fields ?? []).filter((item) => item !== key),
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
          {(draft.action === 'UPDATE' || draft.action === 'EXCLUDE') && (
            <label>
              Motivo
              <textarea
                value={draft.reason ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, reason: event.target.value }))
                }
                maxLength={500}
                required
              />
            </label>
          )}
          {(detail.review_state === 'CONFLICT' ||
            (detail.review_state === 'POSSIBLE_DUPLICATE' && draft.action === 'CREATE')) &&
            draft.action !== 'EXCLUDE' &&
            draft.action !== 'PENDING' && (
              <label className="kmz-check">
                <input
                  type="checkbox"
                  checked={draft.acknowledged_conflict ?? false}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      acknowledged_conflict: event.target.checked,
                    }))
                  }
                />
                Revisé y resolví manualmente los conflictos.
              </label>
            )}
          <button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar en precarga'}
          </button>
          <p className="kmz-caution">Guardar aquí no crea clientes ni genera visitas.</p>
        </form>
      )}
    </section>
  );
}
