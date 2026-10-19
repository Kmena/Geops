#!/usr/bin/env node
import { lstat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUtc, readPoints, validatePoint } from './common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.private-gps-analysis');
const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const percentile = (a, p) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.ceil(a.length * p) - 1] : null;

export function distanceM(a, b) {
  const rad = Math.PI / 180,
    lat1 = a.latitude * rad,
    lat2 = b.latitude * rad;
  const dLat = (b.latitude - a.latitude) * rad,
    dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function classifyEdge(a, b, config) {
  const seconds = (parseUtc(b.captured_at) - parseUtc(a.captured_at)) / 1000;
  if (seconds <= 0)
    return { kind: 'uncertain', seconds, distance_m: 0, reason: 'same_capture_time' };
  const distance = distanceM(a, b);
  const lower = Math.max(0, distance - a.accuracy_m - b.accuracy_m);
  if (seconds > config.maxLinkSeconds)
    return { kind: 'uncertain', seconds, distance_m: distance, reason: 'long_gap' };
  if (lower / seconds > config.jumpSpeedMps)
    return { kind: 'jump', seconds, distance_m: distance, reason: 'implausible_displacement' };
  if (distance <= a.accuracy_m + b.accuracy_m)
    return { kind: 'stationary', seconds, distance_m: distance, reason: 'within_accuracy' };
  if (lower / seconds >= config.minMovingMps)
    return { kind: 'moving', seconds, distance_m: distance, lower_bound_m: lower };
  return { kind: 'uncertain', seconds, distance_m: distance, reason: 'below_movement_threshold' };
}

function stat(a) {
  return {
    average: round(avg(a)),
    median: round(percentile(a, 0.5)),
    p95: round(percentile(a, 0.95)),
    max: round(a.length ? a.reduce((m, n) => Math.max(m, n), -Infinity) : null),
  };
}
function timeStat(a) {
  return {
    average_seconds: round(avg(a)),
    median_seconds: round(percentile(a, 0.5)),
    p95_seconds: round(percentile(a, 0.95)),
    max_seconds: round(a.length ? a.reduce((m, n) => Math.max(m, n), -Infinity) : null),
  };
}

function summarize(points, config, id) {
  const ordered = [...points].sort(
    (a, b) =>
      parseUtc(a.captured_at) - parseUtc(b.captured_at) ||
      parseUtc(a.received_at) - parseUtc(b.received_at),
  );
  const gaps = [],
    captureGaps = [],
    edgeKinds = { stationary: 0, moving: 0, uncertain: 0, jump: 0 },
    segments = [];
  let centerline = 0,
    lowerBound = 0,
    withoutCapture = 0,
    current = null;
  for (let i = 1; i < ordered.length; i++) {
    const edge = classifyEdge(ordered[i - 1], ordered[i], config);
    gaps.push(edge.seconds);
    if (edge.seconds > config.targetSeconds + config.toleranceSeconds) {
      withoutCapture++;
      captureGaps.push({
        from_utc: ordered[i - 1].captured_at,
        to_utc: ordered[i].captured_at,
        seconds: edge.seconds,
      });
    }
    edgeKinds[edge.kind]++;
    if (edge.kind === 'moving') {
      centerline += edge.distance_m;
      lowerBound += edge.lower_bound_m;
    }
    if (current?.kind === edge.kind && current?.reason === (edge.reason ?? null)) {
      current.end_utc = ordered[i].captured_at;
      current.edges++;
    } else {
      current = {
        kind: edge.kind,
        reason: edge.reason ?? null,
        start_utc: ordered[i - 1].captured_at,
        end_utc: ordered[i].captured_at,
        edges: 1,
      };
      segments.push(current);
    }
  }
  const latencies = ordered.map((p) => (parseUtc(p.received_at) - parseUtc(p.captured_at)) / 1000);
  const receiveOrdered = [...ordered].sort(
    (a, b) => parseUtc(a.received_at) - parseUtc(b.received_at),
  );
  let outOfOrder = 0,
    ambiguousOrder = 0;
  for (let i = 1; i < receiveOrdered.length; i++) {
    const prev = receiveOrdered[i - 1],
      next = receiveOrdered[i];
    if (parseUtc(prev.received_at) === parseUtc(next.received_at)) ambiguousOrder++;
    else if (parseUtc(prev.captured_at) > parseUtc(next.captured_at)) outOfOrder++;
  }
  const exact = new Set();
  let coordinateDuplicates = 0;
  for (const p of ordered) {
    const key = `${p.captured_at}|${p.latitude}|${p.longitude}`;
    if (exact.has(key)) coordinateDuplicates++;
    exact.add(key);
  }
  return {
    id,
    device: ordered[0].device,
    boundary: 'inferred_from_capture_gap',
    start_utc: ordered[0].captured_at,
    end_utc: ordered.at(-1).captured_at,
    duration_observed_seconds:
      (parseUtc(ordered.at(-1).captured_at) - parseUtc(ordered[0].captured_at)) / 1000,
    positions: ordered.length,
    intervals: gaps.length,
    interval_seconds: timeStat(gaps),
    within_target_count: gaps.filter(
      (n) =>
        n >= config.targetSeconds - config.toleranceSeconds &&
        n <= config.targetSeconds + config.toleranceSeconds,
    ).length,
    within_target_percent: gaps.length
      ? round(
          (100 *
            gaps.filter(
              (n) =>
                n >= config.targetSeconds - config.toleranceSeconds &&
                n <= config.targetSeconds + config.toleranceSeconds,
            ).length) /
            gaps.length,
        )
      : null,
    accuracy_m: stat(ordered.map((p) => p.accuracy_m)),
    latency_seconds: timeStat(latencies.filter((n) => n >= 0)),
    negative_latency_clock_skew_count: latencies.filter((n) => n < 0).length,
    late_sync_count: latencies.filter((n) => n > config.lateSyncSeconds).length,
    exact_coordinate_time_duplicates: coordinateDuplicates,
    out_of_order_received_pairs: outOfOrder,
    ambiguous_received_order_pairs: ambiguousOrder,
    estimated_moving_centerline_m: round(centerline),
    estimated_moving_lower_bound_m: round(lowerBound),
    suspicious_gps_jumps: edgeKinds.jump,
    long_capture_gaps: gaps.filter((n) => n > config.maxLinkSeconds).length,
    intervals_beyond_target_tolerance: withoutCapture,
    edge_counts: edgeKinds,
    capture_gaps: captureGaps,
    segments,
  };
}

export function analyze(points, overrides = {}) {
  const config = {
    sessionGapSeconds: 600,
    targetSeconds: 60,
    toleranceSeconds: 15,
    lateSyncSeconds: 120,
    maxLinkSeconds: 180,
    minMovingMps: 0.5,
    jumpSpeedMps: 55,
    ...overrides,
  };
  if (
    Object.values(config).some((n) => !Number.isFinite(n) || n <= 0) ||
    config.maxLinkSeconds >= config.sessionGapSeconds
  )
    throw new Error('Invalid analysis thresholds');
  const byDevice = new Map();
  for (const point of points.map(validatePoint)) {
    if (!byDevice.has(point.device)) byDevice.set(point.device, []);
    byDevice.get(point.device).push(point);
  }
  const sessions = [];
  const allIntervals = [];
  for (const [device, rows] of byDevice) {
    rows.sort((a, b) => parseUtc(a.captured_at) - parseUtc(b.captured_at));
    let chunk = [],
      number = 0;
    for (const row of rows) {
      if (
        chunk.length &&
        (parseUtc(row.captured_at) - parseUtc(chunk.at(-1).captured_at)) / 1000 >
          config.sessionGapSeconds
      ) {
        sessions.push(summarize(chunk, config, `${device}_session_${++number}`));
        chunk = [];
      }
      chunk.push(row);
    }
    if (chunk.length) sessions.push(summarize(chunk, config, `${device}_session_${++number}`));
  }
  for (const session of sessions) {
    const rows = byDevice
      .get(session.device)
      .filter(
        (point) => point.captured_at >= session.start_utc && point.captured_at <= session.end_utc,
      );
    rows.sort((a, b) => parseUtc(a.captured_at) - parseUtc(b.captured_at));
    for (let i = 1; i < rows.length; i++)
      allIntervals.push((parseUtc(rows[i].captured_at) - parseUtc(rows[i - 1].captured_at)) / 1000);
  }
  const count = (key) => sessions.reduce((sum, session) => sum + session[key], 0);
  const intervalCount = count('intervals');
  const latencies = points
    .map((point) => (parseUtc(point.received_at) - parseUtc(point.captured_at)) / 1000)
    .filter((n) => n >= 0);
  return {
    status: 'analysis_of_persisted_points_only',
    generated_at_utc: new Date().toISOString(),
    config,
    aggregate: {
      devices: byDevice.size,
      sessions: sessions.length,
      positions: points.length,
      observed_duration_seconds: count('duration_observed_seconds'),
      interval_seconds: timeStat(allIntervals),
      accuracy_m: stat(points.map((p) => p.accuracy_m)),
      latency_seconds: timeStat(latencies),
      within_target_intervals: count('within_target_count'),
      total_within_session_intervals: intervalCount,
      within_target_percent: intervalCount
        ? round((100 * count('within_target_count')) / intervalCount)
        : null,
      late_sync_count: count('late_sync_count'),
      negative_latency_clock_skew_count: count('negative_latency_clock_skew_count'),
      intervals_beyond_target_tolerance: count('intervals_beyond_target_tolerance'),
      long_capture_gaps: count('long_capture_gaps'),
      suspicious_gps_jumps: count('suspicious_gps_jumps'),
      exact_coordinate_time_duplicates: count('exact_coordinate_time_duplicates'),
      out_of_order_received_pairs: count('out_of_order_received_pairs'),
      ambiguous_received_order_pairs: count('ambiguous_received_order_pairs'),
      edge_counts: {
        stationary: sessions.reduce((n, s) => n + s.edge_counts.stationary, 0),
        moving: sessions.reduce((n, s) => n + s.edge_counts.moving, 0),
        uncertain: sessions.reduce((n, s) => n + s.edge_counts.uncertain, 0),
        jump: sessions.reduce((n, s) => n + s.edge_counts.jump, 0),
      },
      estimated_moving_centerline_m: round(count('estimated_moving_centerline_m')),
      estimated_moving_lower_bound_m: round(count('estimated_moving_lower_bound_m')),
    },
    sessions,
    limitations: [
      'Session boundaries inferred; service start/stop events are not persisted.',
      'Missing points do not distinguish no GPS fix, stopped service, network loss, rejection, or purged data.',
      'Received time is first persisted receipt, not every retry or ACK.',
      'Event-ID duplicates cannot be counted because the database primary key deduplicates them.',
      'Same received_at timestamps do not establish ingestion order.',
      'Distance excludes jumps, stationary uncertainty and long gaps; it is not actual traveled distance.',
      'Original timestamp offset/lexical form is not stored by PostgreSQL timestamptz; UTC instants retain microsecond precision.',
    ],
  };
}

export function reportMarkdown(result) {
  const a = result.aggregate;
  return `# GEOPS — Informe de campo GPS\n\nEstado: análisis de puntos persistidos. Fecha: ${result.generated_at_utc}.\n\n## Resultado observado\n\n- Dispositivos: ${a.devices}; sesiones candidatas: ${a.sessions}; posiciones: ${a.positions}.\n- Intervalos dentro de ${result.config.targetSeconds} ± ${result.config.toleranceSeconds} s: ${a.within_target_intervals}/${a.total_within_session_intervals} (${a.within_target_percent ?? 'sin muestra'}%). Se excluyen pausas entre sesiones. Esto por sí solo no valida la meta de 60 s.\n- Sincronizaciones tardías (> ${result.config.lateSyncSeconds} s): ${a.late_sync_count}. Saltos GPS sospechosos: ${a.suspicious_gps_jumps}.\n- Distancia de bordes clasificados en movimiento: ${a.estimated_moving_centerline_m} m entre centros; cota inferior ajustada por precisión: ${a.estimated_moving_lower_bound_m} m. No equivale al trayecto real.\n\n## Sesiones\n\n${result.sessions.map((s) => `- ${s.id}: ${s.start_utc} a ${s.end_utc}; ${s.positions} posiciones; objetivo ${s.within_target_count}/${s.intervals} (${s.within_target_percent ?? 'sin muestra'}%); límite inferido.`).join('\n') || 'Sin posiciones disponibles.'}\n\n## Qué funcionó y qué falló\n\nCompletar con evidencia del dispositivo, API y operador. La presencia de posiciones demuestra persistencia para esos eventos; la ausencia no prueba fallos de captura.\n\n## Demostrado, inferido y faltante\n\nDemostrado: conteos y tiempos de filas persistidas en el rango consultado. Inferido: límites de sesión, clasificación de movimiento y distancia. Faltante: inicios/detenciones reales, eventos rechazados, reintentos, estado de red, batería, disponibilidad de GPS y datos ya purgados.\n\n## Riesgos al escalar de 1 a 25 dispositivos\n\nEvaluar caudal de ingesta, colas offline, límites de lotes, índices/retención, espacio y restauración de backups, observabilidad por dispositivo y acceso a ubicaciones. La PoC actual limita POC_MAX_DEVICES a 1: no existe evidencia de carga con 25.\n\n## Mejoras recomendadas\n\nPersistir eventos de inicio/detención y diagnósticos no geográficos con consentimiento; medir intentos de sincronización y pérdida de fixes; definir SLO con cobertura mínima por sesión; ensayar carga sintética y restauración antes de ampliar el límite.\n\n## Limitaciones y privacidad\n\n${result.limitations.map((x) => `- ${x}`).join('\n')}\n- Mantener CSV/JSON con coordenadas en el directorio privado; publicar solo resultados agregados aprobados.\n`;
}

export async function main(argv) {
  const inputIndex = argv.indexOf('--input');
  const gapIndex = argv.indexOf('--session-gap-min');
  const toleranceIndex = argv.indexOf('--tolerance-sec');
  if (inputIndex < 0 || !argv[inputIndex + 1])
    throw new Error(
      'Usage: node analysis/analyze.mjs --input PRIVATE/positions.json [--session-gap-min 10] [--tolerance-sec 15]',
    );
  const input = resolve(argv[inputIndex + 1]);
  if (!input.startsWith(root + sep))
    throw new Error('Input must be inside the private GEOPS analysis directory');
  const state = await lstat(input),
    parent = await lstat(dirname(input));
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077
  )
    throw new Error('Unsafe input path or permissions');
  const config = {};
  if (gapIndex >= 0) config.sessionGapSeconds = Number(argv[gapIndex + 1]) * 60;
  if (toleranceIndex >= 0) config.toleranceSeconds = Number(argv[toleranceIndex + 1]);
  const result = analyze(await readPoints(input), config);
  const dir = dirname(input);
  await writeFile(resolve(dir, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(resolve(dir, 'report.md'), reportMarkdown(result), { mode: 0o600, flag: 'wx' });
  process.stdout.write(
    `Analyzed ${result.aggregate.positions} positions in ${result.aggregate.sessions} candidate sessions. Private report: ${resolve(dir, 'report.md')}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Analysis failed; inspect private input and arguments.\n');
    process.exitCode = 1;
  });
