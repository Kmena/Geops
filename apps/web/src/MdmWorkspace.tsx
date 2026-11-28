import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiClientError,
  type MdmConfiguration,
  type MdmTimeline,
  type MdmWorkspaceDevice,
  type MdmWorkspacePage,
  type MdmWorkspaceSummary,
} from './api/client.js';
import { useAuth } from './auth.js';
import './mdm-workspace.css';

type Section = 'summary' | 'devices' | 'permissions' | 'diagnostics' | 'corrections' | 'history';
const sections: { key: Section; label: string }[] = [
  { key: 'summary', label: 'Resumen' },
  { key: 'devices', label: 'Dispositivos' },
  { key: 'permissions', label: 'Permisos y configuración' },
  { key: 'diagnostics', label: 'Diagnósticos' },
  { key: 'corrections', label: 'Correcciones' },
  { key: 'history', label: 'Historial y auditoría' },
];
const issueLabels: Record<string, string> = {
  unlinked: 'Vinculación MDM sin verificar',
  permission: 'Permiso faltante',
  battery: 'Restricción de batería',
  capture: 'Captura GPS',
  transmission: 'Transmisión',
  offline: 'Sin comunicación',
  stale: 'Diagnóstico desactualizado',
  no_data: 'Sin diagnóstico',
  configuration: 'Configuración pendiente',
  pending: 'Corrección pendiente',
  no_findings: 'Sin hallazgos recientes',
};
const findingLabels: Record<string, string> = {
  GPS_PERMISSION_MISSING: 'Falta permiso de ubicación',
  GPS_BACKGROUND_PERMISSION_MISSING: 'Falta ubicación en segundo plano',
  GPS_PRECISE_LOCATION_DISABLED: 'Ubicación precisa no disponible',
  LOCATION_SERVICES_DISABLED: 'Servicios de ubicación desactivados',
  GPS_SERVICE_NOT_RUNNING: 'Servicio GPS detenido observado',
  GPS_SERVICE_STATE_UNKNOWN: 'Estado del servicio sin evidencia',
  GPS_CAPTURE_STALE: 'Captura GPS atrasada',
  GPS_TRANSMISSION_STALE: 'Transmisión atrasada',
  SYNC_QUEUE_BACKLOG: 'Cola GPS acumulada',
  BATTERY_RESTRICTION_DETECTED: 'Restricción de batería detectada',
  BACKGROUND_DATA_RESTRICTED: 'Datos de segundo plano restringidos',
  DEVICE_OFFLINE: 'Dispositivo sin comunicación',
  DIAGNOSTIC_STALE: 'Diagnóstico desactualizado',
  CONFIGURATION_INCOMPATIBLE: 'Configuración incompatible',
  UPLOAD_AUTHENTICATION_BLOCKED: 'Autenticación técnica bloqueada',
};
const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('es-GT') : 'Sin dato';
const state = (value: unknown): string => {
  if (value === null || value === undefined || value === 'UNKNOWN')
    return 'Pendiente de verificación';
  const labels: Record<string, string> = {
    AVAILABLE: 'Disponible',
    UNAVAILABLE: 'No disponible',
    UNVERIFIED: 'Sin verificar',
    CORPORATE_MANAGED: 'Corporativo administrado',
    PERSONAL_BYOD: 'Personal (BYOD)',
    CONFIRMED: 'Confirmado',
    POSSIBLE: 'Posible',
    STALE: 'Desactualizado',
    VALIDATED: 'Conectividad validada',
    DISABLED: 'Deshabilitado',
    INVESTIGATION_REQUIRED: 'Requiere investigación',
    CONSOLE_ACTION_REQUIRED: 'Requiere ManageEngine',
    USER_ACTION_REQUIRED: 'Requiere intervención del usuario',
    NOT_SUPPORTED: 'No soportado',
    APP_UPDATE_REQUIRED: 'Requiere actualización de la aplicación',
    APP_CONFIGURATION: 'Configuración de la aplicación',
    AUTO_MDM: 'Automatizable en MDM',
  };
  if (typeof value === 'string' && value in labels) return labels[value] ?? value;
  if (value === true || value === 'GRANTED' || value === 'VALID') return 'Concedido / verificado';
  if (value === false || value === 'DENIED' || value === 'NOT_DECLARED') return 'No concedido';
  if (value === 'RESTRICTED') return 'Restringido';
  if (value === 'NOT_APPLICABLE') return 'No aplica';
  if (value === 'RUNNING_OBSERVED') return 'Activo observado';
  if (value === 'STOPPED_OBSERVED') return 'Detenido observado';
  if (value === 'OFFLINE') return 'Sin conexión';
  return String(value).replaceAll('_', ' ').toLowerCase();
};
function message(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'recent_login_required')
      return 'Vuelve a autenticarte antes de solicitar una corrección.';
    if (error.code === 'mdm_write_disabled')
      return 'La escritura remota ManageEngine está deshabilitada.';
    if (error.status === 403) return 'Tu usuario no tiene permiso o acceso a este dispositivo.';
    if (error.status === 401) return 'La sesión terminó. Vuelve a entrar.';
    if (error.status === 409) return 'El estado cambió. Actualiza y genera una vista previa nueva.';
  }
  return 'No se pudo consultar el backend. Comprueba la conexión y reintenta.';
}
const permissionRows = [
  ['Ubicación precisa', 'fine', 'permissions'],
  ['Ubicación aproximada', 'coarse', 'permissions'],
  ['Ubicación en segundo plano', 'background', 'permissions'],
  ['Servicios de ubicación', 'location_enabled', 'execution'],
  ['Notificaciones', 'notifications', 'permissions'],
  ['Optimización de batería', 'battery_exempt', 'execution'],
  ['Ejecución en segundo plano', 'background_restricted', 'execution'],
  ['Datos en segundo plano', 'data_saver', 'execution'],
  ['Foreground Service', 'foreground_service', 'declaration'],
  ['Foreground Service Location', 'foreground_service_location', 'declaration'],
  ['Recuperación tras reinicio', 'reboot_recovery', 'declaration'],
] as const;

export function MdmWorkspace() {
  const { profile, login } = useAuth();
  const [params, setParams] = useSearchParams();
  const section = sections.find((item) => item.key === params.get('section'))?.key ?? 'summary';
  const selectedId = params.get('device') ?? '';
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [permissionError, setPermissionError] = useState('');
  const [summary, setSummary] = useState<MdmWorkspaceSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [page, setPage] = useState<MdmWorkspacePage | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queryText, setQueryText] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<MdmWorkspaceDevice | null>(null);
  const [configuration, setConfiguration] = useState<MdmConfiguration | null>(null);
  const [capabilities, setCapabilities] = useState<Awaited<
    ReturnType<typeof api.mdmCapabilities>
  > | null>(null);
  const [diagnosis, setDiagnosis] = useState<Record<string, unknown> | null>(null);
  const [timeline, setTimeline] = useState<MdmTimeline | null>(null);
  const [prior, setPrior] = useState<Record<string, unknown>[]>([]);
  const [remediations, setRemediations] = useState<Record<string, unknown>[]>([]);
  const [detailError, setDetailError] = useState('');
  const [kind, setKind] = useState('ALL');
  const [days, setDays] = useState('7');
  const [profileId, setProfileId] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof api.mdmRemediationPreview>
  > | null>(null);
  const [requestKey, setRequestKey] = useState('');
  const [correctionError, setCorrectionError] = useState('');
  const [correctionNotice, setCorrectionNotice] = useState('');
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [reauth, setReauth] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const has = useCallback(
    (permission: string) => permissions?.includes(permission) === true,
    [permissions],
  );
  const query = useMemo(() => {
    const keys = [
      'q',
      'issue',
      'severity',
      'android',
      'app',
      'mdm',
      'age',
      'ownership',
      'sort',
      'direction',
      'page',
    ];
    return Object.fromEntries(
      keys.flatMap((key) => {
        const value = params.get(key);
        return value ? [[key, value]] : [];
      }),
    );
  }, [params]);

  function update(values: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats the backend permission read.
  useEffect(() => {
    let live = true;
    api
      .adminPermissions()
      .then((result) => {
        if (live) {
          setPermissions(result.permissions);
          setPermissionError('');
        }
      })
      .catch((error) => {
        if (live) {
          setPermissions([]);
          setPermissionError(message(error));
        }
      });
    return () => {
      live = false;
    };
  }, [refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats the fleet aggregation.
  useEffect(() => {
    if (!has('mdm.diagnostics.view')) return;
    let live = true;
    api
      .mdmWorkspaceSummary()
      .then((result) => {
        if (live) {
          setSummary(result);
          setSummaryError('');
        }
      })
      .catch((error) => {
        if (live) setSummaryError(message(error));
      });
    return () => {
      live = false;
    };
  }, [has, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats the capability read.
  useEffect(() => {
    if (!has('mdm.policies.view')) return;
    let live = true;
    api
      .mdmCapabilities()
      .then((result) => {
        if (live) setCapabilities(result);
      })
      .catch(() => {
        if (live) setCapabilities(null);
      });
    return () => {
      live = false;
    };
  }, [has, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats the filtered listing.
  useEffect(() => {
    if (!has('mdm.diagnostics.view') || section === 'summary') return;
    let live = true;
    setLoading(true);
    setListError('');
    api
      .mdmWorkspaceDevices(query)
      .then((result) => {
        if (live) setPage(result);
      })
      .catch((error) => {
        if (live) {
          setPage(null);
          setListError(message(error));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [has, section, query, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats selected device reads.
  useEffect(() => {
    if (!selectedId || !has('mdm.diagnostics.view')) {
      setSelected(null);
      setConfiguration(null);
      setDiagnosis(null);
      setTimeline(null);
      return;
    }
    let live = true;
    setDetailError('');
    api
      .mdmWorkspaceDevices({ ids: selectedId, limit: '1' })
      .then((result) => {
        if (live) setSelected(result.items[0] ?? null);
      })
      .catch((error) => {
        if (live) setDetailError(message(error));
      });
    api
      .mdmDeviceDiagnosis(selectedId)
      .then((result) => {
        if (live) setDiagnosis(result as unknown as Record<string, unknown>);
      })
      .catch((error) => {
        if (live) setDetailError(message(error));
      });
    if (has('mdm.policies.view'))
      api
        .mdmConfiguration(selectedId)
        .then((result) => {
          if (live) setConfiguration(result);
        })
        .catch((error) => {
          if (live) setDetailError(message(error));
        });
    if (section === 'history')
      api
        .mdmDeviceHistory(selectedId)
        .then((result) => {
          if (live) setPrior(result.items);
        })
        .catch((error) => {
          if (live) setDetailError(message(error));
        });
    if (section === 'history' && has('mdm.audit.view'))
      api
        .mdmRemediationHistory(selectedId)
        .then((result) => {
          if (live) setRemediations(result.items);
        })
        .catch((error) => {
          if (live) setDetailError(message(error));
        });
    return () => {
      live = false;
    };
  }, [selectedId, section, has, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats the selected timeline.
  useEffect(() => {
    if (
      !selectedId ||
      !has('mdm.diagnostics.view') ||
      !['diagnostics', 'history'].includes(section)
    )
      return;
    let live = true;
    const to = new Date();
    const from = new Date(to.getTime() - Number(days) * 86_400_000);
    api
      .mdmWorkspaceTimeline(selectedId, { from: from.toISOString(), to: to.toISOString(), kind })
      .then((result) => {
        if (live) setTimeline(result);
      })
      .catch((error) => {
        if (live) setDetailError(message(error));
      });
    return () => {
      live = false;
    };
  }, [selectedId, section, days, kind, has, refreshKey]);

  async function previewCorrection(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !profile || correctionBusy || !/^\d{1,30}$/.test(profileId)) return;
    setCorrectionBusy(true);
    setCorrectionError('');
    setCorrectionNotice('');
    setPreview(null);
    try {
      const result = await api.mdmRemediationPreview(selectedId, profileId, profile.csrf_token);
      setPreview(result);
      setRequestKey(crypto.randomUUID());
    } catch (error) {
      setCorrectionError(message(error));
      if (error instanceof ApiClientError && error.code === 'recent_login_required')
        setReauth(true);
    } finally {
      setCorrectionBusy(false);
    }
  }
  async function requestCorrection() {
    if (
      !profile ||
      !preview?.eligible ||
      !preview.preview_digest ||
      !requestKey ||
      reason.trim().length < 8 ||
      correctionBusy
    )
      return;
    setCorrectionBusy(true);
    setCorrectionError('');
    try {
      const result = await api.mdmRemediationRequest(
        {
          device_id: preview.device_id,
          profile_id: preview.profile_id,
          preview_digest: preview.preview_digest,
          idempotency_key: requestKey,
          reason: reason.trim(),
        },
        profile.csrf_token,
      );
      setCorrectionNotice(
        `Solicitud ${result.request_id} registrada para revisión. No se aplicó un cambio MDM.`,
      );
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setCorrectionError(message(error));
      if (error instanceof ApiClientError && error.code === 'recent_login_required')
        setReauth(true);
    } finally {
      setCorrectionBusy(false);
    }
  }
  async function reauthenticate(event: FormEvent) {
    event.preventDefault();
    const current = password.current;
    if (!profile || !current?.value) return;
    try {
      await login(profile.email, current.value);
      setReauth(false);
      setCorrectionError('');
      setCorrectionNotice('Sesión renovada. Repite la vista previa.');
    } catch (error) {
      setCorrectionError(message(error));
    } finally {
      if (current) current.value = '';
    }
  }
  async function exportReport() {
    setListError('');
    try {
      const result = await api.mdmWorkspaceReport(
        selection.length
          ? { ids: selection.join(','), limit: '100' }
          : { ...query, limit: '100', ...(selectedId ? { ids: selectedId } : {}) },
      );
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `GEOPS-MDM-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch (error) {
      setListError(message(error));
    }
  }

  const metrics: { key: keyof MdmWorkspaceSummary; label: string; issue?: string; mdm?: string }[] =
    [
      { key: 'registered', label: 'Dispositivos registrados' },
      { key: 'linked', label: 'Vinculados a ManageEngine', mdm: 'valid' },
      { key: 'unlinked', label: 'Sin vínculo verificado', issue: 'unlinked' },
      { key: 'permission', label: 'Permisos faltantes', issue: 'permission' },
      { key: 'battery', label: 'Batería restringida', issue: 'battery' },
      { key: 'capture', label: 'Problemas de captura', issue: 'capture' },
      { key: 'transmission', label: 'Problemas de transmisión', issue: 'transmission' },
      { key: 'offline', label: 'Sin comunicación reciente', issue: 'offline' },
      { key: 'stale', label: 'Diagnóstico desactualizado', issue: 'stale' },
      { key: 'no_data', label: 'Sin diagnóstico', issue: 'no_data' },
      { key: 'configuration', label: 'Configuración pendiente', issue: 'configuration' },
      { key: 'pending', label: 'Correcciones pendientes', issue: 'pending' },
    ];
  const payload = diagnosis?.payload as
    | { errors?: { code: string; observed_at: string }[] }
    | undefined;
  const diagnosticErrors = payload?.errors ?? [];
  const lastError = (pattern: RegExp) => diagnosticErrors.find((entry) => pattern.test(entry.code));
  return (
    <section className="mdm-workspace" aria-labelledby="mdm-workspace-title">
      <div className="mdm-workspace-head">
        <div>
          <span className="eyebrow">GEOPS · SPEC-05</span>
          <h2 id="mdm-workspace-title">Diagnóstico y administración MDM</h2>
          <p>
            Separa la configuración deseada, la información ManageEngine y lo observado en Android.
          </p>
        </div>
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>
          Actualizar datos
        </button>
      </div>
      {permissionError && (
        <p role="alert" className="notice error">
          {permissionError}
        </p>
      )}
      {permissions === null ? (
        <p role="status">Verificando permisos…</p>
      ) : !has('mdm.diagnostics.view') ? (
        <p role="alert" className="notice">
          Requiere permiso para consultar diagnósticos MDM.
        </p>
      ) : (
        <>
          <nav className="mdm-workspace-tabs" aria-label="Secciones del diagnóstico MDM">
            {sections.map((item) => (
              <button
                type="button"
                key={item.key}
                aria-current={section === item.key ? 'page' : undefined}
                onClick={() => update({ section: item.key, page: '1' })}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {section === 'summary' ? (
            <>
              {summaryError && (
                <p role="alert" className="notice error">
                  {summaryError}
                </p>
              )}
              {!summary && !summaryError && <p role="status">Calculando indicadores…</p>}
              {summary && (
                <>
                  <p className="mdm-source">
                    Fuente: backend GEOPS · actualizado {date(summary.as_of)}. Cumplimiento MDM:
                    pendiente de validar tenant.
                  </p>
                  <div className="mdm-metrics">
                    {metrics.map((item) => (
                      <button
                        type="button"
                        className="mdm-metric"
                        key={item.key}
                        onClick={() =>
                          update({
                            section: 'devices',
                            issue: item.issue ?? null,
                            mdm: item.mdm ?? null,
                            page: '1',
                          })
                        }
                      >
                        <strong>{summary[item.key]}</strong>
                        <span>{item.label}</span>
                      </button>
                    ))}
                    <div className="mdm-metric muted">
                      <strong>—</strong>
                      <span>Dispositivos conformes: sin evidencia MDM</span>
                    </div>
                  </div>
                  <p className="mdm-source">
                    Sin hallazgos en diagnóstico reciente: {summary.no_findings}. Esto no demuestra
                    cumplimiento MDM.
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              <form
                className="mdm-workspace-filters"
                onSubmit={(event) => {
                  event.preventDefault();
                  update({ q: queryText.trim() || null, page: '1' });
                }}
              >
                <label>
                  Buscar equipo o agente
                  <input value={queryText} onChange={(event) => setQueryText(event.target.value)} />
                </label>
                <label>
                  Problema
                  <select
                    value={params.get('issue') ?? ''}
                    onChange={(event) => update({ issue: event.target.value || null, page: '1' })}
                  >
                    <option value="">Todos</option>
                    {Object.entries(issueLabels).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Severidad
                  <select
                    value={params.get('severity') ?? ''}
                    onChange={(event) =>
                      update({ severity: event.target.value || null, page: '1' })
                    }
                  >
                    <option value="">Todas</option>
                    <option value="CONFIRMED">Confirmado</option>
                    <option value="POSSIBLE">Posible</option>
                    <option value="STALE">Desactualizado</option>
                    <option value="OFFLINE">Sin comunicación</option>
                    <option value="UNKNOWN">Sin datos</option>
                  </select>
                </label>
                <label>
                  Android
                  <input
                    value={params.get('android') ?? ''}
                    onChange={(event) => update({ android: event.target.value || null, page: '1' })}
                    placeholder="Ej. 15"
                  />
                </label>
                <label>
                  Versión APK
                  <input
                    value={params.get('app') ?? ''}
                    onChange={(event) => update({ app: event.target.value || null, page: '1' })}
                    placeholder="Ej. 1.0.3"
                  />
                </label>
                <label>
                  Vínculo MDM
                  <select
                    value={params.get('mdm') ?? ''}
                    onChange={(event) => update({ mdm: event.target.value || null, page: '1' })}
                  >
                    <option value="">Todos</option>
                    <option value="valid">Verificado</option>
                    <option value="unverified">Sin verificar</option>
                  </select>
                </label>
                <label>
                  Tipo
                  <select
                    value={params.get('ownership') ?? ''}
                    onChange={(event) =>
                      update({ ownership: event.target.value || null, page: '1' })
                    }
                  >
                    <option value="">Todos</option>
                    <option value="CORPORATE_MANAGED">Corporate</option>
                    <option value="PERSONAL_BYOD">Personal (BYOD)</option>
                    <option value="UNVERIFIED">Sin verificar</option>
                  </select>
                </label>
                <label>
                  Diagnóstico
                  <select
                    value={params.get('age') ?? ''}
                    onChange={(event) => update({ age: event.target.value || null, page: '1' })}
                  >
                    <option value="">Cualquier fecha</option>
                    <option value="fresh">Reciente</option>
                    <option value="stale">Desactualizado</option>
                    <option value="none">Sin datos</option>
                  </select>
                </label>
                <label>
                  Ordenar
                  <select
                    value={params.get('sort') ?? 'name'}
                    onChange={(event) => update({ sort: event.target.value, page: '1' })}
                  >
                    <option value="name">Nombre</option>
                    <option value="contact">Último contacto</option>
                    <option value="diagnosis">Último diagnóstico</option>
                    <option value="android">Android</option>
                    <option value="app">APK</option>
                  </select>
                </label>
                <button type="submit">Buscar</button>
                <button
                  type="button"
                  onClick={() => {
                    setQueryText('');
                    update({
                      q: null,
                      issue: null,
                      severity: null,
                      android: null,
                      app: null,
                      mdm: null,
                      age: null,
                      ownership: null,
                      page: '1',
                    });
                  }}
                >
                  Limpiar filtros
                </button>
              </form>
              {listError && (
                <p role="alert" className="notice error">
                  {listError}
                </p>
              )}
              {loading ? (
                <p role="status">Cargando dispositivos…</p>
              ) : (
                page && (
                  <>
                    <p role="status" className="mdm-source">
                      {page.total} dispositivos · página {page.page} · observación{' '}
                      {date(page.as_of)}
                    </p>
                    {page.items.length === 0 ? (
                      <p className="empty">
                        No hay dispositivos para estos filtros. Una ausencia de datos no es
                        conformidad.
                      </p>
                    ) : (
                      <div className="mdm-workspace-table-wrap">
                        <table className="mdm-workspace-table">
                          <caption>Dispositivos GEOPS visibles para tu organización</caption>
                          <thead>
                            <tr>
                              <th>Seleccionar</th>
                              <th>Dispositivo</th>
                              <th>Agente / organización</th>
                              <th>Android / APK</th>
                              <th>MDM</th>
                              <th>GPS y transmisión</th>
                              <th>Contacto / diagnóstico</th>
                              <th>Hallazgos</th>
                              <th>Acción</th>
                            </tr>
                          </thead>
                          <tbody>
                            {page.items.map((item) => (
                              <tr key={item.device_id}>
                                <td>
                                  <input
                                    type="checkbox"
                                    aria-label={`Seleccionar ${item.display_label}`}
                                    checked={selection.includes(item.device_id)}
                                    onChange={(event) =>
                                      setSelection((current) =>
                                        event.target.checked
                                          ? [...current, item.device_id].slice(0, 100)
                                          : current.filter((id) => id !== item.device_id),
                                      )
                                    }
                                  />
                                </td>
                                <td>
                                  <strong>{item.display_label}</strong>
                                  <small>
                                    {item.manufacturer ?? 'Fabricante sin dato'} {item.model ?? ''}
                                  </small>
                                  <small>
                                    {state(item.ownership)} · {state(item.status)}
                                  </small>
                                </td>
                                <td>
                                  {item.agent_name ?? 'Sin agente'}
                                  <small>{item.tenant_id}</small>
                                </td>
                                <td>
                                  {item.android_release ?? 'Sin dato'}
                                  <small>{item.app_version ?? 'APK sin dato'}</small>
                                </td>
                                <td>
                                  {item.mdm_link_state === 'VALID' ? 'Vinculado' : 'Sin verificar'}
                                </td>
                                <td>
                                  {state(item.gps?.service)}
                                  <small>
                                    {item.flags.transmission_problem
                                      ? 'Transmisión atrasada'
                                      : item.flags.no_data
                                        ? 'Sin diagnóstico'
                                        : 'Transmisión sin falla confirmada'}
                                  </small>
                                </td>
                                <td>
                                  {date(item.last_contact_at)}
                                  <small>Diagnóstico: {date(item.received_at)}</small>
                                </td>
                                <td>
                                  {item.flags.no_data
                                    ? 'Sin datos'
                                    : item.flags.stale
                                      ? 'Desactualizado'
                                      : item.findings.length
                                        ? item.findings
                                            .map(
                                              (finding) =>
                                                findingLabels[finding.code] ?? 'Hallazgo técnico',
                                            )
                                            .join(', ')
                                        : 'Sin hallazgos detectados'}
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    onClick={() => update({ device: item.device_id })}
                                  >
                                    Ver detalle
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="mdm-pages">
                      <button
                        type="button"
                        disabled={page.page <= 1}
                        onClick={() => update({ page: String(page.page - 1) })}
                      >
                        Anterior
                      </button>
                      <span>
                        Página {page.page} de {Math.max(1, Math.ceil(page.total / page.limit))}
                      </span>
                      <button
                        type="button"
                        disabled={page.page * page.limit >= page.total}
                        onClick={() => update({ page: String(page.page + 1) })}
                      >
                        Siguiente
                      </button>
                    </div>
                  </>
                )
              )}
              {has('mdm.diagnostics.export') && (
                <button type="button" onClick={() => void exportReport()}>
                  Exportar{' '}
                  {selection.length
                    ? `${selection.length} seleccionados`
                    : selectedId
                      ? 'dispositivo seleccionado'
                      : 'primera página filtrada'}{' '}
                  (JSON)
                </button>
              )}
              {selection.length > 0 && (
                <button type="button" onClick={() => setSelection([])}>
                  Limpiar selección
                </button>
              )}
              {selectedId && (
                <section className="mdm-device-detail" aria-labelledby="mdm-device-title">
                  <div className="mdm-detail-heading">
                    <h3 id="mdm-device-title">Detalle del dispositivo</h3>
                    <button type="button" onClick={() => update({ device: null })}>
                      Cerrar detalle
                    </button>
                  </div>
                  {detailError && (
                    <p role="alert" className="notice error">
                      {detailError}
                    </p>
                  )}
                  {!selected && !detailError && <p role="status">Consultando detalle…</p>}
                  {selected && (
                    <>
                      <div className="mdm-detail-grid">
                        <div>
                          <h4>Información general</h4>
                          <dl>
                            <dt>Equipo</dt>
                            <dd>{selected.display_label}</dd>
                            <dt>Identidad GEOPS</dt>
                            <dd>{selected.device_id}</dd>
                            <dt>Organización / agente</dt>
                            <dd>
                              {selected.tenant_id} · {selected.agent_name ?? 'Sin asignación'}
                            </dd>
                            <dt>Modelo / Android / APK</dt>
                            <dd>
                              {selected.manufacturer ?? 'Sin dato'} {selected.model ?? ''} ·{' '}
                              {selected.android_release ?? 'Sin dato'} ·{' '}
                              {selected.app_version ?? 'Sin dato'}
                            </dd>
                            <dt>Activación / enrolamiento</dt>
                            <dd>
                              {selected.installation_id
                                ? 'Instalación activa'
                                : 'Sin instalación activa'}{' '}
                              ·{' '}
                              {selected.mdm_link_state === 'VALID'
                                ? 'Vínculo MDM verificado'
                                : 'Vínculo pendiente'}
                            </dd>
                            <dt>Última comunicación</dt>
                            <dd>{date(selected.last_contact_at)}</dd>
                          </dl>
                        </div>
                        <div>
                          <h4>Estado de evidencia</h4>
                          <p>
                            {selected.flags.no_data
                              ? 'No hay diagnóstico Android.'
                              : selected.flags.stale
                                ? 'El diagnóstico está desactualizado.'
                                : selected.flags.offline
                                  ? 'El equipo está sin comunicación reciente.'
                                  : 'Diagnóstico reciente disponible.'}
                          </p>
                          <p>
                            Fuente Android: {date(selected.observed_at)} · recibido:{' '}
                            {date(selected.received_at)}
                          </p>
                          <p>
                            ManageEngine:{' '}
                            {configuration?.read_state === 'AVAILABLE'
                              ? 'Lectura disponible'
                              : 'Tenant o lectura sin verificar'}
                          </p>
                        </div>
                      </div>
                      {(section === 'devices' || section === 'permissions') && (
                        <>
                          <h4>Matriz de permisos y configuración</h4>
                          <div className="mdm-workspace-table-wrap">
                            <table className="mdm-workspace-table">
                              <thead>
                                <tr>
                                  <th>Configuración</th>
                                  <th>Deseada</th>
                                  <th>Asignada</th>
                                  <th>Aplicada MDM</th>
                                  <th>Efectiva Android</th>
                                  <th>Estado / acción</th>
                                </tr>
                              </thead>
                              <tbody>
                                {permissionRows.map(([label, key, source]) => {
                                  const value =
                                    source === 'permissions'
                                      ? selected.permissions?.[key]
                                      : source === 'execution'
                                        ? selected.execution?.[key]
                                        : null;
                                  return (
                                    <tr key={key}>
                                      <th scope="row">{label}</th>
                                      <td>
                                        {source === 'declaration'
                                          ? 'Requisito técnico de la APK'
                                          : key === 'coarse'
                                            ? 'Según política'
                                            : 'Requerida para seguimiento autorizado'}
                                      </td>
                                      <td>Pendiente de verificar</td>
                                      <td>Pendiente de verificar</td>
                                      <td>
                                        {state(value)}
                                        <small>
                                          {source === 'declaration'
                                            ? 'Sin señal en snapshot remoto'
                                            : `Android · ${date(selected.observed_at)}`}
                                        </small>
                                      </td>
                                      <td>
                                        {value === 'DENIED' ||
                                        value === 'RESTRICTED' ||
                                        value === false
                                          ? 'Revisar permiso o política'
                                          : 'Consultar evidencia'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          <p className="mdm-source">
                            Foreground Service, su tipo ubicación y recuperación tras reinicio son
                            declaraciones/capacidades de la APK; no equivalen a un permiso efectivo
                            ni a ejecución continua. El snapshot remoto aún no trae su estado
                            individual.
                          </p>
                          <h4>Configuración GPS</h4>
                          <p>
                            Captura efectiva: {state(selected.gps?.capture_interval_s)} s ·
                            transmisión efectiva: {state(selected.gps?.sync_interval_s)} s ·
                            revisión: {state(selected.gps?.policy_revision)}. Fuente: APK Android.
                          </p>
                          <p>
                            Intervalos deseados y última modificación: no expuestos en el contrato
                            administrativo actual. Perfil MDM asignado:{' '}
                            {state(configuration?.assigned?.state)}; aplicación MDM por permiso:
                            pendiente. No existe contrato seguro de edición GPS desde este
                            workspace.
                          </p>
                        </>
                      )}
                      {(section === 'devices' || section === 'diagnostics') && (
                        <>
                          <h4>Diagnóstico GPS v2</h4>
                          <dl className="mdm-gps-dl">
                            <div>
                              <dt>Servicio</dt>
                              <dd>{state(selected.gps?.service)}</dd>
                            </div>
                            <div>
                              <dt>Última captura</dt>
                              <dd>{date(String(selected.gps?.last_capture_at ?? ''))}</dd>
                            </div>
                            <div>
                              <dt>Último intento de transmisión</dt>
                              <dd>No disponible en el snapshot actual</dd>
                            </div>
                            <div>
                              <dt>Último ACK</dt>
                              <dd>{date(String(selected.gps?.last_ack_at ?? ''))}</dd>
                            </div>
                            <div>
                              <dt>Pendientes</dt>
                              <dd>{state(selected.gps?.pending_positions)}</dd>
                            </div>
                            <div>
                              <dt>Último error de captura</dt>
                              <dd>
                                {lastError(/CAPTURE|LOCATION|GPS/) ? (
                                  <details>
                                    <summary>
                                      Error observado{' '}
                                      {date(lastError(/CAPTURE|LOCATION|GPS/)?.observed_at)}
                                    </summary>
                                    {lastError(/CAPTURE|LOCATION|GPS/)?.code}
                                  </details>
                                ) : diagnosis ? (
                                  'Sin error reciente reportado'
                                ) : (
                                  'Sin dato'
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>Último error de transmisión</dt>
                              <dd>
                                {lastError(/UPLOAD|SYNC|TRANSMISSION|HTTP/) ? (
                                  <details>
                                    <summary>
                                      Error observado{' '}
                                      {date(
                                        lastError(/UPLOAD|SYNC|TRANSMISSION|HTTP/)?.observed_at,
                                      )}
                                    </summary>
                                    {lastError(/UPLOAD|SYNC|TRANSMISSION|HTTP/)?.code}
                                  </details>
                                ) : diagnosis ? (
                                  'Sin error reciente reportado'
                                ) : (
                                  'Sin dato'
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>Autenticación</dt>
                              <dd>
                                {selected.gps?.upload_auth_blocked === true
                                  ? 'Bloqueada'
                                  : 'Sin bloqueo observado'}
                              </dd>
                            </div>
                            <div>
                              <dt>Internet</dt>
                              <dd>{state(selected.execution?.internet)}</dd>
                            </div>
                            <div>
                              <dt>Sincronización</dt>
                              <dd>
                                Cola: {state(selected.gps?.pending_positions)}; sin estado
                                independiente
                              </dd>
                            </div>
                            <div>
                              <dt>Frecuencia de captura / transmisión</dt>
                              <dd>
                                {state(selected.gps?.capture_interval_s)} s /{' '}
                                {state(selected.gps?.sync_interval_s)} s
                              </dd>
                            </div>
                            <div>
                              <dt>Intervalos reales observados</dt>
                              <dd>No disponibles en el snapshot actual</dd>
                            </div>
                          </dl>
                          <p className="mdm-source">
                            El snapshot Wave 2 no incluye último intento de transmisión ni hora de
                            cada evento FGS. La ausencia de posiciones no demuestra servicio
                            detenido.
                          </p>
                          <h4>Hallazgos del backend</h4>
                          {selected.findings.length ? (
                            <ul>
                              {selected.findings.map((finding) => (
                                <li key={`${finding.code}-${finding.source}`}>
                                  {findingLabels[finding.code] ?? 'Hallazgo técnico'} ·{' '}
                                  {state(finding.classification)}
                                  <details>
                                    <summary>Detalle técnico</summary>
                                    {finding.code} · fuente {finding.source}
                                  </details>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>
                              Sin hallazgos en el último diagnóstico; la evidencia MDM puede seguir
                              pendiente.
                            </p>
                          )}
                        </>
                      )}
                      {(section === 'devices' || section === 'permissions') && (
                        <>
                          <h4>ManageEngine</h4>
                          {!has('mdm.policies.view') ? (
                            <p>Requiere permiso de políticas MDM.</p>
                          ) : !configuration ? (
                            <p>Tenant no verificado o configuración no disponible.</p>
                          ) : (
                            <>
                              <p>
                                Vínculo: {state(configuration.link_state)} · lectura:{' '}
                                {state(configuration.read_state)} · ID verificado:{' '}
                                {configuration.mdm_device_id ?? 'No disponible'}.
                              </p>
                              <p>
                                Perfiles asignados: {state(configuration.assigned.state)} ·
                                aplicados reportados: {configuration.applied_reported.length} ·
                                último contacto inventario:{' '}
                                {date(configuration.inventory_last_seen_at)}.
                              </p>
                              {configuration.assigned.items.length ? (
                                <ul>
                                  {configuration.assigned.items.map((item, index) => (
                                    <li key={String(item.profile_id ?? index)}>
                                      Perfil {String(item.profile_id ?? 'sin ID')} ·{' '}
                                      {state(item.distribution)}. Fuente ManageEngine:{' '}
                                      {date(configuration.vendor_fetched_at)}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p>Sin perfiles asignados reportados por la lectura disponible.</p>
                              )}
                              {configuration.findings.length > 0 && (
                                <ul>
                                  {configuration.findings.map((item) => (
                                    <li key={`${item.code}-${item.source}`}>
                                      Discrepancia MDM:{' '}
                                      {findingLabels[item.code] ?? 'Requiere revisión técnica'} ·{' '}
                                      {state(item.classification)}
                                      <details>
                                        <summary>Código y fuente</summary>
                                        {item.code} · {item.source}
                                      </details>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <p>
                                Aplicación administrada:{' '}
                                {configuration.app ? 'Reportada' : 'Sin dato'} · cumplimiento:
                                pendiente de evidencia real.
                              </p>
                              <p>
                                Capacidades de lectura/escritura:{' '}
                                {capabilities
                                  ? `${capabilities.capabilities.filter((item) => item.state === 'DOCUMENTED_NOT_VERIFIED').length} documentadas sin verificar; escritura ${capabilities.write_enabled ? 'habilitada' : 'deshabilitada'}`
                                  : 'sin lectura disponible'}
                                . Tenant real: pendiente de confirmar.
                              </p>
                              <p>
                                Escritura ManageEngine deshabilitada hasta verificar edición,
                                licencia, API y scopes del tenant.
                              </p>
                            </>
                          )}
                        </>
                      )}
                      {(section === 'diagnostics' || section === 'history') && (
                        <>
                          <div className="mdm-timeline-head">
                            <h4>Línea temporal de evidencia</h4>
                            <label>
                              Rango
                              <select
                                value={days}
                                onChange={(event) => setDays(event.target.value)}
                              >
                                <option value="1">24 horas</option>
                                <option value="7">7 días</option>
                                <option value="30">30 días</option>
                              </select>
                            </label>
                            <label>
                              Tipo
                              <select
                                value={kind}
                                onChange={(event) => setKind(event.target.value)}
                              >
                                <option value="ALL">Todos</option>
                                <option value="DIAGNOSTIC">Diagnóstico</option>
                                <option value="GPS">GPS y red</option>
                                <option value="PERMISSION">Permisos</option>
                                <option value="CONFIGURATION">Configuración</option>
                                <option value="REMEDIATION">Correcciones</option>
                                <option value="ADMIN">Administración</option>
                              </select>
                            </label>
                          </div>
                          {!timeline ? (
                            <p role="status">Cargando eventos disponibles…</p>
                          ) : (
                            <>
                              {timeline.truncated && (
                                <p className="notice">
                                  Historial limitado a 100 diagnósticos recientes.
                                </p>
                              )}
                              {timeline.items.length ? (
                                <ol className="mdm-timeline">
                                  {timeline.items.map((event) => (
                                    <li
                                      key={`${event.evidence_ref}-${event.type}-${event.at}-${event.label}`}
                                    >
                                      <time dateTime={event.at}>{date(event.at)}</time>
                                      <strong>{event.label}</strong>
                                      <small>Fuente: {event.source}</small>
                                      <details>
                                        <summary>Referencia técnica</summary>
                                        {event.evidence_ref}
                                      </details>
                                    </li>
                                  ))}
                                </ol>
                              ) : (
                                <p className="empty">No hay eventos observados en este rango.</p>
                              )}
                              <p className="mdm-source">
                                No disponibles: {timeline.unavailable.join('; ')}.
                              </p>
                            </>
                          )}
                        </>
                      )}
                      {section === 'history' && (
                        <>
                          <h4>Diagnósticos anteriores</h4>
                          <p>{prior.length} registros recientes disponibles.</p>
                          <h4>Solicitudes y auditoría</h4>
                          {has('mdm.audit.view') ? (
                            remediations.length ? (
                              <ul>
                                {remediations.map((item) => (
                                  <li
                                    key={String(
                                      item.request_id ??
                                        item.id ??
                                        `${item.requested_at}-${item.profile_id}`,
                                    )}
                                  >
                                    {date(String(item.requested_at ?? ''))} · {state(item.state)} ·
                                    perfil {state(item.profile_id)}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p>No hay solicitudes registradas para este equipo.</p>
                            )
                          ) : (
                            <p>Requiere permiso de auditoría MDM.</p>
                          )}
                        </>
                      )}
                      {section === 'corrections' && (
                        <>
                          <h4>Correcciones administrativas</h4>
                          <p className="mdm-source">
                            Escritura remota deshabilitada. Puedes registrar una solicitud local
                            para revisión; ninguna acción modifica ManageEngine.
                          </p>
                          <p>
                            La lectura de perfiles y permisos por app aún no está confirmada en el
                            tenant. Ninguna solicitud equivale a un cambio aplicado.
                          </p>
                          {configuration?.correction_actions.map((item) => (
                            <p key={item.kind}>
                              {state(item.classification)}: {item.reason}
                            </p>
                          ))}
                          {!has('mdm.permissions.remediate') ? (
                            <p>Requiere permiso para solicitar correcciones.</p>
                          ) : (
                            <>
                              <form
                                className="mdm-correction-form"
                                onSubmit={(event) => void previewCorrection(event)}
                              >
                                <label>
                                  ID numérico de perfil ManageEngine
                                  <input
                                    inputMode="numeric"
                                    value={profileId}
                                    onChange={(event) => {
                                      setProfileId(event.target.value);
                                      setPreview(null);
                                    }}
                                    required
                                  />
                                </label>
                                <label>
                                  Motivo (mínimo 8 caracteres)
                                  <textarea
                                    value={reason}
                                    onChange={(event) => setReason(event.target.value)}
                                    minLength={8}
                                    maxLength={240}
                                    required
                                  />
                                </label>
                                <button
                                  type="submit"
                                  disabled={correctionBusy || !/^\d{1,30}$/.test(profileId)}
                                >
                                  Generar vista previa
                                </button>
                              </form>
                              {correctionError && (
                                <p role="alert" className="notice error">
                                  {correctionError}
                                </p>
                              )}
                              {correctionNotice && (
                                <p role="status" className="notice">
                                  {correctionNotice}
                                </p>
                              )}
                              {reauth && (
                                <form
                                  onSubmit={(event) => void reauthenticate(event)}
                                  className="mdm-correction-form"
                                >
                                  <p>
                                    La corrección requiere inicio de sesión reciente del mismo
                                    usuario.
                                  </p>
                                  <label>
                                    Contraseña GEOPS
                                    <input
                                      ref={password}
                                      type="password"
                                      autoComplete="current-password"
                                      required
                                    />
                                  </label>
                                  <button type="submit">Reautenticarse</button>
                                </form>
                              )}
                              {preview && (
                                <div className="mdm-preview">
                                  <h4>Vista previa</h4>
                                  <p>
                                    Elegible:{' '}
                                    {preview.eligible ? 'Sí, para registrar solicitud' : 'No'} ·
                                    impacto: {preview.impact_device_count ?? 'No verificado'}{' '}
                                    dispositivo.
                                  </p>
                                  <p>Motivo de bloqueo o requisito: {preview.reason}.</p>
                                  <p>Escritura MDM real: deshabilitada.</p>
                                  {preview.eligible && preview.preview_digest && (
                                    <button
                                      type="button"
                                      disabled={correctionBusy || reason.trim().length < 8}
                                      onClick={() => {
                                        if (
                                          window.confirm(
                                            'Se registrará la solicitud; no se aplicará ningún cambio MDM.',
                                          )
                                        )
                                          void requestCorrection();
                                      }}
                                    >
                                      Confirmar solicitud local
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                          <p className="mdm-source">
                            Acciones masivas: solo consulta y exportación; asociación real de
                            perfiles permanece bloqueada por <code>mdm_write_disabled</code>.
                          </p>
                        </>
                      )}
                    </>
                  )}
                </section>
              )}
              {section === 'diagnostics' && (
                <p className="mdm-source">
                  Solicitud remota inmediata: no soportada por el transporte actual. El dispositivo
                  envía diagnósticos al reconectarse según su programación, sin polling adicional.
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
