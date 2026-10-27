import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiClientError,
  type CatalogClient,
  type CatalogGeofence,
  type CatalogSite,
} from './api/client.js';
import { useAuth } from './auth.js';
import { CatalogMap } from './CatalogMap.js';
import { LocationSearch } from './LocationSearch.js';

type LocationFields = { latitude: string; longitude: string };
const emptyLocation: LocationFields = { latitude: '', longitude: '' };
const coordinates = (value: LocationFields) => ({
  latitude: Number(value.latitude),
  longitude: Number(value.longitude),
});
const validLocation = (value: LocationFields) =>
  value.latitude.trim() !== '' &&
  value.longitude.trim() !== '' &&
  Number.isFinite(Number(value.latitude)) &&
  Number.isFinite(Number(value.longitude)) &&
  Number(value.latitude) >= -90 &&
  Number(value.latitude) <= 90 &&
  Number(value.longitude) >= -180 &&
  Number(value.longitude) <= 180;
const inputError = (error: unknown) => {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'Tu cuenta no tiene acceso a este catálogo o empresa.';
    if (error.code === 'inactive_parent')
      return 'Activa el cliente y la sede antes de cambiar la geozona.';
    if (error.status === 409) return 'El código ya existe o la solicitud cambió. Revisa los datos.';
    if (error.status === 412) return 'El registro cambió. Recarga la página antes de guardar.';
    if (error.status === 422) return 'Revisa los campos y los límites de la geozona.';
    if (error.status === 428) return 'Falta una versión. Recarga la página antes de guardar.';
  }
  return 'No se pudo completar la operación. Revisa la conexión y vuelve a intentarlo.';
};

export function ClientCatalog() {
  const { id: clientId } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [canRead, setCanRead] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const [canWrite, setCanWrite] = useState(false);
  const [limits, setLimits] = useState({ max_radius_m: 100000, max_dwell_s: 86400 });
  const [permissionLoading, setPermissionLoading] = useState(true);
  const [clients, setClients] = useState<CatalogClient[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [client, setClient] = useState<CatalogClient | null>(null);
  const [sites, setSites] = useState<CatalogSite[]>([]);
  const [selectedSite, setSelectedSite] = useState('');
  const [geofences, setGeofences] = useState<CatalogGeofence[]>([]);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [newClient, setNewClient] = useState(false);
  const [newSite, setNewSite] = useState(false);
  const [clientForm, setClientForm] = useState({ code: '', name: '', address: '' });
  const [siteForm, setSiteForm] = useState({
    code: 'MAIN',
    name: 'Sede principal',
    address: '',
    ...emptyLocation,
  });
  const [zoneForm, setZoneForm] = useState({
    latitude: '',
    longitude: '',
    radius_m: '100',
    min_dwell_minutes: '10',
    reason: '',
    state: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
  });
  const site = sites.find((item) => item.id === selectedSite) ?? null;
  const visibleGeofences = geofences.filter(
    (item) => item.client_id === clientId && item.site_id === selectedSite,
  );
  const latest = visibleGeofences[0] ?? null;

  useEffect(() => {
    let live = true;
    if (!profile) return;
    void api
      .catalogCapabilities()
      .then((value) => {
        if (!live) return;
        setCanRead(value.capabilities.includes('visit.catalog.read'));
        setCanWrite(value.capabilities.includes('visit.catalog.write'));
        setLimits(value.limits);
      })
      .catch(() => {
        if (live) {
          setCanRead(false);
          setCanWrite(false);
        }
      })
      .finally(() => {
        if (live) setPermissionLoading(false);
      });
    return () => {
      live = false;
    };
  }, [profile]);

  const loadClients = useCallback(
    async (next?: string) => {
      const request = ++listRequest.current;
      setListLoading(true);
      setError('');
      try {
        const result = await api.clients({
          ...(filter ? { q: filter } : {}),
          ...(statusFilter ? { state: statusFilter } : {}),
          ...(next ? { cursor: next } : {}),
        });
        if (request === listRequest.current) {
          setClients((current) => (next ? [...current, ...result.items] : result.items));
          setCursor(result.next_cursor);
        }
      } catch (failure) {
        if (request === listRequest.current) setError(inputError(failure));
      } finally {
        if (request === listRequest.current) setListLoading(false);
      }
    },
    [filter, statusFilter],
  );
  useEffect(() => {
    if (canRead) void loadClients();
  }, [canRead, loadClients]);

  const loadDetail = useCallback(async () => {
    if (!clientId) return;
    const request = ++detailRequest.current;
    try {
      const [record, sitePage] = await Promise.all([api.client(clientId), api.sites(clientId)]);
      if (request !== detailRequest.current) return;
      setClient(record);
      setSites(sitePage.items);
      setClientForm({ code: record.code, name: record.name, address: record.address });
      setSelectedSite((current) =>
        sitePage.items.some((item) => item.id === current)
          ? current
          : (sitePage.items[0]?.id ?? ''),
      );
    } catch (failure) {
      if (request === detailRequest.current) setError(inputError(failure));
    }
  }, [clientId]);
  useEffect(() => {
    setClient(null);
    setSites([]);
    setSelectedSite('');
    setGeofences([]);
    if (canRead && clientId) void loadDetail();
    return () => {
      detailRequest.current++;
    };
  }, [canRead, clientId, loadDetail]);
  useEffect(() => {
    let live = true;
    if (!clientId || !selectedSite || site?.client_id !== clientId) {
      setGeofences([]);
      setZoneLoading(false);
      return;
    }
    setZoneLoading(true);
    void api
      .geofences(clientId, selectedSite)
      .then((value) => {
        if (live) setGeofences(value.items);
      })
      .catch((failure) => {
        if (live) setError(inputError(failure));
      })
      .finally(() => {
        if (live) setZoneLoading(false);
      });
    return () => {
      live = false;
    };
  }, [clientId, selectedSite, site?.client_id]);
  useEffect(() => {
    if (!site) return;
    setSiteForm({
      code: site.code,
      name: site.name,
      address: site.address,
      latitude: String(site.latitude),
      longitude: String(site.longitude),
    });
    setNewSite(false);
  }, [site]);
  useEffect(() => {
    if (!site) return;
    setZoneForm({
      latitude: String(latest?.latitude ?? site.latitude),
      longitude: String(latest?.longitude ?? site.longitude),
      radius_m: String(latest?.radius_m ?? 100),
      min_dwell_minutes: String((latest?.min_dwell_s ?? 600) / 60),
      reason: '',
      state: latest?.state ?? 'ACTIVE',
    });
  }, [site, latest]);

  async function execute(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
    } catch (failure) {
      setError(inputError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !validLocation(siteForm)) {
      setError('Ingresa coordenadas válidas.');
      return;
    }
    await execute(async () => {
      const created = await api.createClient(
        { ...clientForm, site: { ...siteForm, ...coordinates(siteForm) } },
        profile.csrf_token,
      );
      setNewClient(false);
      await loadClients();
      navigate(`/clients/${created.id}`);
    }, 'Cliente y sede creados.');
  }
  async function saveClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !client) return;
    await execute(async () => {
      setClient(await api.patchClient(client.id, client.version, clientForm, profile.csrf_token));
      await loadClients();
    }, 'Cliente actualizado.');
  }
  async function toggleClient() {
    if (!profile || !client) return;
    const target = client.state === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await execute(
      async () => {
        setClient(
          await api.patchClient(client.id, client.version, { state: target }, profile.csrf_token),
        );
        await loadClients();
      },
      `Cliente ${target === 'ACTIVE' ? 'activado' : 'desactivado'}.`,
    );
  }
  async function saveSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !clientId || !validLocation(siteForm)) {
      setError('Ingresa coordenadas válidas.');
      return;
    }
    await execute(async () => {
      const fields = { ...siteForm, ...coordinates(siteForm) };
      if (newSite) {
        const created = await api.createSite(clientId, fields, profile.csrf_token);
        setSelectedSite(created.id);
      } else if (site)
        await api.patchSite(clientId, site.id, site.version, fields, profile.csrf_token);
      const records = await api.sites(clientId);
      setSites(records.items);
      setNewSite(false);
    }, 'Sede guardada.');
  }
  async function toggleSite() {
    if (!profile || !clientId || !site) return;
    await execute(async () => {
      await api.patchSite(
        clientId,
        site.id,
        site.version,
        { state: site.state === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
        profile.csrf_token,
      );
      setSites((await api.sites(clientId)).items);
    }, 'Estado de sede actualizado.');
  }
  async function saveZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !clientId || !site) return;
    const center = { latitude: zoneForm.latitude, longitude: zoneForm.longitude };
    const minutes = Number(zoneForm.min_dwell_minutes),
      radius = Number(zoneForm.radius_m);
    if (
      !validLocation(center) ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      radius > limits.max_radius_m ||
      !Number.isInteger(minutes) ||
      minutes <= 0 ||
      minutes * 60 > limits.max_dwell_s ||
      zoneForm.reason.trim().length < 8
    ) {
      setError(
        'Revisa las coordenadas, el radio, la permanencia y el motivo (mínimo 8 caracteres).',
      );
      return;
    }
    await execute(async () => {
      await api.saveGeofence(
        clientId,
        site.id,
        latest?.revision ?? 0,
        {
          ...coordinates(center),
          radius_m: radius,
          min_dwell_s: minutes * 60,
          state: zoneForm.state,
          reason: zoneForm.reason.trim(),
        },
        profile.csrf_token,
      );
      setGeofences((await api.geofences(clientId, site.id)).items);
    }, 'Geozona guardada como nueva revisión.');
  }
  const mapLatitude = zoneForm.latitude.trim() === '' ? null : Number(zoneForm.latitude);
  const mapLongitude = zoneForm.longitude.trim() === '' ? null : Number(zoneForm.longitude);
  const mapRadius = Number(zoneForm.radius_m);
  const selectSiteLocation = (latitude: number, longitude: number) => {
    setSiteForm((current) => ({
      ...current,
      latitude: String(latitude),
      longitude: String(longitude),
    }));
    setZoneForm((current) => ({
      ...current,
      latitude: String(latitude),
      longitude: String(longitude),
    }));
  };

  if (permissionLoading)
    return (
      <section className="catalog-page">
        <p role="status">Verificando acceso al catálogo…</p>
      </section>
    );
  if (!canRead)
    return (
      <section className="catalog-page">
        <h1>Clientes y geozonas</h1>
        <p role="alert">
          Tu cuenta no tiene permiso de lectura para este catálogo. Solicita acceso a un
          administrador.
        </p>
      </section>
    );
  return (
    <section className="catalog-page">
      <div className="catalog-title">
        <div>
          <h1>Clientes y geozonas</h1>
          <p>Administra sedes y círculos de visita con historial de cambios.</p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => {
              setNewClient(true);
              navigate('/clients');
              setClientForm({ code: '', name: '', address: '' });
              setSiteForm({ code: 'MAIN', name: 'Sede principal', address: '', ...emptyLocation });
              setNotice('');
            }}
          >
            Nuevo cliente
          </button>
        )}
      </div>
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
      <div className="catalog-layout">
        <aside className="catalog-list" aria-label="Lista de clientes">
          <form
            className="catalog-search"
            onSubmit={(event) => {
              event.preventDefault();
              setFilter(q);
            }}
          >
            <label htmlFor="catalog-query">Buscar cliente</label>
            <div>
              <input
                id="catalog-query"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Código o nombre"
              />
              <button type="submit">Buscar</button>
            </div>
            <label htmlFor="catalog-filter">Estado</label>
            <select
              id="catalog-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Todos</option>
              <option value="ACTIVE">Activos</option>
              <option value="INACTIVE">Inactivos</option>
            </select>
          </form>
          {listLoading && <p role="status">Cargando clientes…</p>}
          {!listLoading && clients.length === 0 && (
            <p className="catalog-empty">No hay clientes con esos filtros.</p>
          )}
          <ul>
            {clients.map((item) => (
              <li key={item.id}>
                <Link
                  to={`/clients/${item.id}`}
                  aria-current={clientId === item.id ? 'page' : undefined}
                  onClick={() => setNewClient(false)}
                >
                  <strong>{item.name}</strong>
                  <small>
                    {item.code} · {item.state === 'ACTIVE' ? 'Activo' : 'Inactivo'}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
          {cursor && (
            <button type="button" disabled={listLoading} onClick={() => void loadClients(cursor)}>
              Cargar más
            </button>
          )}
        </aside>
        <div className="catalog-detail">
          {newClient && canWrite && (
            <section className="catalog-section">
              <h2>Nuevo cliente</h2>
              <form onSubmit={(event) => void createClient(event)}>
                <div className="catalog-fields">
                  <label>
                    Código
                    <input
                      required
                      maxLength={40}
                      value={clientForm.code}
                      onChange={(event) =>
                        setClientForm({ ...clientForm, code: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Nombre
                    <input
                      required
                      maxLength={160}
                      value={clientForm.name}
                      onChange={(event) =>
                        setClientForm({ ...clientForm, name: event.target.value })
                      }
                    />
                  </label>
                  <label className="wide">
                    Dirección
                    <input
                      required
                      maxLength={300}
                      value={clientForm.address}
                      onChange={(event) =>
                        setClientForm({ ...clientForm, address: event.target.value })
                      }
                    />
                  </label>
                </div>
                <h3>Sede principal</h3>
                <LocationSearch
                  onSelect={selectSiteLocation}
                  onUseAddress={(address) => {
                    setSiteForm((current) => ({ ...current, address }));
                    setClientForm((current) => ({
                      ...current,
                      address: current.address.trim() ? current.address : address,
                    }));
                  }}
                  addressButtonLabel="Usar esta dirección en cliente y sede"
                />
                <div className="catalog-fields">
                  <label>
                    Código de sede
                    <input
                      required
                      value={siteForm.code}
                      onChange={(event) => setSiteForm({ ...siteForm, code: event.target.value })}
                    />
                  </label>
                  <label>
                    Nombre de sede
                    <input
                      required
                      value={siteForm.name}
                      onChange={(event) => setSiteForm({ ...siteForm, name: event.target.value })}
                    />
                  </label>
                  <label className="wide">
                    Dirección de sede
                    <input
                      required
                      value={siteForm.address}
                      onChange={(event) =>
                        setSiteForm({ ...siteForm, address: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Latitud
                    <input
                      required
                      type="number"
                      step="any"
                      min={-90}
                      max={90}
                      value={siteForm.latitude}
                      onChange={(event) =>
                        setSiteForm({ ...siteForm, latitude: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Longitud
                    <input
                      required
                      type="number"
                      step="any"
                      min={-180}
                      max={180}
                      value={siteForm.longitude}
                      onChange={(event) =>
                        setSiteForm({ ...siteForm, longitude: event.target.value })
                      }
                    />
                  </label>
                </div>
                <p>Selecciona el punto en el mapa o escribe sus coordenadas.</p>
                <CatalogMap
                  latitude={siteForm.latitude ? Number(siteForm.latitude) : null}
                  longitude={siteForm.longitude ? Number(siteForm.longitude) : null}
                  radius={Number(zoneForm.radius_m)}
                  onSelect={selectSiteLocation}
                />
                <div className="catalog-actions">
                  <button disabled={busy} type="submit">
                    Crear cliente y sede
                  </button>
                  <button type="button" className="secondary" onClick={() => setNewClient(false)}>
                    Cancelar
                  </button>
                </div>
              </form>
            </section>
          )}
          {!newClient && !client && (
            <div className="catalog-placeholder">
              <h2>Selecciona un cliente</h2>
              <p>Elige un registro para consultar sus sedes y geozonas.</p>
            </div>
          )}
          {!newClient && client && (
            <>
              <section className="catalog-section">
                <div className="catalog-section-head">
                  <div>
                    <h2>{client.name}</h2>
                    <p>
                      {client.code} · {client.state === 'ACTIVE' ? 'Activo' : 'Inactivo'}
                    </p>
                  </div>
                  {canWrite && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void toggleClient()}
                    >
                      {client.state === 'ACTIVE' ? 'Desactivar' : 'Activar'}
                    </button>
                  )}
                </div>
                <form onSubmit={(event) => void saveClient(event)}>
                  <div className="catalog-fields">
                    <label>
                      Código
                      <input
                        required
                        disabled={!canWrite}
                        value={clientForm.code}
                        onChange={(event) =>
                          setClientForm({ ...clientForm, code: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Nombre
                      <input
                        required
                        disabled={!canWrite}
                        value={clientForm.name}
                        onChange={(event) =>
                          setClientForm({ ...clientForm, name: event.target.value })
                        }
                      />
                    </label>
                    <label className="wide">
                      Dirección
                      <input
                        required
                        disabled={!canWrite}
                        value={clientForm.address}
                        onChange={(event) =>
                          setClientForm({ ...clientForm, address: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  {canWrite && (
                    <button disabled={busy} type="submit">
                      Guardar cliente
                    </button>
                  )}
                </form>
              </section>
              <section className="catalog-section">
                <div className="catalog-section-head">
                  <h2>Sedes</h2>
                  {canWrite && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setNewSite(true);
                        setSiteForm({ code: '', name: '', address: '', ...emptyLocation });
                      }}
                    >
                      Añadir sede
                    </button>
                  )}
                </div>
                {sites.length === 0 && !newSite && (
                  <p className="catalog-empty">Este cliente no tiene sedes.</p>
                )}
                {sites.length > 0 && (
                  <div className="catalog-tabs" role="tablist" aria-label="Sedes">
                    {sites.map((item) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selectedSite === item.id && !newSite}
                        key={item.id}
                        onClick={() => {
                          setSelectedSite(item.id);
                          setNewSite(false);
                        }}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                )}
                {(site || newSite) && (
                  <form onSubmit={(event) => void saveSite(event)}>
                    {canWrite && (
                      <LocationSearch
                        onSelect={selectSiteLocation}
                        onUseAddress={(address) =>
                          setSiteForm((current) => ({ ...current, address }))
                        }
                      />
                    )}
                    <div className="catalog-fields">
                      <label>
                        Código
                        <input
                          required
                          disabled={!canWrite}
                          value={siteForm.code}
                          onChange={(event) =>
                            setSiteForm({ ...siteForm, code: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Nombre
                        <input
                          required
                          disabled={!canWrite}
                          value={siteForm.name}
                          onChange={(event) =>
                            setSiteForm({ ...siteForm, name: event.target.value })
                          }
                        />
                      </label>
                      <label className="wide">
                        Dirección
                        <input
                          required
                          disabled={!canWrite}
                          value={siteForm.address}
                          onChange={(event) =>
                            setSiteForm({ ...siteForm, address: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Latitud
                        <input
                          required
                          type="number"
                          step="any"
                          min={-90}
                          max={90}
                          disabled={!canWrite}
                          value={siteForm.latitude}
                          onChange={(event) =>
                            setSiteForm({ ...siteForm, latitude: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Longitud
                        <input
                          required
                          type="number"
                          step="any"
                          min={-180}
                          max={180}
                          disabled={!canWrite}
                          value={siteForm.longitude}
                          onChange={(event) =>
                            setSiteForm({ ...siteForm, longitude: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <p>
                      Selecciona o arrastra el marcador para ajustar la sede. Guarda la geozona por
                      separado.
                    </p>
                    <CatalogMap
                      latitude={siteForm.latitude ? Number(siteForm.latitude) : null}
                      longitude={siteForm.longitude ? Number(siteForm.longitude) : null}
                      radius={Number(zoneForm.radius_m)}
                      onSelect={canWrite ? selectSiteLocation : undefined}
                    />
                    {canWrite && (
                      <div className="catalog-actions">
                        <button disabled={busy} type="submit">
                          {newSite ? 'Crear sede' : 'Guardar sede'}
                        </button>
                        {site && !newSite && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void toggleSite()}
                          >
                            {site.state === 'ACTIVE' ? 'Desactivar sede' : 'Activar sede'}
                          </button>
                        )}
                      </div>
                    )}
                  </form>
                )}
              </section>
              {site && !newSite && (
                <section className="catalog-section">
                  <div className="catalog-section-head">
                    <div>
                      <h2>Geozona circular</h2>
                      <p>
                        {zoneLoading
                          ? 'Cargando configuración…'
                          : latest
                            ? `Revisión ${latest.revision} · ${latest.state === 'ACTIVE' ? 'Activa' : 'Inactiva'}`
                            : 'Sin geozona configurada'}
                      </p>
                    </div>
                  </div>
                  <form onSubmit={(event) => void saveZone(event)}>
                    <div className="catalog-fields">
                      <label>
                        Latitud del centro
                        <input
                          type="number"
                          step="any"
                          min={-90}
                          max={90}
                          required
                          disabled={!canWrite}
                          value={zoneForm.latitude}
                          onChange={(event) =>
                            setZoneForm({ ...zoneForm, latitude: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Longitud del centro
                        <input
                          type="number"
                          step="any"
                          min={-180}
                          max={180}
                          required
                          disabled={!canWrite}
                          value={zoneForm.longitude}
                          onChange={(event) =>
                            setZoneForm({ ...zoneForm, longitude: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Radio en metros
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max={limits.max_radius_m}
                          required
                          disabled={!canWrite}
                          value={zoneForm.radius_m}
                          onChange={(event) =>
                            setZoneForm({ ...zoneForm, radius_m: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Permanencia mínima en minutos
                        <input
                          type="number"
                          step="1"
                          min={1}
                          max={Math.floor(limits.max_dwell_s / 60)}
                          required
                          disabled={!canWrite}
                          value={zoneForm.min_dwell_minutes}
                          onChange={(event) =>
                            setZoneForm({ ...zoneForm, min_dwell_minutes: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Estado
                        <select
                          disabled={!canWrite}
                          value={zoneForm.state}
                          onChange={(event) =>
                            setZoneForm({
                              ...zoneForm,
                              state: event.target.value as 'ACTIVE' | 'INACTIVE',
                            })
                          }
                        >
                          <option value="ACTIVE">Activa</option>
                          <option value="INACTIVE">Inactiva</option>
                        </select>
                      </label>
                      {canWrite && (
                        <label className="wide">
                          Motivo del cambio
                          <input
                            required
                            minLength={8}
                            maxLength={240}
                            value={zoneForm.reason}
                            onChange={(event) =>
                              setZoneForm({ ...zoneForm, reason: event.target.value })
                            }
                          />
                        </label>
                      )}
                    </div>
                    <p>
                      Haz clic en el mapa para elegir el centro. El círculo se dibuja con el radio
                      en metros.
                    </p>
                    <CatalogMap
                      latitude={mapLatitude}
                      longitude={mapLongitude}
                      radius={mapRadius}
                      onSelect={(latitude, longitude) => {
                        if (canWrite)
                          setZoneForm((current) => ({
                            ...current,
                            latitude: String(latitude),
                            longitude: String(longitude),
                          }));
                      }}
                    />
                    {canWrite && (
                      <button disabled={busy || zoneLoading} type="submit">
                        Guardar nueva revisión
                      </button>
                    )}
                  </form>
                  {visibleGeofences.length > 0 && (
                    <details className="catalog-history">
                      <summary>Historial de geozona ({visibleGeofences.length})</summary>
                      <ol>
                        {visibleGeofences.map((zone) => (
                          <li key={zone.revision}>
                            Revisión {zone.revision} ·{' '}
                            {zone.state === 'ACTIVE' ? 'Activa' : 'Inactiva'} · {zone.radius_m} m ·{' '}
                            {zone.min_dwell_s / 60} min ·{' '}
                            {new Date(zone.created_at).toLocaleString('es-GT')} · {zone.reason}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
