import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { tileAttribution, tileTemplate } from './gps/map-model.js';
import 'leaflet/dist/leaflet.css';

const configuredTiles = tileTemplate(import.meta.env.VITE_GPS_TILE_URL as string | undefined);

export function CatalogMap({
  latitude,
  longitude,
  radius,
  onSelect,
}: {
  latitude: number | null;
  longitude: number | null;
  radius: number;
  onSelect: (latitude: number, longitude: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const overlay = useRef<Leaflet.LayerGroup | null>(null);
  const engine = useRef<typeof Leaflet | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let instance: Leaflet.Map | null = null;
    let resize: ResizeObserver | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        engine.current = L;
        instance = L.map(host.current, { zoomControl: false }).setView([14.6349, -90.5069], 12);
        map.current = instance;
        L.control
          .zoom({ position: 'topright', zoomInTitle: 'Acercar mapa', zoomOutTitle: 'Alejar mapa' })
          .addTo(instance);
        overlay.current = L.layerGroup().addTo(instance);
        if (configuredTiles)
          L.tileLayer(configuredTiles, { maxZoom: 18, attribution: tileAttribution() }).addTo(
            instance,
          );
        instance.on('click', (event) =>
          select.current(Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6))),
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
      overlay.current = null;
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    if (!ready || !map.current || !overlay.current || !engine.current) return;
    overlay.current.clearLayers();
    if (
      latitude === null ||
      longitude === null ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    )
      return;
    const L = engine.current;
    const center: Leaflet.LatLngExpression = [latitude, longitude];
    L.circleMarker(center, {
      radius: 6,
      color: '#0f546f',
      weight: 2,
      fillColor: '#ffffff',
      fillOpacity: 1,
    }).addTo(overlay.current);
    if (Number.isFinite(radius) && radius > 0) {
      L.circle(center, {
        radius,
        color: '#0e7390',
        weight: 2,
        fillColor: '#0e7390',
        fillOpacity: 0.16,
      }).addTo(overlay.current);
      const pixels = Math.min(map.current.getSize().x, map.current.getSize().y) * 0.28;
      const zoom = Math.max(
        3,
        Math.min(
          18,
          Math.floor(
            Math.log2((156543.03 * Math.cos((latitude * Math.PI) / 180) * pixels) / radius),
          ),
        ),
      );
      map.current.setView(center, zoom, { animate: false });
    } else map.current.setView(center, 15, { animate: false });
  }, [ready, latitude, longitude, radius]);
  return (
    <div className="catalog-map-wrap">
      <div
        ref={host}
        className="catalog-map"
        role="application"
        aria-label="Mapa para seleccionar el centro de la geozona"
      />
      {!ready && !failed && (
        <p className="catalog-map-message" role="status">
          Cargando mapa…
        </p>
      )}
      {failed && (
        <p className="catalog-map-message" role="alert">
          No se pudo cargar el mapa. Ingresa las coordenadas en el formulario.
        </p>
      )}
    </div>
  );
}
