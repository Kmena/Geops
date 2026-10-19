import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const fields = [
  'device',
  'captured_at',
  'received_at',
  'latitude',
  'longitude',
  'accuracy_m',
];

export function parseUtc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  )
    throw new Error('Expected UTC ISO timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error('Invalid UTC timestamp');
  return ms;
}

export function csvCells(line) {
  const result = [];
  let value = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      result.push(value);
      value = '';
    } else value += c;
  }
  if (quoted) throw new Error('Invalid CSV quote');
  result.push(value);
  return result;
}

export function csvRow(values) {
  return values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',') + '\n';
}

export function validatePoint(row) {
  if (!row || Object.keys(row).sort().join(',') !== [...fields].sort().join(','))
    throw new Error('Unexpected point fields');
  if (!/^device_\d{3,}$/.test(row.device)) throw new Error('Invalid device label');
  parseUtc(row.captured_at);
  parseUtc(row.received_at);
  for (const key of ['latitude', 'longitude', 'accuracy_m'])
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key]))
      throw new Error('Invalid coordinate or accuracy');
  if (
    row.latitude < -90 ||
    row.latitude > 90 ||
    row.longitude < -180 ||
    row.longitude > 180 ||
    row.accuracy_m <= 0 ||
    row.accuracy_m > 10000
  )
    throw new Error('Point out of range');
  return row;
}

export async function readPoints(path) {
  const points = [];
  if (path.endsWith('.json')) {
    const { readFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Expected JSON array');
    return data.map(validatePoint);
  }
  if (!path.endsWith('.csv')) throw new Error('Expected .csv or .json');
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let header = false;
  for await (const line of lines) {
    if (!header) {
      if (csvCells(line).join(',') !== fields.join(',')) throw new Error('Unexpected CSV columns');
      header = true;
      continue;
    }
    if (!line) continue;
    const cells = csvCells(line);
    if (cells.length !== fields.length) throw new Error('Invalid CSV row');
    if (cells.some((cell) => cell === '')) throw new Error('Missing CSV value');
    points.push(
      validatePoint({
        device: cells[0],
        captured_at: cells[1],
        received_at: cells[2],
        latitude: Number(cells[3]),
        longitude: Number(cells[4]),
        accuracy_m: Number(cells[5]),
      }),
    );
  }
  if (!header) throw new Error('Empty CSV');
  return points;
}
