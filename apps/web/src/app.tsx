import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  api,
  ApiClientError,
  type BasicDevice,
  type Device,
  type MdmDevice,
} from './api/client.js';
import { webBase } from './api/base.js';
import { AuthProvider, useAuth } from './auth.js';
import { GpsWorkspace, type GpsSection } from './gps/GpsWorkspace.js';
import { EnrollmentPanel } from './EnrollmentPanel.js';
import { DeviceManagement } from './DeviceManagement.js';
import { ActivateAdmin, AdminUsers } from './AdminUsers.js';
import { MdmOnly, mdmEnabled } from './MdmAvailability.js';
import { mdmInventoryAvailability } from './MdmInventoryAvailability.js';
import { ClientCatalog } from './ClientCatalog.js';
import { RouteCatalog } from './RouteCatalog.js';
import { VisitSchedule } from './VisitSchedule.js';
import './styles.css';

function ErrorText({ error }: { error: unknown }) {
  const status = error instanceof ApiClientError ? error.status : 0;
  const message =
    status === 401
      ? 'La sesión expiró. Vuelve a entrar.'
      : status === 403
        ? 'No tienes permiso para consultar este recurso.'
        : status === 429
          ? 'Demasiadas solicitudes. Inténtalo más tarde.'
          : 'No pudimos cargar los datos. Inténtalo de nuevo.';
  return (
    <div role="alert" className="notice error">
      {message}
    </div>
  );
}

function mdmErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError))
    return 'No se pudo comunicar con GEOPS. Inténtalo de nuevo.';
  if (error.code === 'mdm_rate_limited')
    return 'ManageEngine limitó las solicitudes. Inténtalo más tarde.';
  if (error.code === 'mdm_unauthorized' || error.code === 'mdm_oauth_failed')
    return 'ManageEngine rechazó la autorización. Reconecta la cuenta.';
  if (error.code === 'mdm_connection_error' || error.code === 'mdm_upstream_error')
    return 'ManageEngine no responde. Inténtalo más tarde.';
  if (error.status === 401) return 'La sesión GEOPS expiró. Vuelve a entrar.';
  if (error.status === 403) return 'No tienes permiso para administrar MDM.';
  if (error.code === 'mdm_disconnected') return 'ManageEngine está desconectado.';
  if (error.code === 'mdm_oauth_unconfigured') return 'Configuración OAuth pendiente.';
  if (error.code === 'mdm_disconnect_required')
    return 'Desconecta ManageEngine antes de reemplazar el cliente OAuth.';
  if (error.code === 'mdm_oauth_config_rate_limited')
    return 'Espera unos segundos antes de guardar otra configuración.';
  return 'No se pudo completar la operación MDM. Consulta el estado y vuelve a intentarlo.';
}

function Login() {
  const { profile, login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (profile) return <Navigate to="/inventory" replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await login(String(data.get('email')), String(data.get('password')));
      navigate('/inventory', { replace: true });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="content" className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">GEOPS · entorno sintético</p>
        <h1 id="login-title">Consola administrativa</h1>
        <p>Accede para consultar el estado y el inventario de prueba.</p>
        <form onSubmit={submit}>
          <label>
            Correo electrónico
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Contraseña
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error !== null && <ErrorText error={error} />}
          <button type="submit" disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useAuth();
  if (loading)
    return (
      <main id="content" role="status" className="center-state">
        Comprobando sesión…
      </main>
    );
  if (!profile) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [exitError, setExitError] = useState(false);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    document.title = `GEOPS · ${location.pathname.startsWith('/gps/') ? 'Administración GPS' : 'Consola administrativa'}`;
    main.current?.focus();
  }, [location.pathname]);
  useEffect(() => {
    let active = true;
    if (profile)
      void api
        .gpsCapabilities()
        .then((value) => {
          if (active) setCanManageUsers(value.capabilities.includes('gps.user.manage'));
        })
        .catch(() => {
          if (active) setCanManageUsers(false);
        });
    return () => {
      active = false;
    };
  }, [profile]);
  async function exit() {
    setExitError(false);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      setExitError(true);
    }
  }
  return (
    <>
      <a className="skip-link" href="#content">
        Saltar al contenido
      </a>
      <div className="app-shell">
        <header className="topbar">
          <Link className="brand" to="/inventory" aria-label="GEOPS, ir a inventario">
            GEOPS
          </Link>
          <span className="environment">Datos GEOPS sintéticos</span>
          <button className="text-button" type="button" onClick={() => void exit()}>
            Cerrar sesión
          </button>
        </header>
        <div className="workspace">
          <nav className="sidebar" aria-label="Principal">
            <Link
              aria-current={location.pathname === '/inventory' ? 'page' : undefined}
              to="/inventory"
            >
              Inventario
            </Link>
            <MdmOnly>
              <Link
                aria-current={location.pathname === '/status' ? 'page' : undefined}
                to="/status"
              >
                Integración MDM
              </Link>
            </MdmOnly>
            <Link
              aria-current={location.pathname.startsWith('/clients') ? 'page' : undefined}
              to="/clients"
            >
              Clientes y geozonas
            </Link>
            <Link
              aria-current={location.pathname.startsWith('/routes') ? 'page' : undefined}
              to="/routes"
            >
              Rutas reutilizables
            </Link>
            <Link
              aria-current={location.pathname === '/schedule' ? 'page' : undefined}
              to="/schedule"
            >
              Agentes y calendario
            </Link>
            {canManageUsers && (
              <Link
                aria-current={location.pathname === '/admin/users' ? 'page' : undefined}
                to="/admin/users"
              >
                Usuarios y permisos
              </Link>
            )}
            <span className="sidebar-heading">Administración GPS · W1-D</span>
            {(
              [
                ['/gps/policies', 'Políticas GPS'],
                ['/gps/devices', 'Dispositivos'],
                ['/gps/sessions', 'Sesiones'],
                ['/gps/executive', 'Resumen ejecutivo'],
              ] as const
            ).map(([path, label]) => (
              <Link
                key={path}
                aria-current={location.pathname === path ? 'page' : undefined}
                to={path}
              >
                {label}
              </Link>
            ))}
          </nav>
          <main id="content" tabIndex={-1} ref={main}>
            {!location.pathname.startsWith('/gps/') && (
              <div className="page-head">
                <span className="eyebrow">
                  {location.pathname === '/status'
                    ? 'Integración MDM · entorno de prueba'
                    : 'Wave 0A · simulación'}
                </span>
                <span className="user-label">{profile?.email}</span>
              </div>
            )}
            {exitError && (
              <div role="alert" className="notice error">
                No se pudo cerrar la sesión en el servidor. Comprueba la conexión y vuelve a
                intentarlo.
              </div>
            )}
            {children}
          </main>
        </div>
      </div>
    </>
  );
}

function useLoad<T>(load: () => Promise<T>, enabled = true) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: unknown }>({
    loading: enabled,
    data: null,
    error: null,
  });
  const refresh = () => {
    if (!enabled) return;
    setState((current) => ({ ...current, loading: true, error: null }));
    void load()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) =>
        setState((current) => ({
          loading: false,
          data:
            error instanceof ApiClientError && (error.status === 401 || error.status === 403)
              ? null
              : current.data,
          error,
        })),
      );
  };
  useEffect(refresh, [load, enabled]);
  return { ...state, refresh };
}

function Inventory() {
  const geops = useLoad(api.geopsDevices);
  const enrollment = useLoad(api.enrollmentDevices);
  const mdmStatus = useLoad(api.mdmStatus, mdmEnabled);
  const mdmAvailability = mdmInventoryAvailability(mdmStatus.data);
  const mdm = useLoad(api.mdmDevices, mdmEnabled && mdmAvailability.loadDevices);
  const gpsAccess = useLoad(api.gpsCapabilities);
  const [additionalDevices, setAdditionalDevices] = useState<Device[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const managementGeneration = useRef(0);
  const availableCursor = nextCursor === undefined ? enrollment.data?.next_cursor : nextCursor;
  const managedDevices = [...(enrollment.data?.items ?? []), ...additionalDevices];
  const refreshInventory = () => {
    managementGeneration.current++;
    setAdditionalDevices([]);
    setNextCursor(undefined);
    setLoadingMore(false);
    setMoreError(false);
    enrollment.refresh();
    geops.refresh();
  };
  const loadMore = async () => {
    if (!availableCursor || loadingMore) return;
    const generation = managementGeneration.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await api.enrollmentDevices(availableCursor);
      if (generation !== managementGeneration.current) return;
      setAdditionalDevices((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch {
      if (generation === managementGeneration.current) setMoreError(true);
    } finally {
      if (generation === managementGeneration.current) setLoadingMore(false);
    }
  };
  return (
    <Shell>
      <h1>Inventario</h1>
      <p className="lead">Registros GEOPS para la administración GPS.</p>
      {gpsAccess.data?.capabilities.includes('gps.installation.manage') && enrollment.data && (
        <DeviceManagement
          devices={managedDevices}
          capabilities={gpsAccess.data.capabilities}
          refresh={refreshInventory}
        />
      )}
      {gpsAccess.data?.capabilities.includes('gps.installation.manage') && availableCursor && (
        <div className="managed-page-load">
          <p>
            Los filtros muestran los registros cargados. Carga más para consultar el resto del
            inventario.
          </p>
          {moreError && (
            <p role="alert">No se pudieron cargar más dispositivos. Inténtalo de nuevo.</p>
          )}
          <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Cargando…' : 'Cargar más dispositivos'}
          </button>
        </div>
      )}
      <div className="grid">
        {!gpsAccess.data?.capabilities.includes('gps.installation.manage') && (
          <section className="panel" aria-labelledby="geops-title">
            <div className="panel-head">
              <h2 id="geops-title">Dispositivos GEOPS</h2>
              <span className="badge">GEOPS</span>
            </div>
            {geops.loading ? (
              <p role="status">Cargando dispositivos…</p>
            ) : geops.error ? (
              <>
                <ErrorText error={geops.error} />
                <button type="button" onClick={geops.refresh}>
                  Reintentar
                </button>
              </>
            ) : !geops.data?.items.length ? (
              <p className="empty">Todavía no hay dispositivos de prueba.</p>
            ) : (
              <ul className="device-list">
                {geops.data.items.map((item: BasicDevice) => (
                  <li key={item.id}>
                    <strong>{item.display_label}</strong>
                    <span>{item.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {gpsAccess.loading ||
        (gpsAccess.data?.capabilities.includes('gps.installation.manage') &&
          enrollment.loading &&
          !enrollment.data) ? (
          <section className="panel" role="status">
            Cargando inscripción…
          </section>
        ) : gpsAccess.error ||
          (gpsAccess.data?.capabilities.includes('gps.installation.manage') &&
            enrollment.error &&
            !enrollment.data) ? (
          <section className="panel">
            <ErrorText error={gpsAccess.error ?? enrollment.error} />
            <button type="button" onClick={gpsAccess.error ? gpsAccess.refresh : refreshInventory}>
              Reintentar
            </button>
          </section>
        ) : (
          <div>
            {enrollment.error !== null && (
              <div role="alert" className="notice error">
                <ErrorText error={enrollment.error} />
                <button type="button" onClick={refreshInventory}>
                  Reintentar inventario
                </button>
              </div>
            )}
            <EnrollmentPanel
              devices={managedDevices.filter(
                (item) => !['SUSPENDED', 'REVOKED', 'RETIRED'].includes(item.status),
              )}
              capabilities={gpsAccess.data?.capabilities ?? []}
              refresh={refreshInventory}
            />
          </div>
        )}
        <MdmOnly>
          <section className="panel" aria-labelledby="mdm-title">
            <div className="panel-head">
              <h2 id="mdm-title">Inventario MDM</h2>
              <span className="badge fake">Fuente: {mdm.data?.source ?? 'pendiente'}</span>
            </div>
            {mdmStatus.loading ? (
              <p role="status">Comprobando conexión MDM…</p>
            ) : mdmStatus.error ? (
              <>
                <ErrorText error={mdmStatus.error} />
                <button type="button" onClick={mdmStatus.refresh}>
                  Reintentar
                </button>
              </>
            ) : mdmAvailability.message ? (
              <p className="empty">{mdmAvailability.message}</p>
            ) : mdm.loading ? (
              <p role="status">Cargando inventario MDM…</p>
            ) : mdm.error instanceof ApiClientError &&
              mdm.error.code === 'mdm_oauth_unconfigured' ? (
              <p className="empty">
                Servicio ManageEngine sin configurar. El inventario MDM estará disponible después de
                la configuración inicial del servicio.
              </p>
            ) : mdm.error instanceof ApiClientError && mdm.error.code === 'mdm_disconnected' ? (
              <p className="empty">
                ManageEngine no conectado. Conecta la cuenta para consultar el inventario MDM.
              </p>
            ) : mdm.error ? (
              <>
                <ErrorText error={mdm.error} />
                <button type="button" onClick={mdm.refresh}>
                  Reintentar
                </button>
              </>
            ) : !mdm.data?.items.length ? (
              <p className="empty">
                {mdm.data?.source === 'manageengine'
                  ? 'La consulta no devolvió equipos en esta página. Comprueba cliente, inscripción y paginación.'
                  : 'El proveedor simulado no tiene equipos. Una lista vacía no valida ManageEngine.'}
              </p>
            ) : (
              <ul className="device-list">
                {mdm.data.items.map((item: MdmDevice) => (
                  <li key={item.mdm_device_id}>
                    <strong>{item.display_name ?? item.mdm_device_id}</strong>
                    <span>{item.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </MdmOnly>
      </div>
    </Shell>
  );
}

function Status() {
  const { profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useLoad(api.mdmStatus);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [customers, setCustomers] = useState<
    { customer_id: string; customer_name: string }[] | null
  >(null);
  const authorized = Boolean(state.data?.authorized);
  const callbackResult = new URLSearchParams(location.search).get('mdm_oauth');
  useEffect(() => {
    if (callbackResult !== 'select') return;
    let active = true;
    void api
      .mdmCustomers()
      .then((result) => {
        if (active) setCustomers(result.customers);
      })
      .catch((error) => {
        if (active) setActionError(mdmErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [callbackResult]);
  async function chooseCustomer(customerId: string) {
    if (!profile || busy) return;
    setBusy(true);
    setActionError('');
    try {
      await api.mdmChooseCustomer(customerId, profile.csrf_token);
      setCustomers(null);
      state.refresh();
      navigate('/status', { replace: true });
      setNotice('Cuenta ManageEngine conectada.');
    } catch (error) {
      setActionError(mdmErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    if (!profile || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const result = await api.mdmOAuthStart(profile.csrf_token);
      const url = new URL(result.authorization_url);
      if (
        !/^accounts\.zoho\.(com|eu|in|com\.au|jp|ca|cn|sa|uk)$/.test(url.hostname) ||
        url.protocol !== 'https:'
      )
        throw new Error('Invalid authorization origin');
      window.location.assign(url.href);
    } catch (error) {
      setActionError(mdmErrorMessage(error));
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!profile || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const result = await api.mdmDisconnect(profile.csrf_token);
      setNotice(
        result.remote_revoked
          ? 'ManageEngine desconectado.'
          : 'Acceso local bloqueado. La revocación remota sigue pendiente; reintenta la desconexión.',
      );
      setConfirmDisconnect(false);
      state.refresh();
    } catch (error) {
      setActionError(mdmErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell>
      <h1>Integración MDM</h1>
      <p className="lead">
        Conexión de inventario ManageEngine y sincronización de equipos Android de prueba.
      </p>
      <section className="panel status-panel" aria-labelledby="status-title">
        <h2 id="status-title">Estado de la conexión</h2>
        {state.data?.provider === 'manageengine' &&
          !authorized &&
          state.data.oauth_configured === false && (
            <p role="status">
              Servicio ManageEngine sin configurar. El responsable de la instalación debe
              provisionar la identidad OAuth de GEOPS una sola vez.
            </p>
          )}
        {callbackResult === 'failed' && (
          <p role="alert">No se completó la autorización de ManageEngine. Vuelve a intentarlo.</p>
        )}
        {callbackResult === 'connected' && authorized && (
          <p role="status">Cuenta ManageEngine conectada.</p>
        )}
        {callbackResult === 'select' && (
          <div className="mdm-customer-selection">
            <p>Selecciona la organización de ManageEngine que conectarás con GEOPS.</p>
            {customers === null && !actionError && (
              <p role="status">Consultando organizaciones autorizadas…</p>
            )}
            {customers?.map((customer) => (
              <button
                key={customer.customer_id}
                type="button"
                disabled={busy}
                onClick={() => void chooseCustomer(customer.customer_id)}
              >
                {customer.customer_name}
              </button>
            ))}
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {actionError && <p role="alert">{actionError}</p>}
        {state.loading ? (
          <p role="status">Cargando estado…</p>
        ) : state.error ? (
          <>
            <ErrorText error={state.error} />
            <button type="button" onClick={state.refresh}>
              Reintentar
            </button>
          </>
        ) : state.data ? (
          <dl>
            <div>
              <dt>Proveedor</dt>
              <dd>
                {state.data.provider === 'manageengine' ? 'ManageEngine MSP Cloud' : 'Simulado'}
              </dd>
            </div>
            <div>
              <dt>Conexión</dt>
              <dd>
                {authorized
                  ? 'Autorizada'
                  : state.data.oauth_configured === false
                    ? 'Servicio sin configurar'
                    : 'ManageEngine no conectado'}{' '}
                ·{' '}
                {state.data.connected ? 'Consulta real confirmada' : 'Sin consulta real confirmada'}
              </dd>
            </div>
            {state.data.authorization_state === 'disconnecting' && (
              <div>
                <dt>Revocación</dt>
                <dd>Pendiente de confirmar en ManageEngine</dd>
              </div>
            )}
            <div>
              <dt>Región</dt>
              <dd>{state.data.region ?? 'Por confirmar'}</dd>
            </div>
            <div>
              <dt>Cliente conectado</dt>
              <dd>
                {state.data.customer_name ??
                  (state.data.customer_id
                    ? `Cliente ${state.data.customer_id}`
                    : 'Sin seleccionar')}
              </dd>
            </div>
            <div>
              <dt>Edición</dt>
              <dd>
                {state.data.edition_evidence === 'UNVERIFIED'
                  ? 'Pendiente de verificar'
                  : state.data.edition_evidence}
              </dd>
            </div>
            <div>
              <dt>Dispositivos sincronizados</dt>
              <dd>{state.data.device_count ?? 0}</dd>
            </div>
            <div>
              <dt>Última sincronización</dt>
              <dd>
                {state.data.last_sync_at
                  ? new Date(state.data.last_sync_at).toLocaleString('es-GT')
                  : 'Sin sincronizar'}
              </dd>
            </div>
            <div>
              <dt>Última consulta</dt>
              <dd>
                {state.data.last_checked_at
                  ? new Date(state.data.last_checked_at).toLocaleString('es-GT')
                  : 'Sin consulta'}
              </dd>
            </div>
          </dl>
        ) : null}
        {state.data?.provider === 'manageengine' && !state.loading && !state.error && (
          <div className="mdm-actions">
            {state.data.authorization_state === 'disconnecting' ? (
              <button type="button" onClick={() => void disconnect()} disabled={busy || !profile}>
                {busy ? 'Reintentando…' : 'Reintentar desconexión'}
              </button>
            ) : !authorized && callbackResult !== 'select' && state.data.oauth_configured ? (
              <button type="button" onClick={() => void connect()} disabled={busy || !profile}>
                {busy ? 'Preparando autorización…' : 'Conectar ManageEngine'}
              </button>
            ) : !authorized ? null : confirmDisconnect ? (
              <>
                <p>Se bloqueará el acceso MDM y se solicitará revocar el grant remoto.</p>
                <button type="button" onClick={() => void disconnect()} disabled={busy}>
                  {busy ? 'Desconectando…' : 'Confirmar desconexión'}
                </button>
                <button type="button" onClick={() => setConfirmDisconnect(false)} disabled={busy}>
                  Cancelar
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmDisconnect(true)}>
                Desconectar ManageEngine
              </button>
            )}
          </div>
        )}
      </section>
      {state.data?.provider === 'manageengine' && authorized ? (
        <MdmAdminWorkspace refreshStatus={state.refresh} />
      ) : (
        <p className="empty">
          {state.data?.provider === 'manageengine'
            ? 'Conecta ManageEngine para consultar y sincronizar el inventario.'
            : 'La integración real está desactivada. El inventario MDM sigue simulado.'}
        </p>
      )}
    </Shell>
  );
}

function MdmAdminWorkspace({ refreshStatus }: { refreshStatus: () => void }) {
  const { profile } = useAuth();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);
  const loadInventory = useCallback(() => api.mdmInventory(cursor), [cursor]);
  const inventory = useLoad(loadInventory);
  const geops = useLoad(api.enrollmentDevices);
  const [mdmId, setMdmId] = useState('');
  const [geopsId, setGeopsId] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const chosen = inventory.data?.items.find((item) => item.mdm_device_id === mdmId);
  const eligible =
    inventory.data?.items.filter(
      (item) =>
        item.geops_device_id ||
        (item.platform === 'android' && item.status === 'managed' && !item.removed),
    ) ?? [];
  async function sync() {
    if (!profile || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.mdmSync(profile.csrf_token);
      setNotice(
        `Sincronización terminada: ${result.device_count} Android observados. Las ausencias no se consideran bajas.`,
      );
      if (cursor) {
        setHistory([]);
        setCursor(undefined);
      } else inventory.refresh();
      refreshStatus();
    } catch (error) {
      setError(mdmErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function changeLink() {
    if (!profile || !chosen || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (chosen.geops_device_id) {
        await api.mdmUnlink(chosen.geops_device_id, profile.csrf_token);
        setNotice('Asociación MDM retirada. La identidad GEOPS permanece.');
      } else {
        if (!verified || !geopsId) return;
        await api.mdmLink(geopsId, chosen.mdm_device_id, profile.csrf_token);
        setNotice('Asociación de inventario guardada. La identidad GEOPS no se activó.');
      }
      inventory.refresh();
      setVerified(false);
    } catch (error) {
      setError(mdmErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel mdm-admin" aria-labelledby="mdm-sync-title">
      <div className="panel-head">
        <h2 id="mdm-sync-title">Inventario sincronizado</h2>
        <button type="button" onClick={() => void sync()} disabled={busy || !profile}>
          {busy ? 'Procesando…' : 'Sincronizar ahora'}
        </button>
      </div>
      <p>
        La consulta lee el tenant MDM de prueba. No cambia políticas, ubicación ni credenciales
        Android.
      </p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {inventory.loading ? (
        <p role="status">Cargando inventario sincronizado…</p>
      ) : inventory.error ? (
        <div>
          <p role="alert">{mdmErrorMessage(inventory.error)}</p>
          <button type="button" onClick={inventory.refresh}>
            Reintentar inventario
          </button>
        </div>
      ) : inventory.data?.items.length ? (
        <div className="mdm-table-wrap">
          <table className="mdm-table">
            <thead>
              <tr>
                <th>Equipo MDM</th>
                <th>Modelo / SO</th>
                <th>Estado</th>
                <th>GEOPS</th>
                <th>Visto</th>
              </tr>
            </thead>
            <tbody>
              {inventory.data.items.map((item) => (
                <tr key={item.mdm_device_id}>
                  <td data-label="Equipo MDM">
                    <span>
                      {item.display_name ?? item.mdm_device_id}
                      <small>{item.mdm_device_id}</small>
                    </span>
                  </td>
                  <td data-label="Modelo / SO">
                    {item.model ?? 'Sin modelo'} · {item.os_version ?? 'SO sin dato'}
                  </td>
                  <td data-label="Estado">{item.status}</td>
                  <td data-label="GEOPS">{item.geops_device_id ?? 'Sin asociar'}</td>
                  <td data-label="Visto">{new Date(item.last_seen_at).toLocaleString('es-GT')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">
          Todavía no hay Android sincronizados. Ejecuta la sincronización después de verificar el
          tenant.
        </p>
      )}
      {!inventory.loading && !inventory.error && (
        <nav className="mdm-pages" aria-label="Páginas del inventario MDM">
          <span>
            Página {history.length + 1} · {inventory.data?.items.length ?? 0} equipos en esta página
          </span>
          <button
            type="button"
            disabled={history.length === 0}
            onClick={() => {
              setCursor(history.at(-1) || undefined);
              setHistory(history.slice(0, -1));
            }}
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={!inventory.data?.next_cursor}
            onClick={() => {
              setHistory([...history, cursor ?? '']);
              setCursor(inventory.data?.next_cursor ?? undefined);
            }}
          >
            Siguiente
          </button>
        </nav>
      )}
      {eligible.length > 0 && (
        <div className="mdm-link-form">
          <h3>Asociar con GEOPS</h3>
          <p>Confirma físicamente qué teléfono corresponde al registro GEOPS antes de guardar.</p>
          <label>
            Equipo MDM
            <select
              value={mdmId}
              onChange={(event) => {
                setMdmId(event.target.value);
                setVerified(false);
              }}
            >
              <option value="">Seleccionar equipo</option>
              {eligible.map((item) => (
                <option key={item.mdm_device_id} value={item.mdm_device_id}>
                  {item.display_name ?? item.model ?? 'Android'} · {item.mdm_device_id}
                </option>
              ))}
            </select>
          </label>
          {chosen && !chosen.geops_device_id && (
            <>
              <label>
                Registro GEOPS
                <select
                  value={geopsId}
                  onChange={(event) => {
                    setGeopsId(event.target.value);
                    setVerified(false);
                  }}
                >
                  <option value="">Seleccionar registro</option>
                  {(geops.data?.items ?? [])
                    .filter((item) => !['REVOKED', 'RETIRED'].includes(item.status))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.display_label} · {item.id}
                      </option>
                    ))}
                </select>
              </label>
              <label className="mdm-confirm">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(event) => setVerified(event.target.checked)}
                />
                Verifiqué el teléfono y el registro GEOPS por un canal independiente.
              </label>
            </>
          )}
          {Boolean(geops.error) && <p role="alert">No se pudieron cargar los registros GEOPS.</p>}
          <button
            type="button"
            onClick={() => void changeLink()}
            disabled={busy || !chosen || (!chosen.geops_device_id && (!geopsId || !verified))}
          >
            {chosen?.geops_device_id ? 'Desvincular inventario' : 'Guardar asociación'}
          </button>
        </div>
      )}
    </section>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/inventory" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/activate-admin" element={<ActivateAdmin />} />
      <Route
        path="/admin/users"
        element={
          <Protected>
            <Shell>
              <AdminUsers />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/inventory"
        element={
          <Protected>
            <Inventory />
          </Protected>
        }
      />
      <Route
        path="/clients/:id?"
        element={
          <Protected>
            <Shell>
              <ClientCatalog />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/routes/:id?"
        element={
          <Protected>
            <Shell>
              <RouteCatalog />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/schedule"
        element={
          <Protected>
            <Shell>
              <VisitSchedule />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/status"
        element={
          mdmEnabled ? (
            <Protected>
              <Status />
            </Protected>
          ) : (
            <Navigate to="/inventory" replace />
          )
        }
      />
      {(['policies', 'devices', 'sessions', 'executive'] as GpsSection[]).map((section) => (
        <Route
          key={section}
          path={`/gps/${section}`}
          element={
            <Protected>
              <Shell>
                <GpsWorkspace section={section} />
              </Shell>
            </Protected>
          }
        />
      ))}
      <Route
        path="*"
        element={
          <main id="content" className="center-state">
            <div>
              <h1>Página no encontrada</h1>
              <p>La dirección solicitada no existe en GEOPS Staging.</p>
              <Link to="/inventory">Ir al inicio</Link>
            </div>
          </main>
        }
      />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter basename={webBase === '/' ? '/' : webBase.slice(0, -1)}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
