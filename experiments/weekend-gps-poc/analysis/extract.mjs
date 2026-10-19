#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvCells, csvRow, fields, parseUtc, validatePoint } from './common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = join(root, '.private-gps-analysis');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--from', '--to', '--device'].includes(argv[i]) || !argv[i + 1] || out[argv[i]])
      throw new Error('Usage: node analysis/extract.mjs --from UTC --to UTC [--device UUID]');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (
    !out.from ||
    !out.to ||
    parseUtc(out.from) >= parseUtc(out.to) ||
    (out.device && !uuid.test(out.device))
  )
    throw new Error('Invalid UTC range or device UUID');
  if (Date.now() < parseUtc(out.to)) throw new Error('End of range must be in the past');
  return out;
}

async function psql(sql, maxBytes = 1024 * 1024) {
  const args = [
    '--project-name',
    'geops-weekend-poc',
    '--env-file',
    'infra/.env.local',
    '-f',
    'infra/compose.cloud.yaml',
    'exec',
    '-T',
    'poc-db',
    'psql',
    '-X',
    '-q',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'poc_user',
    '-d',
    'geops_poc',
    '-f',
    '-',
  ];
  const child = spawn('docker', ['compose', ...args], {
    cwd: root,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 360_000,
  });
  child.stdin.on('error', () => {});
  child.stdin.end(sql + '\n');
  let chunks = [],
    bytes = 0,
    overflow = false;
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      overflow = true;
      child.kill();
    } else chunks.push(chunk);
  });
  // Deliberately discard stderr: Compose/psql diagnostics can contain connection details.
  child.stderr.resume();
  const code = await new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', ok);
  });
  if (overflow) throw new Error('Extraction exceeded 100 MiB safety limit');
  if (code !== 0)
    throw new Error(
      'GEOPS PoC read-only query failed; check Compose service and local env file privately',
    );
  return Buffer.concat(chunks).toString('utf8');
}

async function checkSchema() {
  const sql =
    "BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SELECT current_database(); SELECT table_name || ',' || column_name || ',' || udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('poc_location','poc_device') ORDER BY table_name,column_name; COMMIT;";
  const rows = (await psql(sql)).trim().split(/\r?\n/);
  if (rows.shift() !== 'geops_poc') throw new Error('Unexpected database');
  const found = new Set(rows);
  for (const item of [
    'poc_device,id,uuid',
    'poc_device,environment_id,text',
    'poc_location,device_id,uuid',
    'poc_location,event_id,uuid',
    'poc_location,captured_at,timestamptz',
    'poc_location,received_at,timestamptz',
    'poc_location,geom,geography',
    'poc_location,accuracy_m,float8',
  ])
    if (!found.has(item)) throw new Error('GEOPS PoC schema mismatch');
}

async function privateDirectory() {
  try {
    const state = await lstat(privateRoot);
    if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077)
      throw new Error('Private output directory has unsafe permissions');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(privateRoot, { mode: 0o700 });
  }
  await chmod(privateRoot, 0o700);
  return mkdtemp(join(privateRoot, 'run-'));
}

export async function extract(argv) {
  process.umask(0o077);
  const { from, to, device } = options(argv);
  const envPath = join(root, 'infra', '.env.local');
  const envState = await lstat(envPath);
  if (!envState.isFile() || envState.isSymbolicLink() || envState.mode & 0o077)
    throw new Error('infra/.env.local must be a private regular file');
  // Compose reads its existing configuration. Neither credentials nor Compose config are printed.
  await checkSchema();
  const where =
    `l.captured_at >= '${from}'::timestamptz AND l.captured_at < '${to}'::timestamptz` +
    (device ? ` AND l.device_id = '${device}'::uuid` : '');
  const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout = '300s'; COPY (SELECT l.device_id, to_char(l.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), to_char(l.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), ST_Y(l.geom::geometry), ST_X(l.geom::geometry), l.accuracy_m FROM public.poc_location l JOIN public.poc_device d ON d.id=l.device_id WHERE d.environment_id='weekend-gps-poc-v1' AND ${where} ORDER BY l.device_id,l.captured_at,l.event_id) TO STDOUT WITH (FORMAT csv, HEADER false); COMMIT;`;
  const output = (await psql(sql, 100 * 1024 * 1024)).trim();
  const devices = new Map(),
    points = [];
  for (const line of output ? output.split(/\r?\n/) : []) {
    const cells = csvCells(line);
    if (cells.length !== 6 || !uuid.test(cells[0])) throw new Error('Unexpected database row');
    if (!devices.has(cells[0]))
      devices.set(cells[0], `device_${String(devices.size + 1).padStart(3, '0')}`);
    const point = validatePoint({
      device: devices.get(cells[0]),
      captured_at: cells[1],
      received_at: cells[2],
      latitude: Number(cells[3]),
      longitude: Number(cells[4]),
      accuracy_m: Number(cells[5]),
    });
    if (parseUtc(point.captured_at) < parseUtc(from) || parseUtc(point.captured_at) >= parseUtc(to))
      throw new Error('Row outside requested range');
    points.push(point);
  }
  const dir = await privateDirectory();
  const csv =
    fields.join(',') +
    '\n' +
    points.map((point) => csvRow(fields.map((field) => point[field]))).join('');
  await writeFile(join(dir, 'positions.csv'), csv, { mode: 0o600, flag: 'wx' });
  await writeFile(join(dir, 'positions.json'), JSON.stringify(points, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        from_utc: from,
        to_utc_exclusive: to,
        device_count: devices.size,
        position_count: points.length,
        extracted_at_utc: new Date().toISOString(),
        source: 'geops-weekend-poc/public.poc_location',
        schema_validated: true,
        identifiers: 'run-local pseudonyms; no credential fields',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    `Extracted ${points.length} positions from ${devices.size} device(s) into ${dir}\n`,
  );
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  extract(process.argv.slice(2)).catch(() => {
    process.stderr.write('Extraction failed. No database records were changed.\n');
    process.exitCode = 1;
  });
}
