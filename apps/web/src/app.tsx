import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { api, ApiClientError, type Device, type MdmDevice, type MdmStatus } from './api/client.js';
import { AuthProvider, useAuth } from './auth.js';
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
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
  }, []);
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
          <span className="environment">Datos sintéticos · sin conexión MDM real</span>
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
            <Link aria-current={location.pathname === '/status' ? 'page' : undefined} to="/status">
              Integración MDM
            </Link>
          </nav>
          <main id="content" tabIndex={-1} ref={main}>
            <div className="page-head">
              <span className="eyebrow">Wave 0A · simulación</span>
              <span className="user-label">{profile?.email}</span>
            </div>
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

function useLoad<T>(load: () => Promise<T>) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: unknown }>({
    loading: true,
    data: null,
    error: null,
  });
  const refresh = () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    void load()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  };
  useEffect(refresh, [load]);
  return { ...state, refresh };
}

function Inventory() {
  const geops = useLoad(api.geopsDevices);
  const mdm = useLoad(api.mdmDevices);
  return (
    <Shell>
      <h1>Inventario</h1>
      <p className="lead">Registros GEOPS y respuesta de un proveedor MDM simulado.</p>
      <div className="grid">
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
              {geops.data.items.map((item: Device) => (
                <li key={item.id}>
                  <strong>{item.display_label}</strong>
                  <span>{item.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="mdm-title">
          <div className="panel-head">
            <h2 id="mdm-title">Inventario MDM</h2>
            <span className="badge fake">Fuente: fake</span>
          </div>
          {mdm.loading ? (
            <p role="status">Cargando inventario simulado…</p>
          ) : mdm.error ? (
            <>
              <ErrorText error={mdm.error} />
              <button type="button" onClick={mdm.refresh}>
                Reintentar
              </button>
            </>
          ) : !mdm.data?.items.length ? (
            <p className="empty">
              El proveedor simulado no tiene equipos. Una lista vacía no valida ManageEngine.
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
      </div>
    </Shell>
  );
}

function Status() {
  const state = useLoad(api.mdmStatus);
  return (
    <Shell>
      <h1>Integración MDM</h1>
      <p className="lead">Estado visible de la fuente usada durante Wave 0A.</p>
      <section className="panel status-panel" aria-labelledby="status-title">
        <h2 id="status-title">Proveedor de desarrollo</h2>
        {state.loading ? (
          <p role="status">Cargando estado…</p>
        ) : state.error ? (
          <>
            <ErrorText error={state.error} />
            <button type="button" onClick={state.refresh}>
              Reintentar
            </button>
          </>
        ) : (
          <dl>
            <div>
              <dt>Proveedor</dt>
              <dd>{(state.data as MdmStatus).provider}</dd>
            </div>
            <div>
              <dt>Fuente</dt>
              <dd>Simulada</dd>
            </div>
            <div>
              <dt>Edición Free</dt>
              <dd>Sin validar</dd>
            </div>
            <div>
              <dt>Acceso real</dt>
              <dd>Deshabilitado en Wave 0A</dd>
            </div>
          </dl>
        )}
      </section>
    </Shell>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/inventory"
        element={
          <Protected>
            <Inventory />
          </Protected>
        }
      />
      <Route
        path="/status"
        element={
          <Protected>
            <Status />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/inventory" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
