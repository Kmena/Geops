import type { RemoteGpsDevice, RemoteGpsSession, RemotePosition } from './remote.js';

export type TimePreset = 'now' | 'today' | 'hour' | 'sixHours' | 'day' | 'yesterday' | 'custom';
export interface Period {
  from: string;
  to: string;
}
export const MAX_PERIOD_MS = 86_400_000;
export const GAP_MS = 5 * 60_000;
export const LOW_ACCURACY_M = 100;

export function deviceNames(devices: RemoteGpsDevice[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const name = device.display_label?.trim() || 'Dispositivo sin nombre';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const needsId = devices.filter((device) => {
    const label = device.display_label?.trim();
    return !label || (counts.get(label) ?? 0) > 1;
  });
  const suffix = (id: string) => {
    const compact = id.replaceAll('-', '');
    let length = 6;
    while (
      length < compact.length &&
      needsId.some(
        (other) =>
          other.device_id !== id &&
          other.device_id.replaceAll('-', '').endsWith(compact.slice(-length)),
      )
    )
      length += 2;
    return compact.slice(-length);
  };
  return new Map(
    devices.map((device) => {
      const label = device.display_label?.trim();
      const name = label || 'Dispositivo sin nombre';
      return [
        device.device_id,
        !label || (counts.get(name) ?? 0) > 1 ? `${name} · ${suffix(device.device_id)}` : name,
      ];
    }),
  );
}

export function effectiveSession(
  current: string,
  sessions: RemoteGpsSession[],
  deviceChanged: boolean,
): string {
  return deviceChanged || !sessions.some((item) => item.session_id === current) ? '' : current;
}

function parts(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const field = (name: string) => Number(values.find((part) => part.type === name)?.value);
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
  };
}

export function zonedDateTime(value: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Fecha y hora inválidas.');
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]),
    hour = Number(match[4]),
    minute = Number(match[5]);
  let timestamp = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = parts(new Date(timestamp), timeZone);
    const rendered = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    timestamp += Date.UTC(year, month - 1, day, hour, minute) - rendered;
  }
  const final = parts(new Date(timestamp), timeZone);
  if (
    [final.year, final.month, final.day, final.hour, final.minute].join('-') !==
    [year, month, day, hour, minute].join('-')
  )
    throw new Error('Esta hora no existe en la zona seleccionada.');
  return new Date(timestamp);
}

export function localInputValue(date: Date, timeZone: string): string {
  const local = parts(date, timeZone);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}T${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
}

export function presetPeriod(
  preset: Exclude<TimePreset, 'custom'>,
  timeZone: string,
  now = new Date(),
): Period {
  const end = new Date(now.getTime() + 1);
  if (preset === 'now')
    return { from: new Date(now.getTime() - 15 * 60_000).toISOString(), to: end.toISOString() };
  if (preset === 'hour')
    return { from: new Date(now.getTime() - 60 * 60_000).toISOString(), to: end.toISOString() };
  if (preset === 'sixHours')
    return { from: new Date(now.getTime() - 6 * 60 * 60_000).toISOString(), to: end.toISOString() };
  if (preset === 'day')
    return {
      from: new Date(now.getTime() - MAX_PERIOD_MS + 1).toISOString(),
      to: end.toISOString(),
    };
  const today = localInputValue(now, timeZone).slice(0, 10);
  const todayStart = zonedDateTime(`${today}T00:00`, timeZone);
  if (preset === 'today') return { from: todayStart.toISOString(), to: end.toISOString() };
  const previous = new Date(`${today}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const yesterday = previous.toISOString().slice(0, 10);
  return {
    from: zonedDateTime(`${yesterday}T00:00`, timeZone).toISOString(),
    to: todayStart.toISOString(),
  };
}

export function validatePeriod(period: Period): string | null {
  const from = Date.parse(period.from),
    to = Date.parse(period.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    return 'El inicio debe ser anterior al fin.';
  if (to - from > MAX_PERIOD_MS)
    return 'El período máximo por consulta es de 24 horas. Acorta el rango.';
  return null;
}

export function sortAndDedupe(positions: RemotePosition[]): RemotePosition[] {
  return [...new Map(positions.map((item) => [item.event_id, item])).values()].sort(
    (a, b) =>
      Date.parse(a.captured_at) - Date.parse(b.captured_at) || a.event_id.localeCompare(b.event_id),
  );
}

export function routeSegments(positions: RemotePosition[]): RemotePosition[][] {
  const ordered = sortAndDedupe(positions);
  const segments: RemotePosition[][] = [];
  for (const item of ordered) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    if (
      !segment ||
      (previous &&
        (item.session_id !== previous.session_id ||
          Date.parse(item.captured_at) - Date.parse(previous.captured_at) > GAP_MS))
    )
      segments.push([item]);
    else segment.push(item);
  }
  return segments;
}
