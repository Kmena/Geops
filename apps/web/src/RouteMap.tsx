import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { tileAttribution, tileTemplate } from './gps/map-model.js';
import type { RouteStop } from './api/client.js';
import 'leaflet/dist/leaflet.css';

const configuredTiles = tileTemplate(import.meta.env.VITE_GPS_TILE_URL as string | undefined);

export function RouteMap({ stops }: { stops: RouteStop[] }) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layers = useRef<Leaflet.LayerGroup | null>(null);
  const engine = useRef<typeof Leaflet | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let resize: ResizeObserver | null = null;
    let instance: Leaflet.Map | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        engine.current = L;
        instance = L.map(host.current, { zoomControl: false }).setView([14.6349, -90.5069], 12);
        map.current = instance;
        L.control.zoom({ position: 'topright' }).addTo(instance);
        layers.current = L.layerGroup().addTo(instance);
        if (configuredTiles)
          L.tileLayer(configuredTiles, { maxZoom: 18, attribution: tileAttribution() }).addTo(
            instance,
          );
        if (typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(() => instance?.invalidateSize());
          resize.observe(host.current);
        }
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      resize?.disconnect();
      instance?.remove();
      map.current = null;
      layers.current = null;
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    if (!ready || !map.current || !layers.current || !engine.current) return;
    const L = engine.current;
    layers.current.clearLayers();
    const bounds: Leaflet.LatLngExpression[] = [];
    for (const stop of stops) {
      if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) continue;
      const center: Leaflet.LatLngExpression = [stop.latitude, stop.longitude];
      bounds.push(center);
      L.circle(center, {
        radius: stop.radius_m,
        color: stop.required ? '#0e7390' : '#837a70',
        weight: 2,
        fillColor: stop.required ? '#0e7390' : '#837a70',
        fillOpacity: 0.16,
      }).addTo(layers.current);
      L.circleMarker(center, {
        radius: 7,
        color: '#0f546f',
        weight: 2,
        fillColor: '#fff',
        fillOpacity: 1,
      })
        .bindTooltip(`${stop.client_name} · ${stop.site_name} · ${stop.geofence_revision}`, {
          direction: 'top',
        })
        .addTo(layers.current);
    }
    if (bounds.length)
      map.current.fitBounds(L.latLngBounds(bounds).pad(0.35), { maxZoom: 15, animate: false });
  }, [ready, stops]);
  return (
    <div className="catalog-map-wrap">
      <div
        ref={host}
        className="catalog-map"
        role="application"
        aria-label="Mapa de paradas y geozonas de la ruta"
      />
      {!ready && !failed && (
        <p className="catalog-map-message" role="status">
          Cargando mapa…
        </p>
      )}
      {failed && (
        <p className="catalog-map-message" role="alert">
          No se pudo cargar el mapa. Las paradas siguen disponibles en la lista.
        </p>
      )}
    </div>
  );
}
