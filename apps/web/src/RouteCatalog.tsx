import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiClientError,
  type CatalogClient,
  type CatalogRoute,
  type CatalogSite,
  type RouteRevision,
  type RouteStop,
} from './api/client.js';
import { useAuth } from './auth.js';
import { RouteMap } from './RouteMap.js';

const errorText = (error: unknown) => {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'No tienes permiso para administrar rutas.';
    if (error.status === 412 || error.status === 428)
      return 'La ruta cambió. Recarga antes de guardar.';
    if (error.code === 'stale_geofence')
      return 'Una geozona cambió. Actualiza las paradas antes de publicar.';
    if (error.code === 'empty_route')
      return 'Agrega al menos una parada obligatoria antes de publicar.';
    if (error.status === 422) return 'Revisa los campos, sedes, geozonas y tiempos de permanencia.';
    if (error.status === 409)
      return 'El código ya existe o la operación entra en conflicto con otra edición.';
  }
  return 'No se pudo completar la operación. Revisa la conexión.';
};
const stopInput = (stop: RouteStop) => ({
  stop_id: stop.stop_id,
  site_id: stop.site_id,
  geofence_revision: stop.geofence_revision,
  required: stop.required,
  suggested_order: stop.suggested_order,
  min_dwell_s: stop.min_dwell_s,
});

export function RouteCatalog() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [canRead, setCanRead] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [limits, setLimits] = useState({ max_radius_m: 100000, max_dwell_s: 86400 });
  const [permissionLoading, setPermissionLoading] = useState(true);
  const [routes, setRoutes] = useState<CatalogRoute[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [route, setRoute] = useState<CatalogRoute | null>(null);
  const [form, setForm] = useState({ code: '', name: '', description: '' });
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [clients, setClients] = useState<CatalogClient[]>([]);
  const [clientCursor, setClientCursor] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<CatalogClient | null>(null);
  const [sites, setSites] = useState<CatalogSite[]>([]);
  const [history, setHistory] = useState<Omit<RouteRevision, 'stops' | 'route_id'>[]>([]);
  const [historyView, setHistoryView] = useState<RouteRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    if (!profile) return;
    void api
      .catalogCapabilities()
      .then((result) => {
        if (!live) return;
        setCanRead(result.capabilities.includes('visit.catalog.read'));
        setCanWrite(result.capabilities.includes('visit.catalog.write'));
        setLimits(result.limits);
      })
      .catch(() => {
        if (live) setError('No se pudieron comprobar los permisos.');
      })
      .finally(() => {
        if (live) setPermissionLoading(false);
      });
    return () => {
      live = false;
    };
  }, [profile]);

  const loadRoutes = useCallback(
    async (next?: string) => {
      try {
        const result = await api.routes({
          ...(filter ? { q: filter } : {}),
          ...(next ? { cursor: next } : {}),
        });
        setRoutes((current) => (next ? [...current, ...result.items] : result.items));
        setCursor(result.next_cursor);
      } catch (failure) {
        setError(errorText(failure));
      }
    },
    [filter],
  );
  useEffect(() => {
    if (canRead) void loadRoutes();
  }, [canRead, loadRoutes]);

  const loadRoute = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, revisions] = await Promise.all([api.route(id), api.routeRevisions(id)]);
      setRoute(detail);
      setForm({ code: detail.code, name: detail.name, description: detail.description });
      setStops(detail.stops ?? []);
      setHistory(revisions.items);
      setHistoryView(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [id]);
  useEffect(() => {
    setRoute(null);
    setStops([]);
    setHistory([]);
    setHistoryView(null);
    if (canRead && id) void loadRoute();
  }, [canRead, id, loadRoute]);

  const loadClients = useCallback(
    async (next?: string) => {
      try {
        const result = await api.clients({
          state: 'ACTIVE',
          ...(clientQuery ? { q: clientQuery } : {}),
          ...(next ? { cursor: next } : {}),
        });
        setClients((current) => (next ? [...current, ...result.items] : result.items));
        setClientCursor(result.next_cursor);
      } catch (failure) {
        setError(errorText(failure));
      }
    },
    [clientQuery],
  );
  useEffect(() => {
    if (canRead && id) void loadClients();
  }, [canRead, id, loadClients]);
  useEffect(() => {
    let live = true;
    if (!selectedClient) {
      setSites([]);
      return;
    }
    void api
      .sites(selectedClient.id)
      .then((result) => {
        if (live) setSites(result.items.filter((site) => site.state === 'ACTIVE'));
      })
      .catch((failure) => {
        if (live) setError(errorText(failure));
      });
    return () => {
      live = false;
    };
  }, [selectedClient]);

  async function execute(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    await execute(async () => {
      const saved = await api.createRoute(form, profile.csrf_token);
      await loadRoutes();
      navigate(`/routes/${saved.id}`);
    }, 'Ruta creada. Agrega sus paradas.');
  }
  async function addSite(site: CatalogSite) {
    if (!selectedClient || stops.some((stop) => stop.site_id === site.id)) {
      setError('La sede ya está incluida en esta ruta.');
      return;
    }
    try {
      const zones = await api.geofences(selectedClient.id, site.id);
      const zone = zones.items[0];
      if (zone?.state !== 'ACTIVE') {
        setError('Esta sede no tiene una geozona activa.');
        return;
      }
      setStops((current) => [
        ...current,
        {
          stop_id: crypto.randomUUID(),
          client_id: selectedClient.id,
          site_id: site.id,
          geofence_revision: zone.revision,
          required: true,
          suggested_order: current.length + 1,
          min_dwell_s: null,
          min_dwell_effective_s: zone.min_dwell_s,
          client_code: selectedClient.code,
          client_name: selectedClient.name,
          site_code: site.code,
          site_name: site.name,
          latitude: zone.latitude,
          longitude: zone.longitude,
          radius_m: zone.radius_m,
        },
      ]);
      setNotice(`${site.name} añadida al borrador local. Guarda la ruta.`);
      setError('');
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  function updateStop(stopId: string, change: Partial<RouteStop>) {
    setStops((current) =>
      current.map((stop) => (stop.stop_id === stopId ? { ...stop, ...change } : stop)),
    );
  }
  function move(stopId: string, offset: number) {
    setStops((current) => {
      const copy = [...current];
      const index = copy.findIndex((stop) => stop.stop_id === stopId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= copy.length) return current;
      const first = copy[index];
      const second = copy[target];
      if (!first || !second) return current;
      copy[index] = second;
      copy[target] = first;
      return copy.map((stop, i) => ({ ...stop, suggested_order: i + 1 }));
    });
  }
  async function save() {
    if (!route || !profile) return;
    if (
      stops.some(
        (stop) =>
          stop.min_dwell_s !== null &&
          (!Number.isInteger(stop.min_dwell_s) ||
            stop.min_dwell_s < 1 ||
            stop.min_dwell_s > limits.max_dwell_s),
      )
    ) {
      setError('La permanencia debe estar dentro del límite configurado.');
      return;
    }
    await execute(async () => {
      let version = route.version;
      if (
        form.code !== route.code ||
        form.name !== route.name ||
        form.description !== route.description
      ) {
        const metadata = await api.patchRoute(route.id, version, form, profile.csrf_token);
        version = metadata.version;
      }
      const saved = await api.saveRouteStops(
        route.id,
        version,
        stops.map(stopInput),
        profile.csrf_token,
      );
      setRoute(saved);
      setStops(saved.stops ?? []);
      await loadRoutes();
    }, 'Borrador guardado. El orden es solo visual.');
  }
  async function publish() {
    if (!route || !profile) return;
    await execute(async () => {
      const saved = await api.publishRoute(route.id, route.version, profile.csrf_token);
      setRoute(saved);
      setStops(saved.stops ?? []);
      setHistory((await api.routeRevisions(route.id)).items);
      await loadRoutes();
    }, 'Versión publicada e inmutable.');
  }
  async function setState(state: 'ACTIVE' | 'INACTIVE') {
    if (!route || !profile) return;
    await execute(
      async () => {
        await api.setRouteState(route.id, route.version, state, profile.csrf_token);
        await loadRoute();
        await loadRoutes();
      },
      state === 'ACTIVE' ? 'Ruta activada.' : 'Ruta desactivada; el historial permanece.',
    );
  }
  if (permissionLoading)
    return (
      <main className="catalog-page">
        <p role="status">Comprobando permisos…</p>
      </main>
    );
  if (!canRead)
    return (
      <main className="catalog-page">
        <div role="alert" className="notice error">
          No tienes permiso para consultar rutas.
        </div>
      </main>
    );

  return (
    <div className="catalog-page route-page">
      <header className="catalog-title">
        <div>
          <p className="eyebrow">SPEC-03 · Wave 2</p>
          <h1>Rutas reutilizables</h1>
          <p>Organiza visitas por sede. El orden sugerido no condiciona el cumplimiento.</p>
        </div>
      </header>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
      <div className="catalog-layout">
        <aside className="catalog-list" aria-label="Catálogo de rutas">
          <form
            className="catalog-search"
            onSubmit={(event) => {
              event.preventDefault();
              setFilter(search.trim());
            }}
          >
            <label>
              Buscar rutas
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Código o nombre"
              />
            </label>
            <button type="submit">Buscar</button>
          </form>
          <ul>
            {routes.map((item) => (
              <li key={item.id}>
                <Link to={`/routes/${item.id}`} aria-current={item.id === id ? 'page' : undefined}>
                  <strong>{item.code}</strong>
                  <br />
                  {item.name}
                  <br />
                  <small>
                    {item.state === 'ACTIVE' ? 'Activa' : 'Inactiva'} · versión{' '}
                    {item.published_revision || 'sin publicar'}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
          {cursor && (
            <button type="button" className="secondary" onClick={() => void loadRoutes(cursor)}>
              Cargar más
            </button>
          )}
          <Link to="/routes" className="route-new-link">
            Nueva ruta
          </Link>
        </aside>
        <div className="catalog-detail">
          {!id && (
            <section className="catalog-section">
              <h2>Crear ruta</h2>
              <p>El código es único en la empresa. Podrás agregar sedes después de crearla.</p>
              <form onSubmit={(event) => void create(event)} className="catalog-fields">
                <label>
                  Código
                  <input
                    required
                    maxLength={40}
                    value={form.code}
                    onChange={(event) =>
                      setForm({ ...form, code: event.target.value.toUpperCase() })
                    }
                    disabled={!canWrite || busy}
                  />
                </label>
                <label>
                  Nombre
                  <input
                    required
                    maxLength={160}
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    disabled={!canWrite || busy}
                  />
                </label>
                <label className="wide">
                  Descripción
                  <input
                    maxLength={1000}
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                    disabled={!canWrite || busy}
                  />
                </label>
                {canWrite && (
                  <button type="submit" disabled={busy}>
                    Crear ruta
                  </button>
                )}
              </form>
            </section>
          )}
          {id && !route && (
            <section className="catalog-section">
              <p role="status">Cargando ruta…</p>
            </section>
          )}
          {route && (
            <>
              <section className="catalog-section">
                <div className="catalog-section-head">
                  <div>
                    <h2>{route.name}</h2>
                    <p>
                      {route.code} · {route.state === 'ACTIVE' ? 'Activa' : 'Inactiva'} ·{' '}
                      {route.content === 'DRAFT' ? 'Borrador' : 'Publicada'} · revisión{' '}
                      {route.published_revision || 'ninguna'}
                    </p>
                  </div>
                </div>
                <div className="catalog-fields">
                  <label>
                    Código
                    <input
                      value={form.code}
                      onChange={(event) =>
                        setForm({ ...form, code: event.target.value.toUpperCase() })
                      }
                      disabled={!canWrite || busy || route.state !== 'ACTIVE'}
                    />
                  </label>
                  <label>
                    Nombre
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      disabled={!canWrite || busy || route.state !== 'ACTIVE'}
                    />
                  </label>
                  <label className="wide">
                    Descripción
                    <input
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      disabled={!canWrite || busy || route.state !== 'ACTIVE'}
                    />
                  </label>
                </div>
                {canWrite && (
                  <div className="catalog-actions">
                    {route.state === 'ACTIVE' && (
                      <>
                        <button type="button" onClick={() => void save()} disabled={busy}>
                          Guardar borrador
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void publish()}
                          disabled={busy || !route.has_draft}
                        >
                          Publicar versión
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void setState(route.state === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')
                      }
                      disabled={busy}
                    >
                      {route.state === 'ACTIVE' ? 'Desactivar' : 'Activar'}
                    </button>
                  </div>
                )}
              </section>
              <section className="catalog-section">
                <h2>Paradas y geozonas</h2>
                <p>
                  Las sedes del mismo cliente son visitas distintas. Las obligatorias determinan el
                  cumplimiento futuro.
                </p>
                <RouteMap stops={historyView?.stops ?? stops} />
                {stops.length === 0 && (
                  <p className="catalog-empty">
                    Aún no hay paradas. Selecciona una sede activa con geozona.
                  </p>
                )}
                <ol className="route-stop-list">
                  {stops.map((stop, index) => (
                    <li key={stop.stop_id}>
                      <div className="route-stop-head">
                        <strong>
                          {stop.client_name} · {stop.site_name}
                        </strong>
                        <span>
                          Geozona v{stop.geofence_revision} · radio {stop.radius_m} m
                        </span>
                      </div>
                      <div className="route-stop-controls">
                        <label>
                          Permanencia mínima (min)
                          <input
                            type="number"
                            min="1"
                            max={Math.floor(limits.max_dwell_s / 60)}
                            step="1"
                            placeholder={`Heredada: ${stop.min_dwell_effective_s / 60}`}
                            value={stop.min_dwell_s === null ? '' : stop.min_dwell_s / 60}
                            onChange={(event) =>
                              updateStop(stop.stop_id, {
                                min_dwell_s:
                                  event.target.value === ''
                                    ? null
                                    : Number(event.target.value) * 60,
                              })
                            }
                            disabled={!canWrite || busy || route.state !== 'ACTIVE'}
                          />
                        </label>
                        <label className="route-required">
                          <input
                            type="checkbox"
                            checked={stop.required}
                            onChange={(event) =>
                              updateStop(stop.stop_id, { required: event.target.checked })
                            }
                            disabled={!canWrite || busy || route.state !== 'ACTIVE'}
                          />{' '}
                          Obligatoria
                        </label>
                        {canWrite && route.state === 'ACTIVE' && (
                          <div className="route-order-controls">
                            <button
                              type="button"
                              className="secondary"
                              aria-label={`Subir ${stop.site_name}`}
                              onClick={() => move(stop.stop_id, -1)}
                              disabled={busy || index === 0}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              aria-label={`Bajar ${stop.site_name}`}
                              onClick={() => move(stop.stop_id, 1)}
                              disabled={busy || index === stops.length - 1}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() =>
                                setStops((current) =>
                                  current.filter((item) => item.stop_id !== stop.stop_id),
                                )
                              }
                              disabled={busy}
                            >
                              Quitar
                            </button>
                          </div>
                        )}
                      </div>
                      <small>
                        Orden visual {index + 1} ·{' '}
                        {stop.min_dwell_s === null
                          ? 'hereda permanencia de geozona'
                          : 'permanencia específica'}
                      </small>
                    </li>
                  ))}
                </ol>
              </section>
              {canWrite && route.state === 'ACTIVE' && (
                <section className="catalog-section">
                  <h2>Agregar sede</h2>
                  <form
                    className="catalog-search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setClientQuery(clientSearch.trim());
                    }}
                  >
                    <label>
                      Buscar clientes activos
                      <input
                        value={clientSearch}
                        onChange={(event) => setClientSearch(event.target.value)}
                        placeholder="Código o nombre"
                      />
                    </label>
                    <button type="submit">Buscar</button>
                  </form>
                  <div className="route-client-picker">
                    {clients.map((client) => (
                      <button
                        type="button"
                        className="secondary"
                        key={client.id}
                        onClick={() => setSelectedClient(client)}
                        aria-pressed={selectedClient?.id === client.id}
                      >
                        {client.code} · {client.name}
                      </button>
                    ))}
                  </div>
                  {clientCursor && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void loadClients(clientCursor)}
                    >
                      Más clientes
                    </button>
                  )}
                  {selectedClient && (
                    <div>
                      <h3>Sedes de {selectedClient.name}</h3>
                      <div className="route-site-picker">
                        {sites.map((site) => (
                          <button
                            type="button"
                            className="secondary"
                            key={site.id}
                            onClick={() => void addSite(site)}
                            disabled={stops.some((stop) => stop.site_id === site.id)}
                          >
                            {site.code} · {site.name}
                          </button>
                        ))}
                      </div>
                      {sites.length === 0 && <p>Este cliente no tiene sedes activas.</p>}
                    </div>
                  )}
                </section>
              )}
              <section className="catalog-section">
                <h2>Versiones publicadas</h2>
                {history.length === 0 && <p>Aún no hay versiones publicadas.</p>}
                <ol className="catalog-history">
                  {history.map((item) => (
                    <li key={item.revision}>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void api
                            .routeRevision(route.id, item.revision)
                            .then(setHistoryView)
                            .catch((failure) => setError(errorText(failure)))
                        }
                      >
                        Versión {item.revision} · {item.name}
                      </button>
                    </li>
                  ))}
                </ol>
                {historyView && (
                  <div className="route-history-view">
                    <h3>Snapshot v{historyView.revision}</h3>
                    <p>
                      {historyView.code} · {historyView.name} · {historyView.stops.length} paradas
                    </p>
                    <ul>
                      {historyView.stops.map((stop) => (
                        <li key={stop.stop_id}>
                          {stop.client_name} · {stop.site_name} · geozona v{stop.geofence_revision}{' '}
                          · {stop.min_dwell_effective_s / 60} min
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setHistoryView(null)}
                    >
                      Volver al mapa actual
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
