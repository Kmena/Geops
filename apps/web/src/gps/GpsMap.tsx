import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import type { RemotePosition } from './remote.js';
import { mapLayers, tileAttribution, tileTemplate } from './map-model.js';
import { LOW_ACCURACY_M } from './tracking-model.js';
import 'leaflet/dist/leaflet.css';

const configuredTiles = tileTemplate(import.meta.env.VITE_GPS_TILE_URL as string | undefined);
type MapStatus = 'loading' | 'ready' | 'tiles-error' | 'engine-error';

export function GpsMap({
  positions,
  selectedId,
  onSelect,
  zone,
}: {
  positions: RemotePosition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  zone: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const tiles = useRef<Leaflet.TileLayer | null>(null);
  const engine = useRef<typeof Leaflet | null>(null);
  const fitted = useRef('');
  const restoreFocusId = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [status, setStatus] = useState<MapStatus>('loading');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [generation, setGeneration] = useState(0);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const data = useMemo(() => mapLayers(positions, selectedId), [positions, selectedId]);

  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(Boolean(entry?.isIntersecting)),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!visible || !host.current) return;
    let disposed = false;
    let instance: Leaflet.Map | null = null;
    let observer: ResizeObserver | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        engine.current = L;
        instance = L.map(host.current, { zoomControl: false });
        map.current = instance;
        L.control
          .zoom({ position: 'topright', zoomInTitle: 'Acercar mapa', zoomOutTitle: 'Alejar mapa' })
          .addTo(instance);
        layer.current = L.layerGroup().addTo(instance);
        if (configuredTiles) {
          tiles.current = L.tileLayer(configuredTiles, {
            maxZoom: 18,
            keepBuffer: 0,
            updateWhenIdle: true,
            updateWhenZooming: false,
            attribution: tileAttribution(),
          })
            .on('tileerror', () => {
              if (!disposed) setStatus('tiles-error');
            })
            .on('tileload', () => {
              if (!disposed)
                setStatus((current) => (current === 'tiles-error' ? 'tiles-error' : 'ready'));
            });
        }
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => instance?.invalidateSize());
          observer.observe(host.current);
        }
        if (!configuredTiles) setStatus('ready');
        setGeneration((current) => current + 1);
      })
      .catch(() => {
        if (!disposed) setStatus('engine-error');
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      instance?.remove();
      map.current = null;
      layer.current = null;
      tiles.current = null;
      engine.current = null;
      fitted.current = '';
    };
  }, [visible]);

  useEffect(() => {
    if (generation === 0) return;
    const L = engine.current;
    const instance = map.current;
    const group = layer.current;
    if (!L || !instance || !group) return;
    const focusedId = restoreFocusId.current;
    group.clearLayers();
    const fitKey = data.ordered
      .map((point) => `${point.event_id}:${point.latitude}:${point.longitude}`)
      .join('|');
    if (fitKey !== fitted.current) {
      fitted.current = fitKey;
      if (data.ordered.length === 1 && data.ordered[0])
        instance.setView([data.ordered[0].latitude, data.ordered[0].longitude], 15);
      else if (data.ordered.length > 1)
        instance.fitBounds(
          L.latLngBounds(data.ordered.map((point) => [point.latitude, point.longitude])),
          { padding: [48, 48], maxZoom: 16, animate: false },
        );
    }
    if (data.ordered.length && tiles.current && !instance.hasLayer(tiles.current))
      tiles.current.addTo(instance);
    if (!data.ordered.length) {
      if (tiles.current && instance.hasLayer(tiles.current)) instance.removeLayer(tiles.current);
      setStatus('ready');
    }
    const keyboardCleanup: Array<() => void> = [];
    for (const segment of data.segments) {
      if (segment.length > 1)
        L.polyline(
          segment.map((point) => [point.latitude, point.longitude] as Leaflet.LatLngTuple),
          { color: '#176b82', weight: 4, opacity: 0.9 },
        ).addTo(group);
    }
    if (data.selected) {
      L.circle([data.selected.latitude, data.selected.longitude], {
        radius: Math.max(1, data.selected.accuracy_m),
        color: '#176b82',
        weight: 2,
        fillColor: '#176b82',
        fillOpacity: 0.13,
        interactive: false,
      }).addTo(group);
    }
    const date = new Intl.DateTimeFormat('es-CR', {
      timeZone: zone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    data.ordered.forEach((point, index) => {
      const latest = point.event_id === data.latest?.event_id;
      const selected = point.event_id === data.selected?.event_id;
      const marker = L.circleMarker([point.latitude, point.longitude], {
        radius: latest ? 9 : selected ? 8 : 6,
        color: '#fff',
        weight: 2,
        fillColor: latest ? '#b5412c' : point.accuracy_m >= LOW_ACCURACY_M ? '#8b641d' : '#176b82',
        fillOpacity: 1,
      }).addTo(group);
      const popup = document.createElement('div');
      popup.className = 'gps-map-popup';
      const heading = document.createElement('strong');
      heading.textContent = latest ? 'Última posición' : `Posición ${index + 1}`;
      popup.append(heading);
      for (const line of [
        `Captura: ${date.format(new Date(point.captured_at))}`,
        `Recepción: ${date.format(new Date(point.received_at))}`,
        `Precisión: ±${point.accuracy_m} m`,
      ]) {
        const row = document.createElement('span');
        row.textContent = line;
        popup.append(row);
      }
      marker.bindPopup(popup);
      marker.on('click', () => onSelectRef.current(point.event_id));
      const element = marker.getElement();
      if (element) {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('data-gps-point-id', point.event_id);
        element.setAttribute(
          'aria-label',
          `${latest ? 'Última posición' : `Posición ${index + 1}`}, captura ${date.format(new Date(point.captured_at))}, precisión ${point.accuracy_m} metros`,
        );
        const keydown = (event: Event) => {
          const key = (event as KeyboardEvent).key;
          if (key === 'Enter' || key === ' ') {
            event.preventDefault();
            restoreFocusId.current = point.event_id;
            onSelectRef.current(point.event_id);
            marker.openPopup();
          }
        };
        element.addEventListener('keydown', keydown);
        keyboardCleanup.push(() => element.removeEventListener('keydown', keydown));
        if (focusedId === point.event_id) (element as SVGElement).focus();
      }
    });
    restoreFocusId.current = null;
    return () => {
      for (const clean of keyboardCleanup) clean();
      group.clearLayers();
    };
  }, [data, generation, zone]);

  return (
    <div className="gps-map-frame">
      <div className="gps-map-shell">
        <section
          ref={host}
          className="gps-map-canvas"
          aria-label="Mapa de ubicaciones GPS. La tabla siguiente permite consultar cada posición con teclado."
        />
      </div>
      {status === 'loading' && (
        <p className="gps-map-overlay" role="status">
          Cargando mapa…
        </p>
      )}
      {!configuredTiles && status !== 'engine-error' && (
        <p className="gps-map-overlay" role="status">
          Mapa sin calles: falta configurar una fuente de teselas aprobada. Los puntos y recorridos
          siguen visibles.
        </p>
      )}
      {configuredTiles && !online && (
        <p className="gps-map-overlay" role="status">
          Sin conexión. Las teselas pueden no estar disponibles; las posiciones siguen en la tabla.
        </p>
      )}
      {configuredTiles && online && status === 'tiles-error' && (
        <p className="gps-map-overlay" role="alert">
          No se pudieron cargar las calles. Revisa la conexión o la fuente de teselas; las
          posiciones siguen disponibles.
        </p>
      )}
      {status === 'engine-error' && (
        <p className="gps-map-overlay" role="alert">
          No se pudo iniciar el mapa. Consulta las posiciones en la tabla.
        </p>
      )}
    </div>
  );
}
