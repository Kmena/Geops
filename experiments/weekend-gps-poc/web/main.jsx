import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import QRCode from 'qrcode';
import 'leaflet/dist/leaflet.css';
import './style.css';

async function request(path, { method = 'GET', body, csrf } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-POC-CSRF': csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'request_failed');
  return data;
}
const toIso = (value) => new Date(value).toISOString();
function TrackMap({ points }) {
  const node = useRef(null),
    map = useRef(null),
    layer = useRef(null);
  useEffect(() => {
    if (!map.current) {
      map.current = L.map(node.current).setView([0, 0], 2);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18,
      }).addTo(map.current);
      layer.current = L.layerGroup().addTo(map.current);
    }
    layer.current.clearLayers();
    const coords = points.map((p) => [Number(p.latitude), Number(p.longitude)]);
    if (coords.length) {
      L.polyline(coords, { color: '#17656a', weight: 4 }).addTo(layer.current);
      coords.forEach((point, i) => {
        L.circleMarker(point, { radius: 4 })
          .bindPopup(
            'Captura: ' +
              new Date(points[i].captured_at).toLocaleString() +
              '<br>Recepción: ' +
              new Date(points[i].received_at).toLocaleString() +
              '<br>Precisión: ' +
              Number(points[i].accuracy_m).toFixed(1) +
              ' m',
          )
          .addTo(layer.current);
      });
      map.current.fitBounds(L.latLngBounds(coords).pad(0.2), { maxZoom: 16 });
    }
    setTimeout(() => map.current?.invalidateSize(), 0);
  }, [points]);
  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
    },
    [],
  );
  return <div ref={node} className="map" role="img" aria-label="Mapa del recorrido experimental" />;
}
function App() {
  const [csrf, setCsrf] = useState('');
  const [password, setPassword] = useState('');
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState('');
  const [points, setPoints] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [sync, setSync] = useState(null);
  const [qr, setQr] = useState('');
  const [message, setMessage] = useState('');
  const [from, setFrom] = useState(toIso(Date.now() - 24 * 3600_000).slice(0, 16));
  const [to, setTo] = useState(toIso(Date.now()).slice(0, 16));
  useEffect(() => {
    request('/api/admin/me')
      .then((data) => setCsrf(data.csrf))
      .catch(() => {});
  }, []);
  async function refreshDevices() {
    const data = await request('/api/admin/devices');
    setDevices(data.items);
    if (!selected && data.items.length) setSelected(data.items[0].id);
  }
  useEffect(() => {
    if (!csrf) return;
    request('/api/admin/devices')
      .then((data) => {
        setDevices(data.items);
        setSelected((current) => current || data.items[0]?.id || '');
      })
      .catch(() => setMessage('No se pudo cargar el inventario.'));
  }, [csrf]);
  async function login(event) {
    event.preventDefault();
    try {
      const data = await request('/api/admin/login', { method: 'POST', body: { password } });
      setPassword('');
      setCsrf(data.csrf);
      setMessage('');
    } catch {
      setMessage('No se pudo iniciar sesión.');
    }
  }
  async function invite() {
    try {
      const data = await request('/api/admin/invitations', { method: 'POST', csrf });
      setQr(await QRCode.toDataURL(data.qr_payload, { errorCorrectionLevel: 'M' }));
      setMessage(
        'Invitación válida hasta ' +
          new Date(data.expires_at).toLocaleString() +
          '. Muéstrala solo al teléfono autorizado.',
      );
    } catch (error) {
      setMessage(
        error.message === 'device_limit'
          ? 'Solo se permite un dispositivo activo.'
          : 'No se pudo crear la invitación.',
      );
    }
  }
  async function loadHistory() {
    if (!selected) return;
    try {
      const query =
        '?from=' + encodeURIComponent(toIso(from)) + '&to=' + encodeURIComponent(toIso(to));
      const [history, values, state] = await Promise.all([
        request('/api/admin/devices/' + selected + '/history' + query),
        request('/api/admin/devices/' + selected + '/metrics' + query),
        request('/api/admin/devices/' + selected + '/sync-status'),
      ]);
      setPoints(history.items);
      setMetrics(values);
      setSync(state);
      setMessage('');
    } catch {
      setMessage('No se pudo consultar el historial.');
    }
  }
  async function revoke() {
    if (!selected || !window.confirm('¿Revocar este dispositivo experimental?')) return;
    try {
      await request('/api/admin/devices/' + selected + '/revoke', { method: 'POST', csrf });
      setQr('');
      await refreshDevices();
      setMessage('Dispositivo revocado.');
    } catch {
      setMessage('No se pudo revocar el dispositivo.');
    }
  }
  async function logout() {
    try {
      await request('/api/admin/logout', { method: 'POST', csrf });
    } catch {}
    setCsrf('');
    setDevices([]);
    setPoints([]);
    setQr('');
    setMetrics(null);
  }
  if (!csrf)
    return (
      <main className="login">
        <h1>GEOPS · GPS PoC</h1>
        <p>Entorno experimental. Un teléfono autorizado.</p>
        <form onSubmit={login}>
          <label>
            Contraseña de administración
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button type="submit">Entrar</button>
        </form>
        <p role="alert">{message}</p>
      </main>
    );
  return (
    <main>
      <header>
        <h1>GPS PoC · fin de semana</h1>
        <button type="button" onClick={logout}>
          Salir
        </button>
      </header>
      <p className="notice">
        Experimento aislado. La captura real requiere aprobación previa de privacidad y despliegue.
      </p>
      <section className="grid">
        <article>
          <h2>Dispositivos</h2>
          <button type="button" onClick={invite}>
            Registrar dispositivo
          </button>{' '}
          <button type="button" onClick={refreshDevices}>
            Actualizar
          </button>
          {qr && (
            <div>
              <img src={qr} alt="QR temporal de inscripción" />
              <p>El QR es secreto de un solo uso; no lo captures ni lo compartas.</p>
            </div>
          )}
          <ul>
            {devices.map((item) => (
              <li key={item.id}>
                <button type="button" className="link" onClick={() => setSelected(item.id)}>
                  {item.id.slice(0, 8)}
                </button>{' '}
                · {item.revoked_at ? 'revocado' : 'activo'} · {item.location_count} posiciones
              </li>
            ))}
          </ul>
          {selected && (
            <button type="button" onClick={revoke}>
              Revocar dispositivo
            </button>
          )}
        </article>
        <article>
          <h2>Consulta</h2>
          <label>
            Desde
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Hasta
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" disabled={!selected} onClick={loadHistory}>
            Ver recorrido
          </button>
          <p>Comunicación: {sync?.communication ?? 'sin consulta'}</p>
          <p>
            Última coordenada:{' '}
            {points.length
              ? Number(points.at(-1).latitude).toFixed(5) +
                ', ' +
                Number(points.at(-1).longitude).toFixed(5)
              : 'sin datos'}
          </p>
          <p>
            Última recepción:{' '}
            {sync?.last_received ? new Date(sync.last_received).toLocaleString() : 'sin datos'}
          </p>
        </article>
      </section>
      <p role="status">{message}</p>
      <section>
        <h2>Mapa</h2>
        <TrackMap points={points} />
        <p>Datos: OpenStreetMap contributors.</p>
      </section>
      <section>
        <h2>Métricas</h2>
        <div className="metrics">
          <p>Ubicaciones: {metrics?.location_count ?? 0}</p>
          <p>Precisión promedio: {metrics?.average_accuracy_m?.toFixed(1) ?? '—'} m</p>
          <p>Intervalo medio: {metrics?.average_interval_seconds?.toFixed(1) ?? '—'} s</p>
          <p>Intervalo máximo: {metrics?.max_interval_seconds?.toFixed(1) ?? '—'} s</p>
          <p>Sincronizadas tarde: {metrics?.delayed_count ?? 0}</p>
        </div>
        <h3>Eventos</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Captura</th>
                <th>Recepción</th>
                <th>Precisión</th>
                <th>Latitud</th>
                <th>Longitud</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.event_id}>
                  <td>{new Date(p.captured_at).toLocaleString()}</td>
                  <td>{new Date(p.received_at).toLocaleString()}</td>
                  <td>{Number(p.accuracy_m).toFixed(1)} m</td>
                  <td>{Number(p.latitude).toFixed(5)}</td>
                  <td>{Number(p.longitude).toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);
