import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, ApiClientError, type Device, type DeviceInvitation } from './api/client.js';
import { useAuth } from './auth.js';

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'La sesión expiró. Vuelve a iniciar sesión.';
    if (error.status === 403) return 'No tienes autorización para esta operación.';
    if (error.status === 409) return 'El estado cambió. Actualiza el inventario.';
    if (error.status === 429) return 'Demasiados intentos. Espera y vuelve a probar.';
  }
  return 'No se pudo completar la operación.';
}

export function EnrollmentPanel({
  devices,
  capabilities,
  refresh,
}: {
  devices: Device[];
  capabilities: string[];
  refresh: () => void;
}) {
  const { profile } = useAuth();
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState('');
  const [invitation, setInvitation] = useState<DeviceInvitation | null>(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [physicalConfirmed, setPhysicalConfirmed] = useState(false);
  const [attestationException, setAttestationException] = useState(false);
  const [reason, setReason] = useState('');
  const device = devices.find((item) => item.id === selected);

  useEffect(() => {
    if (!invitation || !device || invitation.geops_device_id !== device.id) {
      setQr('');
      return;
    }
    let active = true;
    const payload = JSON.stringify({
      format: 'geops-enrollment-v1',
      origin: window.location.origin,
      geops_device_id: device.id,
      mdm_device_id: device.mdm_device_id,
      invitation_id: invitation.invitation_id,
      invitation_secret: invitation.invitation_secret,
      expires_at: invitation.expires_at,
    });
    void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure);
      });
    return () => {
      active = false;
    };
  }, [invitation, device]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !label.trim()) return;
    setBusy(true);
    setError(null);
    setInvitation(null);
    try {
      const created = await api.createDevice(label.trim(), profile.csrf_token);
      setLabel('');
      setSelected(created.id);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function issue() {
    if (!profile || !device) return;
    setBusy(true);
    setError(null);
    setInvitation(null);
    try {
      const issued = await api.issueInvitation(device, profile.csrf_token);
      setInvitation(issued);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!profile || !device?.invitation_id) return;
    setBusy(true);
    setError(null);
    setInvitation(null);
    try {
      await api.cancelInvitation(
        { ...device, invitation_id: device.invitation_id },
        profile.csrf_token,
      );
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!profile || !device?.claim_id || !physicalConfirmed || !/^[0-9]{8}$/.test(pairingCode))
      return;
    setBusy(true);
    setError(null);
    try {
      const scoped = { ...device, claim_id: device.claim_id };
      const evidence = await api.recordSyntheticEvidence(
        scoped,
        profile.csrf_token,
        attestationException,
      );
      await api.activateDevice(scoped, profile.csrf_token, pairingCode, evidence.evidence_ref);
      setPairingCode('');
      setPhysicalConfirmed(false);
      setAttestationException(false);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function activateInstallation() {
    if (
      !profile ||
      !device ||
      reason.trim().length < 8 ||
      !capabilities.includes('gps.installation.manage')
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.activateInstallation(device.id, profile.csrf_token, reason.trim());
      setReason('');
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (!capabilities.includes('gps.installation.manage')) {
    return (
      <section className="panel enrollment-panel" aria-labelledby="enrollment-title">
        <h2 id="enrollment-title">Inscripción de prueba</h2>
        <p>
          Se requiere la capacidad administrativa <code>gps.installation.manage</code>.
        </p>
      </section>
    );
  }

  return (
    <section className="panel enrollment-panel" aria-labelledby="enrollment-title">
      <h2 id="enrollment-title">Inscripción de prueba</h2>
      <p>
        Los registros nuevos se vinculan únicamente al tenant sintético. La asociación con una
        empresa real sigue bloqueada hasta aprobar identidad y MDM.
      </p>
      <form onSubmit={(event) => void create(event)}>
        <label>
          Nombre o código del equipo
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            minLength={1}
            maxLength={120}
            required
          />
        </label>
        <button type="submit" disabled={busy || !label.trim()}>
          Registrar borrador
        </button>
      </form>
      <label>
        Dispositivo
        <select
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setInvitation(null);
          }}
        >
          <option value="">Selecciona un dispositivo</option>
          {devices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.display_label} · {item.status}
            </option>
          ))}
        </select>
      </label>
      {device && (
        <div className="enrollment-detail">
          <p>
            <strong>Tenant:</strong> {device.tenant_id} · <strong>Estado:</strong> {device.status}
          </p>
          <p>
            <strong>ID MDM sintético:</strong> <code>{device.mdm_device_id}</code>
          </p>
          <p>
            <strong>Inscripción confirmada:</strong>{' '}
            {device.enrolled_at
              ? new Date(device.enrolled_at).toLocaleString('es-GT')
              : 'No confirmada'}
          </p>
          <p>
            <strong>Última comunicación observada:</strong>{' '}
            {device.last_communication_at
              ? new Date(device.last_communication_at).toLocaleString('es-GT')
              : 'Desconocida'}
          </p>
          <p>
            <strong>Invitación:</strong> {device.invitation_status ?? 'Sin invitación'}
            {device.invitation_expires_at
              ? ` · vence ${new Date(device.invitation_expires_at).toLocaleString('es-GT')}`
              : ''}
          </p>
          <div className="enrollment-actions">
            <button
              type="button"
              disabled={
                busy || !['DRAFT', 'INVITED', 'PENDING_CONFIRMATION'].includes(device.status)
              }
              onClick={() => void issue()}
            >
              Generar invitación
            </button>
            <button
              type="button"
              disabled={
                busy ||
                !device.invitation_id ||
                !['ISSUED', 'CLAIMED'].includes(device.invitation_status ?? '')
              }
              onClick={() => void cancel()}
            >
              Revocar invitación
            </button>
          </div>
          {device.claim_status === 'PENDING_CONFIRMATION' && (
            <div className="enrollment-confirm">
              <h3>Confirmación supervisada</h3>
              <p>
                Completa esta operación solo tras una prueba física autorizada y comparar el código
                mostrado por la aplicación con el equipo. La evidencia se registra como MDM
                sintético, sin validar un MDM real.
              </p>
              <label>
                Código de emparejamiento del teléfono
                <input
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  maxLength={8}
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                />
              </label>
              <label className="day-checkbox">
                <input
                  type="checkbox"
                  checked={physicalConfirmed}
                  onChange={(event) => setPhysicalConfirmed(event.target.checked)}
                />
                Confirmo que identifiqué físicamente el equipo autorizado.
              </label>
              <label className="day-checkbox">
                <input
                  type="checkbox"
                  checked={attestationException}
                  onChange={(event) => setAttestationException(event.target.checked)}
                />
                Autorizo la excepción de atestación no verificada para esta prueba sintética.
              </label>
              <button
                type="button"
                disabled={busy || !physicalConfirmed || !/^[0-9]{8}$/.test(pairingCode)}
                onClick={() => void confirm()}
              >
                Confirmar inscripción
              </button>
            </div>
          )}
          {device.status === 'ACTIVE' &&
            !device.installation_id &&
            capabilities.includes('gps.installation.manage') && (
              <div className="enrollment-confirm">
                <h3>Activar instalación GPS</h3>
                <label>
                  Motivo administrativo
                  <input
                    minLength={8}
                    maxLength={240}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || reason.trim().length < 8}
                  onClick={() => void activateInstallation()}
                >
                  Activar instalación
                </button>
              </div>
            )}
          {device.status === 'ACTIVE' && (
            <div className="enrollment-confirm">
              <h3>Identificadores de activación</h3>
              <p>
                Transfiere estos identificadores al agente después de la confirmación. No son
                credenciales.
              </p>
              <dl>
                <dt>Dispositivo</dt>
                <dd>
                  <code>{device.id}</code>
                </dd>
                <dt>Clave</dt>
                <dd>
                  <code>{device.key_id ?? 'Pendiente'}</code>
                </dd>
                <dt>Instalación</dt>
                <dd>
                  <code>{device.installation_id ?? 'Pendiente'}</code>
                </dd>
              </dl>
            </div>
          )}
        </div>
      )}
      {invitation && device?.id === invitation.geops_device_id && (
        <div className="enrollment-secret" role="status">
          <h3>Invitación de un solo uso</h3>
          <p>
            Se muestra solo ahora. Vence {new Date(invitation.expires_at).toLocaleString('es-GT')}.
            No la compartas por canales públicos.
          </p>
          {qr && (
            <img src={qr} alt="Código QR de inscripción GEOPS de prueba" width="320" height="320" />
          )}
          <dl>
            <dt>ID de invitación</dt>
            <dd>
              <code>{invitation.invitation_id}</code>
            </dd>
            <dt>Código de inscripción</dt>
            <dd>
              <code>{invitation.invitation_secret}</code>
            </dd>
            <dt>ID de dispositivo</dt>
            <dd>
              <code>{device.id}</code>
            </dd>
          </dl>
          <button
            type="button"
            onClick={() => {
              setInvitation(null);
              setQr('');
            }}
          >
            Ocultar código
          </button>
        </div>
      )}
      {error !== null && <p role="alert">{errorMessage(error)}</p>}
    </section>
  );
}
