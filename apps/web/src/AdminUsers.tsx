import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiClientError, type AdminInvitation, type AdminUserRecord } from './api/client.js';
import { useAuth } from './auth.js';

const ASSIGNABLE = [
  'gps.policy.read',
  'gps.policy.write',
  'gps.policy.assign',
  'gps.policy.activate',
  'gps.session.read',
  'gps.location.read',
  'gps.audit.read',
  'gps.installation.manage',
  'gps.tenant.grant',
];

function message(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'La sesión expiró. Vuelve a iniciar sesión.';
    if (error.status === 403) return 'Tu cuenta no puede administrar usuarios o esta operación.';
    if (error.status === 409) return 'El usuario o sus permisos cambiaron. Actualiza los datos.';
    if (error.status === 422) return 'Revisa los datos, el motivo y los permisos seleccionados.';
  }
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

export function AdminUsers() {
  const { profile } = useAuth();
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [tenant, setTenant] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [invitation, setInvitation] = useState<AdminInvitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const selected = users.find((user) => user.id === selectedId);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.adminUsers();
      setUsers(result.users);
      setTenant(result.tenant_id);
      setSelectedId((current) => (result.users.some((user) => user.id === current) ? current : ''));
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    await run(async () => {
      const created = await api.createAdminUser(email, reason, profile.csrf_token);
      setInvitation(created);
      setSelectedId(created.admin_id);
      setEmail('');
    }, 'Cuenta bloqueada creada. Entrega la invitación por un canal autorizado.');
  }

  async function changeCapabilities(action: 'GRANT' | 'REVOKE') {
    if (!profile || !selected || selection.length === 0) return;
    await run(
      () => api.changeAdminCapabilities(selected.id, action, selection, reason, profile.csrf_token),
      'Permisos actualizados y auditados.',
    );
    setSelection([]);
  }

  async function changeTenant(action: 'GRANT' | 'REVOKE') {
    if (!profile || !selected) return;
    await run(
      () => api.changeAdminTenantAccess(selected.id, action, reason, profile.csrf_token),
      'Acceso a la empresa actualizado y auditado.',
    );
  }

  async function reissue() {
    if (!profile || !selected) return;
    await run(async () => {
      setInvitation(await api.reissueAdminInvitation(selected.id, reason, profile.csrf_token));
    }, 'La invitación anterior quedó invalidada.');
  }

  async function revoke() {
    if (!profile || !selected) return;
    await run(
      () => api.revokeAdminUser(selected.id, reason, profile.csrf_token),
      'Cuenta, sesiones y accesos revocados.',
    );
  }

  return (
    <>
      <h1>Usuarios y permisos</h1>
      <p className="lead">
        Administra el acceso a la empresa de prueba y las capacidades GPS de cada persona. El
        servidor verifica cada cambio.
      </p>
      {loading && <p role="status">Cargando usuarios…</p>}
      {error !== null && (
        <p role="alert" className="notice error">
          {message(error)}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <button type="button" onClick={() => void refresh()} disabled={busy}>
        Actualizar usuarios
      </button>
      {!loading && error === null && (
        <div className="grid">
          <section className="panel" aria-labelledby="user-create-title">
            <h2 id="user-create-title">Agregar usuario</h2>
            <p>La cuenta nace bloqueada y sin permisos. Su invitación vence en 24 horas.</p>
            <form onSubmit={(event) => void create(event)}>
              <label>
                Correo individual
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label>
                Motivo
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={8}
                  maxLength={240}
                  required
                />
              </label>
              <button type="submit" disabled={busy}>
                Crear invitación
              </button>
            </form>
            {invitation && (
              <div role="status" className="notice">
                <p>
                  Invitación visible solo ahora. Entrégala por un canal autorizado; no la incluyas
                  en URLs o tickets.
                </p>
                <p>
                  ID: <code>{invitation.invitation_id}</code>
                </p>
                <p>
                  Token: <code>{invitation.invitation_token}</code>
                </p>
                <p>Vence: {new Date(invitation.expires_at).toLocaleString('es-GT')}</p>
                <Link to="/activate-admin">Abrir activación de cuenta</Link>
              </div>
            )}
          </section>
          <section className="panel" aria-labelledby="user-access-title">
            <h2 id="user-access-title">Permisos individuales</h2>
            <p>
              Empresa inicial: <strong>{tenant}</strong>
            </p>
            <label>
              Usuario
              <select
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setSelection([]);
                  setInvitation(null);
                }}
              >
                <option value="">Selecciona una cuenta</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email} · {user.state}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <>
                <p>
                  Capacidades vigentes:{' '}
                  {selected.capabilities.length ? selected.capabilities.join(' · ') : 'ninguna'}
                </p>
                <p>Datos del tenant: {selected.tenant_access ? 'autorizados' : 'sin concesión'}</p>
                {selected.id === profile?.id ? (
                  <p>La cuenta principal se modifica mediante ceremonia supervisada.</p>
                ) : (
                  <>
                    <fieldset disabled={busy || selected.state === 'REVOKED'}>
                      <legend>Selecciona una o varias capacidades para conceder o revocar</legend>
                      {ASSIGNABLE.map((permission) => (
                        <label key={permission}>
                          <input
                            type="checkbox"
                            checked={selection.includes(permission)}
                            onChange={(event) =>
                              setSelection((current) =>
                                event.target.checked
                                  ? [...current, permission]
                                  : current.filter((item) => item !== permission),
                              )
                            }
                          />
                          {permission}
                        </label>
                      ))}
                    </fieldset>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        selection.length === 0 ||
                        reason.trim().length < 8 ||
                        selected.state === 'REVOKED'
                      }
                      onClick={() => void changeCapabilities('GRANT')}
                    >
                      Conceder capacidades
                    </button>{' '}
                    <button
                      type="button"
                      disabled={
                        busy ||
                        selection.length === 0 ||
                        reason.trim().length < 8 ||
                        selected.state === 'REVOKED'
                      }
                      onClick={() => void changeCapabilities('REVOKE')}
                    >
                      Revocar capacidades
                    </button>
                    <p>El acceso a datos GPS de la empresa se concede por separado.</p>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        reason.trim().length < 8 ||
                        selected.tenant_access ||
                        selected.state !== 'ACTIVE'
                      }
                      onClick={() => void changeTenant('GRANT')}
                    >
                      Conceder acceso a empresa
                    </button>{' '}
                    <button
                      type="button"
                      disabled={
                        busy ||
                        reason.trim().length < 8 ||
                        !selected.tenant_access ||
                        selected.state !== 'ACTIVE'
                      }
                      onClick={() => void changeTenant('REVOKE')}
                    >
                      Revocar acceso a empresa
                    </button>{' '}
                    {selected.state === 'LOCKED' && (
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 8}
                        onClick={() => void reissue()}
                      >
                        Reemitir invitación
                      </button>
                    )}
                    {selected.state !== 'REVOKED' && (
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 8}
                        onClick={() => void revoke()}
                      >
                        Revocar cuenta
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

export function ActivateAdmin() {
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get('password') !== data.get('repeat')) {
      setError(new Error('password_mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.acceptAdminInvitation(
        String(data.get('invitation_id')),
        String(data.get('token')),
        String(data.get('password')),
      );
      setDone(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="content" className="login-shell">
      <section className="login-card">
        <h1>Activar cuenta GEOPS</h1>
        {done ? (
          <p role="status">
            Cuenta activada. <Link to="/login">Iniciar sesión</Link>
          </p>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <p>
              Introduce la invitación recibida por el canal autorizado. No pegues el token en la
              dirección del navegador.
            </p>
            <label>
              ID de invitación
              <input name="invitation_id" required />
            </label>
            <label>
              Token de invitación
              <input name="token" type="password" autoComplete="off" required />
            </label>
            <label>
              Contraseña nueva
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={16}
                required
              />
            </label>
            <label>
              Repetir contraseña
              <input
                name="repeat"
                type="password"
                autoComplete="new-password"
                minLength={16}
                required
              />
            </label>
            {error !== null && (
              <p role="alert">
                {error instanceof Error && error.message === 'password_mismatch'
                  ? 'Las contraseñas no coinciden.'
                  : message(error)}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? 'Activando…' : 'Activar cuenta'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
