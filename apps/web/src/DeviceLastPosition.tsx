import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { ApiClientError } from './api/client.js';
import { tileAttribution, tileTemplate } from './gps/map-model.js';
import { GpsRemote, type RemotePosition } from './gps/remote.js';

const tiles = tileTemplate(import.meta.env?.VITE_GPS_TILE_URL as string | undefined);
const date = (value: string) => new Date(value).toLocaleString('es-GT');

function LastPositionMap({ position }: { position: RemotePosition }) {
  const host = useRef<HTMLDivElement>(null);
  const [mapError, setMapError] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let map: Leaflet.Map | null = null;
    let resize: ResizeObserver | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        const point: Leaflet.LatLngTuple = [position.latitude, position.longitude];
        map = L.map(host.current, { zoomControl: false }).setView(point, 16);
        L.control
          .zoom({ position: 'topright', zoomInTitle: 'Acercar mapa', zoomOutTitle: 'Alejar mapa' })
          .addTo(map);
        if (tiles)
          L.tileLayer(tiles, { maxZoom: 18, attribution: tileAttribution() })
            .on('tileerror', () => {
              if (!disposed) setMapError(true);
            })
            .addTo(map);
        else setMapError(true);
        L.circle(point, {
          radius: Math.max(1, position.accuracy_m),
          color: '#176b82',
          weight: 2,
          fillColor: '#176b82',
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(map);
        L.circleMarker(point, {
          radius: 9,
          color: '#fff',
          weight: 3,
          fillColor: '#b5412c',
          fillOpacity: 1,
        })
          .bindTooltip('Última posición registrada')
          .addTo(map);
        if (typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(() => map?.invalidateSize());
          resize.observe(host.current);
        }
        map.invalidateSize();
      })
      .catch(() => {
        if (!disposed) setMapError(true);
      });
    return () => {
      disposed = true;
      resize?.disconnect();
      map?.remove();
    };
  }, [position]);

  return (
    <>
      <div
        ref={host}
        className="managed-last-position-map"
        role="application"
        aria-label={`Mapa de la última posición recibida el ${date(position.received_at)}`}
      />
      {mapError && (
        <p role="status">No se cargó el mapa base. Las coordenadas siguen disponibles abajo.</p>
      )}
    </>
  );
}

export function DeviceLastPosition({ deviceId }: { deviceId: string }) {
  const [refresh, setRefresh] = useState(0);
  const [position, setPosition] = useState<RemotePosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh intentionally reruns the location request.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void new GpsRemote()
      .latestPosition(deviceId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPosition(result.position);
        setChecked(true);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          failure instanceof ApiClientError && failure.status === 403
            ? 'Ya no tienes permiso para consultar la ubicación de este equipo.'
            : 'No se pudo consultar la última ubicación. Intenta actualizarla.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [deviceId, refresh]);

  return (
    <section className="managed-last-position" aria-label="Última ubicación">
      <div className="managed-last-position-head">
        <h4>Última ubicación</h4>
        <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? 'Consultando…' : 'Actualizar ubicación'}
        </button>
      </div>
      {loading && !checked && <p role="status">Consultando la última posición…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && checked && !position && <p>Este equipo aún no tiene ubicaciones recibidas.</p>}
      {position && (
        <>
          <LastPositionMap position={position} />
          <p className="managed-last-position-meta">
            Recibida: <strong>{date(position.received_at)}</strong> · Capturada:{' '}
            {date(position.captured_at)} · Precisión: ±{Math.round(position.accuracy_m)} m
          </p>
          <p className="managed-last-position-coordinates">
            {position.latitude.toFixed(6)}, {position.longitude.toFixed(6)}
          </p>
        </>
      )}
    </section>
  );
}
