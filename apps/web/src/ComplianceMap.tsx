import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import type { ComplianceDeviceLocation, ComplianceVisit } from './api/client.js';
import { tileAttribution, tileTemplate } from './gps/map-model.js';
import 'leaflet/dist/leaflet.css';

const tiles = tileTemplate(import.meta.env.VITE_GPS_TILE_URL as string | undefined);
const colors: Record<string, string> = {
  COMPLETED: '#147d6f',
  IN_PROGRESS: '#d18a1d',
  PENDING: '#4473a6',
  INCOMPLETE: '#ae7024',
  NOT_VISITED: '#85516a',
  INSUFFICIENT_EVIDENCE: '#746c93',
  UNATTRIBUTABLE: '#9a4d55',
  CANCELLED: '#697786',
};

export function ComplianceMap({
  visits,
  locations,
  onSelect,
}: {
  visits: ComplianceVisit[];
  locations: ComplianceDeviceLocation[];
  onSelect: (visit: ComplianceVisit) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layers = useRef<Leaflet.LayerGroup | null>(null);
  const leaflet = useRef<typeof Leaflet | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let resize: ResizeObserver | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        leaflet.current = L;
        const instance = L.map(host.current, { zoomControl: false }).setView(
          [14.6349, -90.5069],
          12,
        );
        map.current = instance;
        L.control.zoom({ position: 'topright' }).addTo(instance);
        layers.current = L.layerGroup().addTo(instance);
        if (tiles)
          L.tileLayer(tiles, { maxZoom: 18, attribution: tileAttribution() }).addTo(instance);
        if (typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(() => instance.invalidateSize());
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
      map.current?.remove();
      map.current = null;
      layers.current = null;
      leaflet.current = null;
    };
  }, []);
  useEffect(() => {
    if (!ready || !map.current || !layers.current || !leaflet.current) return;
    const L = leaflet.current;
    layers.current.clearLayers();
    const points: Leaflet.LatLngExpression[] = [];
    for (const visit of visits) {
      if (!Number.isFinite(visit.latitude) || !Number.isFinite(visit.longitude)) continue;
      const center: Leaflet.LatLngExpression = [visit.latitude, visit.longitude];
      const color = colors[visit.status] ?? '#697786';
      points.push(center);
      L.circle(center, {
        radius: visit.radius_m,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.13,
      }).addTo(layers.current);
      L.circleMarker(center, { radius: 8, color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${visit.client_name} · ${visit.route_name} · ${visit.status}`)
        .on('click', () => onSelect(visit))
        .addTo(layers.current);
    }
    for (const location of locations) {
      if (location.latitude === null || location.longitude === null) continue;
      const center: Leaflet.LatLngExpression = [location.latitude, location.longitude];
      points.push(center);
      const ageMinutes = location.captured_at
        ? Math.max(0, Math.round((Date.now() - Date.parse(location.captured_at)) / 60000))
        : null;
      L.circleMarker(center, {
        radius: 10,
        color: '#273449',
        weight: 3,
        fillColor: '#f7fbff',
        fillOpacity: 1,
        dashArray: '3 3',
      })
        .bindTooltip(
          `Última ubicación conocida · dispositivo ${location.device_id} · ${location.captured_at ?? 'sin fecha'} · ${ageMinutes ?? '—'} min de antigüedad`,
        )
        .addTo(layers.current);
    }
    if (points.length)
      map.current.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 15, animate: false });
  }, [ready, visits, locations, onSelect]);
  return (
    <div className="compliance-map-wrap">
      <div
        ref={host}
        className="compliance-map"
        role="application"
        aria-label="Mapa de visitas y geozonas circulares"
      />
      {!ready && !failed && <p role="status">Cargando mapa…</p>}
      {failed && (
        <p role="alert">No se pudo cargar el mapa. Las visitas siguen disponibles en la tabla.</p>
      )}
    </div>
  );
}
