import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import type { VisitMapData } from './api/client.js';
import { tileAttribution, tileTemplate } from './gps/map-model.js';
import 'leaflet/dist/leaflet.css';

const tiles = tileTemplate(import.meta.env.VITE_GPS_TILE_URL as string | undefined);
const colors = { INSIDE: '#147d6f', OUTSIDE: '#a44137', UNCERTAIN: '#8b641d' } as const;

export function VisitEvidenceMap({ data }: { data: VisitMapData }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let map: Leaflet.Map | null = null;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        const historical = data.historical_geofence;
        map = L.map(host.current, { zoomControl: true }).setView(
          [historical.latitude, historical.longitude], 15,
        );
        if (tiles) L.tileLayer(tiles, { maxZoom: 18, attribution: tileAttribution() }).addTo(map);
        const bounds = L.latLngBounds([]);
        const historicalCircle = L.circle([historical.latitude, historical.longitude], {
          radius: historical.radius_m,
          color: '#746c93',
          weight: 3,
          fillColor: '#746c93',
          fillOpacity: 0.12,
        }).bindTooltip(`Geozona histórica · versión ${historical.revision}`).addTo(map);
        bounds.extend(historicalCircle.getBounds());
        if (data.current_geofence) {
          const current = data.current_geofence;
          const currentCircle = L.circle([current.latitude, current.longitude], {
            radius: current.radius_m,
            color: '#176b82',
            weight: 2,
            dashArray: '5 5',
            fillOpacity: 0,
          }).bindTooltip(`Geozona actual · versión ${current.revision}`).addTo(map);
          bounds.extend(currentCircle.getBounds());
        }
        L.circleMarker([data.site.latitude, data.site.longitude], {
          radius: 7,
          color: '#25384b',
          weight: 3,
          fillColor: '#fff',
          fillOpacity: 1,
        }).bindTooltip('Sede actual').addTo(map);
        bounds.extend([data.site.latitude, data.site.longitude]);
        let previous: VisitMapData['positions'][number] | null = null;
        let accuracyCircle: Leaflet.Circle | null = null;
        for (const position of data.positions) {
          const point: Leaflet.LatLngTuple = [position.latitude, position.longitude];
          if (
            previous && previous.session_id === position.session_id &&
            Date.parse(position.captured_at) - Date.parse(previous.captured_at) <= 300_000
          )
            L.polyline([[previous.latitude, previous.longitude], point], {
              color: '#586879', weight: 2, opacity: 0.75,
            }).addTo(map);
          const marker = L.circleMarker(point, {
            radius: 6,
            color: '#fff',
            weight: 2,
            fillColor: colors[position.spatial_state],
            fillOpacity: 1,
          }).addTo(map);
          const popup = document.createElement('div');
          for (const value of [
            `Captura: ${new Date(position.captured_at).toLocaleString('es-GT')}`,
            `Precisión: ±${position.accuracy_m} m`,
            `Distancia al centro histórico: ${Math.round(position.distance_m)} m`,
          ]) {
            const line = document.createElement('div');
            line.textContent = value;
            popup.append(line);
          }
          marker.bindPopup(popup);
          marker.on('click', () => {
            accuracyCircle?.remove();
            accuracyCircle = L.circle(point, {
              radius: Math.max(1, position.accuracy_m),
              color: colors[position.spatial_state],
              fillOpacity: 0.08,
            }).addTo(map!);
          });
          bounds.extend(point);
          previous = position;
        }
        map.fitBounds(bounds.pad(0.2), { maxZoom: 17, animate: false });
        map.invalidateSize();
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [data]);
  return (
    <div>
      <div ref={host} className="compliance-visit-map" role="application" aria-label="Mapa de sede, geozonas y posiciones GPS de la visita" />
      {failed && <p role="alert">No se pudo cargar el mapa; revisa la lista de posiciones.</p>}
      <p>Morado: geozona histórica usada para evaluar · Azul punteado: geozona actual · Verde: dentro con margen de precisión · Rojo: fuera · Ámbar: posición incierta.</p>
      <p>{data.positions.length} posiciones vinculadas al agente y a la sesión durante esta jornada. La ubicación en el mapa no acredita por sí sola permanencia.</p>
      <ol className="compliance-map-positions">
        {data.positions.map((position) => (
          <li key={position.event_id}>
            {new Date(position.captured_at).toLocaleString('es-GT')} · {position.spatial_state === 'INSIDE' ? 'Dentro' : position.spatial_state === 'OUTSIDE' ? 'Fuera' : 'Incierta'} · ±{position.accuracy_m} m · {Math.round(position.distance_m)} m del centro histórico
          </li>
        ))}
      </ol>
    </div>
  );
}
