import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { tileAttribution, tileTemplate } from '../gps/map-model.js';
import type { Candidate, MapPoint } from './api.js';
import 'leaflet/dist/leaflet.css';

const tiles = tileTemplate(import.meta.env.VITE_GPS_TILE_URL as string | undefined);
const color = (state: string, kind: string) =>
  state === 'CONFLICT' || state === 'INVALID'
    ? '#b84839'
    : kind === 'WEEKLY_STOP'
      ? '#936320'
      : kind === 'TERRITORY_GROUP'
        ? '#5149a2'
        : '#136f73';

export function KmzMap({
  points,
  selectedId,
  candidates,
  geometry,
  onSelect,
}: {
  points: MapPoint[];
  selectedId: string | null;
  candidates: Candidate[];
  geometry: Record<string, unknown> | null;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const renderer = useRef<Leaflet.Renderer | null>(null);
  const engine = useRef<typeof Leaflet | null>(null);
  const selection = useRef(onSelect);
  selection.current = onSelect;
  const [generation, setGeneration] = useState(0);
  const [zoom, setZoom] = useState(8);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let disposed = false;
    let instance: Leaflet.Map | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        engine.current = L;
        instance = L.map(host.current, { zoomControl: true, preferCanvas: true }).setView(
          [9.93, -84.08],
          8,
        );
        map.current = instance;
        layer.current = L.layerGroup().addTo(instance);
        renderer.current = L.canvas();
        if (tiles)
          L.tileLayer(tiles, {
            maxZoom: 18,
            attribution: tileAttribution(),
            updateWhenIdle: true,
            keepBuffer: 0,
          }).addTo(instance);
        instance.on('zoomend moveend', () => setZoom(instance?.getZoom() ?? 8));
        setGeneration((n) => n + 1);
        setStatus('ready');
        requestAnimationFrame(() => instance?.invalidateSize());
      })
      .catch(() => {
        if (!disposed) setStatus('error');
      });
    return () => {
      disposed = true;
      instance?.remove();
      map.current = null;
      layer.current = null;
      renderer.current = null;
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    if (generation === 0) return;
    const L = engine.current;
    const instance = map.current;
    const group = layer.current;
    if (!L || !instance || !group) return;
    group.clearLayers();
    const buckets = new Map<string, MapPoint[]>();
    for (const item of points) {
      if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue;
      const pixel = instance.project([item.latitude, item.longitude], zoom);
      const key = `${Math.floor(pixel.x / 44)}:${Math.floor(pixel.y / 44)}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      const first = bucket[0];
      if (!first) continue;
      const latitude = bucket.reduce((n, p) => n + p.latitude, 0) / bucket.length;
      const longitude = bucket.reduce((n, p) => n + p.longitude, 0) / bucket.length;
      const selected = bucket.find((item) => item.record_id === selectedId);
      const marker = L.circleMarker([latitude, longitude], {
        radius:
          bucket.length === 1
            ? selected
              ? 10
              : 6
            : Math.min(19, 8 + Math.log2(bucket.length) * 2),
        color: selected ? '#102f4b' : color(first.review_state, first.source_kind),
        weight: selected ? 3 : 2,
        fillOpacity: 0.78,
        renderer: renderer.current ?? undefined,
      }).addTo(group);
      marker.bindTooltip(
        bucket.length === 1 ? (first.name ?? 'Punto KMZ') : `${bucket.length} puntos KMZ`,
      );
      marker.on('click', () => {
        if (bucket.length === 1) selection.current(first.record_id);
        else instance.setView([latitude, longitude], Math.min(18, zoom + 2));
      });
    }
    for (const item of candidates)
      if (
        (item.target_type === 'ESTABLISHMENT' || item.target_type === 'PIN') &&
        item.latitude !== null &&
        item.longitude !== null
      ) {
        L.circleMarker([item.latitude, item.longitude], {
          radius: 8,
          color: '#173b72',
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 0.7,
        })
          .bindTooltip(`Catálogo: ${item.target_name ?? 'sin nombre'}`)
          .addTo(group);
      }
    if (
      geometry &&
      ['Polygon', 'LineString', 'MultiLineString', 'MultiPolygon'].includes(String(geometry.type))
    ) {
      try {
        const shape = L.geoJSON(geometry as unknown as GeoJSON.GeoJsonObject, {
          style: { color: '#7753a1', weight: 3, fillOpacity: 0.1 },
        }).addTo(group);
        if (!selectedId || !points.some((item) => item.record_id === selectedId))
          instance.fitBounds(shape.getBounds(), { padding: [35, 35], maxZoom: 14, animate: false });
      } catch {
        /* Invalid staging geometry stays visible in the detail diagnostics. */
      }
    }
    const selected = points.find((item) => item.record_id === selectedId);
    if (selected) instance.panTo([selected.latitude, selected.longitude], { animate: false });
  }, [points, selectedId, candidates, geometry, zoom, generation]);
  return (
    <div className="kmz-map-shell">
      <div
        ref={host}
        className="kmz-map"
        role="img"
        aria-label="Mapa de puntos KMZ y candidatos del catálogo"
      />
      {status === 'loading' && <p role="status">Cargando mapa…</p>}
      {status === 'error' && (
        <p role="alert">No se pudo abrir el mapa. La tabla continúa disponible.</p>
      )}
      <div className="kmz-map-key">
        <span>● Punto KMZ</span>
        <span>● Conflicto o inválido</span>
        <span>○ Catálogo</span>
      </div>
    </div>
  );
}
