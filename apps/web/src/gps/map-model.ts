import type { RemotePosition } from './remote.js';
import { routeSegments, sortAndDedupe } from './tracking-model.js';

export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** The pilot uses the PoC's OSM tiles unless a local OSM-derived route is configured. */
export function tileTemplate(value: string | undefined): string | null {
  if (!value) return OSM_TILE_URL;
  const local =
    /^\/(?!\/)[a-zA-Z0-9/_{}.-]+\.(?:png|webp)$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//');
  return (local || value === OSM_TILE_URL) &&
    ['{z}', '{x}', '{y}'].every((token) => value.includes(token))
    ? value
    : null;
}

export function tileAttribution(): string {
  return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
}

export function mapLayers(positions: RemotePosition[], selectedId: string | null) {
  const ordered = sortAndDedupe(positions);
  const latest = ordered.at(-1) ?? null;
  const selected = ordered.find((item) => item.event_id === selectedId) ?? latest;
  const segments = routeSegments(ordered);
  return { ordered, latest, selected, segments, gapCount: Math.max(0, segments.length - 1) };
}
