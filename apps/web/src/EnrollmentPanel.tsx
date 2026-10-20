import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, ApiClientError, type Device, type DeviceInvitation } from './api/client.js';
import { useAuth } from './auth.js';
import { activationQrPayload } from './activation.js';

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'installation_pending') {
    return 'La inscripción quedó confirmada, pero la preparación GPS no se completó. Actualiza el equipo y usa «Activar instalación» si sigue pendiente.';
  }
  if (error instanceof Error && error.message === 'clipboard_unavailable') {
    return 'No se pudo copiar el código. Puedes introducirlo manualmente en la APK.';
  }
  if (error instanceof ApiClientError) {
    if (error.status === 0) return 'No hay conexión con el servidor. Comprueba la red.';
    if (error.status === 401) return 'La sesión expiró. Vuelve a iniciar sesión.';
    if (error.status === 403) return 'No tienes autorización para esta operación.';
    if (error.status === 409) return 'El estado cambió. Actualiza el inventario.';
    if (error.status === 429) return 'Demasiados intentos. Espera y vuelve a probar.';
    if (error.status >= 500)
      return 'El servidor no pudo completar la operación. Reintenta después.';
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
  const [issuedRecord, setIssuedRecord] = useState<Pick<
    DeviceInvitation,
    'invitation_id' | 'geops_device_id' | 'expires_at'
  > | null>(null);
  const [qr, setQr] = useState('');
  const [activationQr, setActivationQr] = useState<{
    deviceId: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const issuing = useRef(false);
  const confirming = useRef(false);
  const activating = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [physicalConfirmed, setPhysicalConfirmed] = useState(false);
  const [attestationException, setAttestationException] = useState(false);
  const device = devices.find((item) => item.id === selected);
  const openInvitation = ['ISSUED', 'CLAIMED'].includes(device?.invitation_status ?? '');
  const localIssue =
    issuedRecord &&
    device &&
    issuedRecord.geops_device_id === device.id &&
    (device.invitation_id === issuedRecord.invitation_id
      ? device.invitation_status === 'ISSUED'
      : !openInvitation)
      ? issuedRecord
      : null;
  const currentInvitation =
    invitation && localIssue?.invitation_id === invitation.invitation_id ? invitation : null;
  const invitationIdToCancel =
    localIssue?.invitation_id ?? (openInvitation ? device?.invitation_id : null);
  const displayedExpiry = localIssue?.expires_at ?? device?.invitation_expires_at;
  const invitationExpired = !!displayedExpiry && Date.parse(displayedExpiry) <= Date.now();

  useEffect(() => {
    if (device?.status !== 'ACTIVE' || !device.key_id || !device.installation_id) {
      setActivationQr(null);
      return;
    }
    let active = true;
    const updateQr = () => {
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const payload = activationQrPayload(device, window.location.origin, expiresAt);
      void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
        .then((value) => {
          if (active) setActivationQr({ deviceId: device.id, url: value, expiresAt });
        })
        .catch((failure: unknown) => {
          if (active) setError(failure);
        });
    };
    updateQr();
    const interval = window.setInterval(updateQr, 10 * 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [device]);

  useEffect(() => {
    if (!invitation) return;
    const delay = Date.parse(invitation.expires_at) - Date.now();
    if (delay <= 0) {
      setInvitation(null);
      return;
    }
    const timeout = window.setTimeout(() => setInvitation(null), delay);
    return () => window.clearTimeout(timeout);
  }, [invitation]);

  useEffect(() => {
    if (!currentInvitation || !device) {
      setQr('');
      return;
    }
    let active = true;
    const payload = JSON.stringify({
      format: 'geops-enrollment-v1',
      origin: window.location.origin,
      geops_device_id: device.id,
      mdm_device_id: device.mdm_device_id,
      invitation_id: currentInvitation.invitation_id,
      invitation_secret: currentInvitation.invitation_secret,
      expires_at: currentInvitation.expires_at,
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
  }, [currentInvitation, device]);

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
    if (!profile || !device || issuing.current || busy || openInvitation || localIssue) return;
    issuing.current = true;
    setBusy(true);
    setError(null);
    try {
      const issued = await api.issueInvitation(device, profile.csrf_token);
      setIssuedRecord({
        invitation_id: issued.invitation_id,
        geops_device_id: issued.geops_device_id,
        expires_at: issued.expires_at,
      });
      setInvitation(issued);
      setCopied(false);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      issuing.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (!profile || !device || !invitationIdToCancel) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelInvitation(
        { ...device, invitation_id: invitationIdToCancel },
        profile.csrf_token,
      );
      setInvitation(null);
      setIssuedRecord(null);
      setQr('');
      setCopied(false);
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (
      !profile ||
      !device?.claim_id ||
      !physicalConfirmed ||
      !/^[0-9]{8}$/.test(pairingCode) ||
      confirming.current ||
      busy
    )
      return;
    confirming.current = true;
    setBusy(true);
    setError(null);
    let enrollmentConfirmed = false;
    try {
      const scoped = { ...device, claim_id: device.claim_id };
      const evidence = await api.recordSyntheticEvidence(
        scoped,
        profile.csrf_token,
        attestationException,
      );
      await api.activateDevice(scoped, profile.csrf_token, pairingCode, evidence.evidence_ref);
      enrollmentConfirmed = true;
      await api.activateInstallation(
        device.id,
        profile.csrf_token,
        'Preparación GPS tras inscripción supervisada en GEOPS Web',
      );
      setPairingCode('');
      setPhysicalConfirmed(false);
      setAttestationException(false);
      refresh();
    } catch (failure) {
      setError(enrollmentConfirmed ? new Error('installation_pending') : failure);
      refresh();
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  }
  async function activateInstallation() {
    if (
      !profile ||
      !device ||
      !capabilities.includes('gps.installation.manage') ||
      activating.current ||
      busy
    )
      return;
    activating.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.activateInstallation(
        device.id,
        profile.csrf_token,
        'Activación operativa solicitada desde inventario GEOPS Web',
      );
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      activating.current = false;
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
            setIssuedRecord(null);
            setCopied(false);
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
            <strong>Invitación:</strong>{' '}
            {localIssue && device.invitation_id !== localIssue.invitation_id
              ? `ISSUED (respuesta 201; inventario pendiente)${invitationExpired ? ' (vencida)' : ''}`
              : device.invitation_status
                ? `${device.invitation_status}${invitationExpired ? ' (vencida)' : ''}`
                : 'Sin invitación'}
            {displayedExpiry ? ` · vence ${new Date(displayedExpiry).toLocaleString('es-GT')}` : ''}
          </p>
          {(openInvitation || localIssue) && !currentInvitation && (
            <p role="status">
              El código de esta invitación solo se mostró al crearla. Si se perdió, revócala y
              genera una nueva; la invitación anterior quedará inválida.
            </p>
          )}
          <div className="enrollment-actions">
            <button
              type="button"
              disabled={
                busy ||
                openInvitation ||
                !!localIssue ||
                !['DRAFT', 'INVITED', 'PENDING_CONFIRMATION'].includes(device.status)
              }
              onClick={() => void issue()}
            >
              Generar invitación
            </button>
            <button
              type="button"
              disabled={busy || !invitationIdToCancel}
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
                Confirmar inscripción y preparar GPS
              </button>
            </div>
          )}
          {device.status === 'ACTIVE' &&
            !device.installation_id &&
            capabilities.includes('gps.installation.manage') && (
              <div className="enrollment-confirm">
                <h3>Activar instalación GPS</h3>
                <p>Activa el seguimiento de este equipo. La operación queda auditada.</p>
                <button type="button" disabled={busy} onClick={() => void activateInstallation()}>
                  Activar instalación
                </button>
              </div>
            )}
          {device.status === 'ACTIVE' && device.installation_id && (
            <div className="enrollment-confirm">
              <h3>Activar en el teléfono</h3>
              <p>
                Escanea este QR con la APK GEOPS en el equipo inscrito y pulsa «Iniciar
                seguimiento». La clave del teléfono y la política se verifican antes de iniciar.
              </p>
              {activationQr?.deviceId === device.id && (
                <>
                  <p>QR válido hasta {new Date(activationQr.expiresAt).toLocaleString('es-GT')}.</p>
                  <img
                    src={activationQr.url}
                    alt="QR de activación GPS para este dispositivo"
                    width="320"
                    height="320"
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}
      {currentInvitation && device && (
        <div className="enrollment-secret" role="status">
          <h3>Invitación creada</h3>
          <p>
            Código de un solo uso, visible únicamente en esta sesión. Vence{' '}
            {new Date(currentInvitation.expires_at).toLocaleString('es-GT')}; no lo compartas por
            canales públicos.
          </p>
          <p>
            Escanea el QR con la APK GEOPS actualizada o introduce los datos manualmente. El escaneo
            no reclama la invitación hasta que lo confirmes en el teléfono.
          </p>
          {qr && (
            <img src={qr} alt="Código QR de inscripción GEOPS de prueba" width="320" height="320" />
          )}
          <dl>
            <dt>ID de invitación</dt>
            <dd>
              <code>{currentInvitation.invitation_id}</code>
            </dd>
            <dt>Código de inscripción</dt>
            <dd>
              <code>{currentInvitation.invitation_secret}</code>
            </dd>
            <dt>ID de dispositivo</dt>
            <dd>
              <code>{device.id}</code>
            </dd>
          </dl>
          <button
            type="button"
            onClick={() => {
              if (!navigator.clipboard) {
                setError(new Error('clipboard_unavailable'));
                return;
              }
              void navigator.clipboard
                .writeText(currentInvitation.invitation_secret)
                .then(() => {
                  setError(null);
                  setCopied(true);
                })
                .catch(() => setError(new Error('clipboard_unavailable')));
            }}
          >
            Copiar código
          </button>
          {copied && <p role="status">Código copiado al portapapeles.</p>}
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
