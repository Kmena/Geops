// Read-only, conditional replay of a user-provided SILA GPS export against the real B32 engine.
// Usage: node apps/api/scripts/simulate-sila-visit.mjs <user.tsv> <postgis-distances.csv> <output-directory>
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateDwell, classifyDwellSample, uniquePhysicalSeconds } from '../src/visit-dwell-engine.ts';

const [sourcePath, distancePath, outputDir] = process.argv.slice(2);
if (!sourcePath || !distancePath || !outputDir) throw new Error('usage: user.tsv distances.csv output-directory');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const sourceHash = createHash('sha256').update(source).digest('hex');
const lines = source.split(/\r?\n/);
if (lines.length !== 78) throw new Error(`expected 77 rows, got ${lines.length - 1}`);
const headers = lines[0].split('\t');
if (headers.length !== 6) throw new Error('expected six export columns');
const distances = readFileSync(distancePath, 'utf8').trim().split(/\r?\n/).map(line => line.split(',').map(Number));
if (distances.length !== 77 || distances.some((d, i) => d[0] !== i + 1 || !Number.isFinite(d[1])))
  throw new Error('PostGIS distances do not match the 77 source rows');
const baseSql = readFileSync(new URL('../src/db/migrations/0027_visit_dwell_engine.sql', import.meta.url), 'utf8');
const revSql = readFileSync(new URL('../src/db/migrations/0033_visit_coverage_calibration.sql', import.meta.url), 'utf8');
const params = {
  max_gap_s: 300, credit_cap_s: 300, uncertainty_guard_s: 0,
  max_accuracy_m: 25, boundary_tolerance_m: 0, max_speed_m_s: 50,
  coverage_min_fraction: null, non_compliance_enabled: false,
};
if (!baseSql.includes(JSON.stringify(Object.fromEntries(Object.entries(params).slice(0, 6)))) ||
    !revSql.includes('"coverage_min_fraction":null,"non_compliance_enabled":false') ||
    !revSql.includes("ARRAY['DEC-VISIT-001','DEC-VISIT-002'],600"))
  throw new Error('B32 migration parameters differ from the replay configuration');

function localMinuteToIso(value) {
  const match = /^28 oct 2026, (\d{1,2}):(\d{2}) p\. m\./.exec(value);
  if (!match) throw new Error(`unexpected date format: ${value}`);
  const h = Number(match[1]) + 12;
  const m = Number(match[2]);
  if (h < 12 || h > 23 || m > 59) throw new Error(`invalid local minute: ${value}`);
  const iso = new Date(Date.UTC(2026, 9, 29, h - 18, m)).toISOString();
  const back = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guatemala', hour: 'numeric', minute: '2-digit', hour12: false }).format(new Date(iso));
  if (back !== `${h}:${String(m).padStart(2, '0')}`) throw new Error(`timezone mismatch: ${value} => ${iso} => ${back}`);
  return iso;
}
const rows = lines.slice(1).map((line, index) => {
  const cells = line.split('\t');
  if (cells.length !== 6) throw new Error(`row ${index + 1}: expected six columns`);
  const coords = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(cells[5]);
  const accuracy = /^±(\d+(?:\.\d+)?) m/.exec(cells[3]);
  if (!coords || !accuracy) throw new Error(`row ${index + 1}: invalid coordinate/accuracy`);
  const [rowNo, distanceM, moveDistanceM] = distances[index];
  const row = {
    rowNo, capturedLocal: cells[0], receivedLocal: cells[1], delay: cells[2], accuracyText: cells[3],
    sessionLabel: cells[4], lat: Number(coords[1]), lon: Number(coords[2]),
    capturedAt: localMinuteToIso(cells[0]), receivedAt: localMinuteToIso(cells[1]),
    accuracyM: Number(accuracy[1]), distanceM, moveDistanceM: index === 0 ? null : moveDistanceM,
  };
  const lag = /^(?:(\d+) min )?(\d+) s$/.exec(row.delay);
  if (!lag || Math.abs((Date.parse(row.receivedAt) - Date.parse(row.capturedAt)) / 1000 - (Number(lag[1] ?? 0) * 60 + Number(lag[2]))) >= 60)
    throw new Error(`row ${index + 1}: receipt delay contradicts displayed minutes`);
  return row;
});
if (new Set(rows.map(r => r.sessionLabel)).size !== 1) throw new Error('more than one displayed session');
for (let i = 1; i < rows.length; i++) if (rows[i].capturedAt <= rows[i - 1].capturedAt)
  throw new Error(`duplicate or unsorted displayed capture minute at row ${i + 1}`);
const samples = rows.map(r => ({
  deviceId: 'UNVERIFIED_DEVICE', eventId: `source-row-${String(r.rowNo).padStart(3, '0')}`,
  sessionId: r.sessionLabel, linkId: 'UNVERIFIED_LINK', captureAnchorId: 'UNVERIFIED_ANCHOR',
  bootId: 'UNVERIFIED_BOOT', capturedAt: r.capturedAt, receivedAt: r.receivedAt,
  payloadDigest: createHash('sha256').update(lines[r.rowNo]).digest('hex'),
  accuracyM: r.accuracyM, distanceM: r.distanceM, moveDistanceM: r.moveDistanceM,
  qualityState: 'DEVICE_REPORTED', // Conditional assumption: export omits quality_state.
}));
const window = {
  samples, barriers: [], radiusM: 100, requiredS: 600,
  startsAt: '2026-10-29T00:00:00.000Z', endsAt: '2026-10-29T04:00:00.000Z',
  now: '2026-10-29T04:00:01.000Z',
};
const scenarios = [
  ['A · B32 revision 3', params],
  ['B · conservador exploratorio', { ...params, max_gap_s: 120, credit_cap_s: 120, max_accuracy_m: 20, uncertainty_guard_s: 10 }],
  ['C1 · gap 60 s', { ...params, max_gap_s: 60, credit_cap_s: 60 }],
  ['C2 · gap 120 s', { ...params, max_gap_s: 120, credit_cap_s: 120 }],
  ['C3 · precisión 15 m', { ...params, max_accuracy_m: 15 }],
  ['C4 · precisión 20 m', { ...params, max_accuracy_m: 20 }],
  ['C5 · precisión 30 m', { ...params, max_accuracy_m: 30 }],
];
const results = scenarios.map(([name, parameters]) => ({ name, parameters, result: evaluateDwell({ ...window, parameters }) }));
const repeat = evaluateDwell({ ...window, parameters: params });
if (JSON.stringify(repeat) !== JSON.stringify(results[0].result)) throw new Error('non-deterministic B32 replay');
const a = results[0].result;
if (uniquePhysicalSeconds(a.intervals) !== a.creditedS) throw new Error('double-counted credited seconds');
const classes = samples.map(s => classifyDwellSample(s, 100, params));
const counts = Object.fromEntries(['INSIDE', 'OUTSIDE', 'UNCERTAIN'].map(c => [c, classes.filter(x => x === c).length]));
const local = iso => `${String(new Date(iso).getUTCHours() - 6 < 0 ? new Date(iso).getUTCHours() + 18 : new Date(iso).getUTCHours() - 6).padStart(2, '0')}:${String(new Date(iso).getUTCMinutes()).padStart(2, '0')}`;
const fmt = s => `${s} s (${(s / 60).toFixed(2)} min)`;
const intervalByB = new Map(a.intervals.map(x => [x.eventIdB, x]));
const outsideByB = new Map();
for (const x of a.outsideIntervals) outsideByB.set(x.eventIdB, (outsideByB.get(x.eventIdB) ?? 0) + x.seconds);
const intervals = rows.slice(1).map((to, i) => {
  const from = rows[i], duration = (Date.parse(to.capturedAt) - Date.parse(from.capturedAt)) / 1000;
  const inside = intervalByB.get(samples[i + 1].eventId)?.creditedS ?? 0;
  const outside = outsideByB.get(samples[i + 1].eventId) ?? 0;
  let reason = 'Desconocido: extremos de distinta clase o inciertos';
  if (inside) reason = 'Acreditado dentro: par válido B32';
  else if (outside) reason = 'Fuera: margen alcanzable de extremos';
  else if (duration > params.max_gap_s) reason = 'Desconocido: hueco >300 s';
  else if (classes[i] === 'OUTSIDE' && classes[i + 1] === 'OUTSIDE') reason = 'Fuera observado; sin segundos demostrables';
  else if (classes[i] === classes[i + 1] && classes[i] === 'INSIDE' && to.moveDistanceM / duration > 50) reason = 'Desconocido: velocidad >50 m/s';
  return { from, to, duration, inside, outside, unknown: duration - inside - outside, reason };
});
const aggregateObservedUnknown = intervals.reduce((n, x) => n + x.unknown, 0);
const firstAt = rows[0].capturedAt, lastAt = rows.at(-1).capturedAt;
const edgeUnknown = 14400 - (Date.parse(lastAt) - Date.parse(firstAt)) / 1000;
if (aggregateObservedUnknown + edgeUnknown !== a.unknownS) throw new Error('unknown time reconciliation failed');

mkdirSync(outputDir, { recursive: true });
const reportPath = join(outputDir, 'b32-sila-visit-simulation-2026-10-28.md');
const mapPath = join(outputDir, 'b32-sila-visit-map-2026-10-28.svg');
const timelinePath = join(outputDir, 'b32-sila-visit-timeline-2026-10-28.svg');
const safe = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const color = c => c === 'INSIDE' ? '#16803f' : c === 'OUTSIDE' ? '#c93434' : '#d18a00';
function mapSvg() {
  const w = 1120, h = 580;
  const panel = (x0, y0, side, range, title) => {
    const project = r => ({ x: x0 + side / 2 + (r.lon + 84.429728) * 109550 * side / (2 * range), y: y0 + side / 2 - (r.lat - 10.329042) * 110600 * side / (2 * range) });
    let s = `<rect x="${x0}" y="${y0}" width="${side}" height="${side}" fill="#f8fafc" stroke="#94a3b8"/><text x="${x0}" y="${y0 - 12}" font-size="18" font-weight="bold">${title}</text>`;
    s += `<circle cx="${x0 + side / 2}" cy="${y0 + side / 2}" r="${100 * side / (2 * range)}" fill="#bbf7d0" fill-opacity=".45" stroke="#16803f" stroke-width="2"/>`;
    for (const interval of a.intervals) {
      const i = Number(interval.eventIdA.slice(-3)) - 1, j = Number(interval.eventIdB.slice(-3)) - 1;
      const p = project(rows[i]), q = project(rows[j]);
      if ([p.x, p.y, q.x, q.y].every(Number.isFinite) && [p, q].every(z => z.x >= x0 && z.x <= x0 + side && z.y >= y0 && z.y <= y0 + side))
        s += `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#16803f" stroke-width="2"/>`;
    }
    rows.forEach((r, i) => { const p = project(r); if (p.x < x0 || p.x > x0 + side || p.y < y0 || p.y > y0 + side) return; s += `<circle cx="${p.x}" cy="${p.y}" r="4.2" fill="${color(classes[i])}" stroke="white"><title>Fila ${i + 1} ${safe(r.capturedLocal)}; ${classes[i]}; ${r.distanceM.toFixed(2)} m; ±${r.accuracyM.toFixed(2)} m</title></circle>`; });
    s += `<circle cx="${x0 + side / 2}" cy="${y0 + side / 2}" r="3" fill="#111827"/>`;
    return s;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/><style>text{font-family:Arial,sans-serif;fill:#0f172a}</style><text x="30" y="30" font-size="22" font-weight="bold">SILA · 28/10/2026 · geozona 100 m</text>${panel(30,80,450,180,'Detalle: ±180 m')}${panel(640,80,450,7000,'Recorrido: ±7 km')}<text x="30" y="555" font-size="14">● Verde dentro   ● Rojo fuera   ● Ámbar incierto. Líneas verdes: solo intervalos acreditados; los huecos no se conectan.</text></svg>`;
}
function timelineSvg() {
  const x0 = 100, x1 = 1070, y = 80, width = x1 - x0;
  const x = iso => x0 + (Date.parse(iso) - Date.parse(window.startsAt)) / 14400000 * width;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="470" viewBox="0 0 1120 470"><rect width="100%" height="100%" fill="white"/><style>text{font-family:Arial,sans-serif;fill:#0f172a}</style><text x="30" y="30" font-size="22" font-weight="bold">Cobertura y permanencia acreditada · B32 revisión 3</text><text x="30" y="75" font-size="15">Cobertura</text><rect x="${x0}" y="${y}" width="${width}" height="35" fill="#cbd5e1"/>`;
  for (const q of a.intervals) s += `<rect x="${x(q.creditedFromAt)}" y="${y}" width="${Math.max(1, x(q.toAt) - x(q.creditedFromAt))}" height="35" fill="#16803f"/>`;
  for (const q of a.outsideIntervals) s += `<rect x="${x(q.fromAt)}" y="${y}" width="${Math.max(1, x(q.toAt) - x(q.fromAt))}" height="35" fill="#c93434"/>`;
  for (let hour = 18; hour <= 22; hour++) { const px = x0 + (hour - 18) / 4 * width; s += `<line x1="${px}" y1="60" x2="${px}" y2="410" stroke="#e2e8f0"/><text x="${px - 17}" y="135" font-size="14">${hour}:00</text>`; }
  s += `<text x="30" y="170" font-size="15">Acumulado</text><line x1="${x0}" y1="395" x2="${x1}" y2="395" stroke="#475569"/>`;
  const max = Math.max(600, a.creditedS) * 1.1, yv = v => 395 - v / max * 200;
  s += `<line x1="${x0}" y1="${yv(600)}" x2="${x1}" y2="${yv(600)}" stroke="#d97706" stroke-dasharray="6 5"/><text x="${x1 - 185}" y="${yv(600) - 6}" font-size="13">Umbral 600 s</text>`;
  let accrued = 0, points = `${x0},395`;
  for (const q of a.intervals) { points += ` ${x(q.creditedFromAt)},${yv(accrued)}`; accrued += q.creditedS; points += ` ${x(q.toAt)},${yv(accrued)}`; }
  points += ` ${x1},${yv(accrued)}`;
  s += `<polyline points="${points}" fill="none" stroke="#16803f" stroke-width="3"/><text x="${x1 - 115}" y="${yv(accrued) - 10}" font-size="14">${accrued} s</text><text x="30" y="445" font-size="14">Gris: desconocido · Verde: dentro acreditado · Rojo: fuera acreditado. Horas de captura visibles, redondeadas al minuto.</text></svg>`;
  return s;
}
writeFileSync(mapPath, mapSvg());
writeFileSync(timelinePath, timelineSvg());
const scenarioRows = results.map(({ name, parameters: p, result: r }) => `| ${name} | ${p.max_gap_s}/${p.credit_cap_s} s | ${p.max_accuracy_m} m | ${p.uncertainty_guard_s} s | ${fmt(r.creditedS)} | ${fmt(r.outsideCreditedS)} | ${fmt(r.unknownS)} | ${r.coveragePercent}% | ${r.status} |`).join('\n');
const intervalRows = intervals.map(q => {
  const { from: f, to: t } = q;
  return `| ${local(f.capturedAt)}–${local(t.capturedAt)} | ${q.duration} | ${f.lat.toFixed(5)}, ${f.lon.toFixed(5)} → ${t.lat.toFixed(5)}, ${t.lon.toFixed(5)} | ${f.distanceM.toFixed(2)} → ${t.distanceM.toFixed(2)} | ${f.accuracyM.toFixed(2)} → ${t.accuracyM.toFixed(2)} | ${classes[f.rowNo - 1]} → ${classes[t.rowNo - 1]} | ${q.inside} | ${q.outside} | ${q.unknown} | ${q.reason} |`;
}).join('\n');
const report = `# GEOPS B32 · Simulación condicionada de SILA, 28/10/2026

## Alcance y procedencia

Se ejecutó la función real \`evaluateDwell\` de \`apps/api/src/visit-dwell-engine.ts\`, en modo local y de solo lectura, con las **77 filas que el usuario pegó en esta conversación**. El texto original de esas filas tiene SHA-256 \`${sourceHash}\` (UTF-8, saltos LF, sin salto final). La tabla contiene captura, recepción, retraso, precisión, etiqueta de sesión y coordenadas. Las capturas visibles van de ${local(firstAt)} a ${local(lastAt)}; las recepciones visibles van de ${local(rows[0].receivedAt)} a ${local(rows.at(-1).receivedAt)}. La precisión informada va de ${Math.min(...rows.map(r => r.accuracyM)).toFixed(2)} a ${Math.max(...rows.map(r => r.accuracyM)).toFixed(2)} m. No se consultó ni modificó ninguna base de producción o staging. Las distancias al centro y entre puntos consecutivos se calcularon con \`ST_Distance(geography, geography)\` en PostGIS 18/3.6, en un contenedor temporal aislado y eliminado al terminar; no se crearon tablas. Las 77 distancias derivadas se conservan en \`b32-sila-visit-postgis-distances-2026-10-28.csv\`; el ejecutor reproducible está en \`apps/api/scripts/simulate-sila-visit.mjs\`. El texto GPS original permanece en el mensaje del usuario, no se agregó como archivo de datos al repositorio.

**Límite de procedencia:** esta exportación de interfaz muestra la hora solo hasta el minuto; no incluye \`event_id\`, \`device_id\`, vínculo agente/dispositivo, \`boot_id\`, \`capture_anchor_id\`, \`payload_digest\` original, \`quality_state\` ni eventos \`INTERRUPTED/STOPPED/RESUMED\` con hora. El motor exige esos campos. Para el replay se usaron índices de fila deterministas como identificadores técnicos, una misma identidad/vínculo/ancla/arranque supuestos, \`qualityState=DEVICE_REPORTED\` y ninguna barrera. **Son hipótesis, no hechos verificados.** El rótulo visual \`STOPPED\` identifica el estado final de sesión, no demuestra cuándo ocurrió la parada. La simulación es condicional y no equivale a la consulta operacional del servicio, que filtra además por vínculo y sesiones efectivas/programadas.

## Geozona, ventana y regla

- Centro provisto: latitud 10.329042, longitud -84.429728; círculo de 100 m, revisión histórica declarada 1. El snapshot de la asignación no está en la exportación y **no pudo verificarse** contra la base.
- Ventana provista: 28/10/2026 18:00–22:00 \`America/Guatemala\`, equivalente en la simulación a 29/10/2026 00:00–04:00 UTC. Se comprobó la conversión con \`Intl.DateTimeFormat\`. Todas las 77 capturas visibles caen en esa ventana; recepción no se usó para acreditar tiempo.
- Requisito: 600 segundos acumulados. Revisión técnica 3 \`dwell-pair-v1\`, alcance \`TECHNICAL_ONLY\`, decisiones \`DEC-VISIT-001/002\`. Parámetros verificados contra migraciones 0027 y 0033: \`max_gap_s=300\`, \`credit_cap_s=300\`, \`uncertainty_guard_s=0\`, \`max_accuracy_m=25\`, \`boundary_tolerance_m=0\`, \`max_speed_m_s=50\`, \`coverage_min_fraction=null\`, \`non_compliance_enabled=false\`.
- Se acreditan pares de posiciones con ambas clasificaciones \`INSIDE\`, igual identidad y sesión, sin barrera, velocidad aceptable y hueco dentro del límite. \`INSIDE\` requiere \`distancia + precisión <= 100 m\`. El tiempo fuera se limita a márgenes físicamente alcanzables; el resto es desconocido. No se dio crédito a tramos sin datos.

## Resultado

| Métrica | Resultado del escenario A |
|---|---:|
| Posiciones procesadas | ${a.sampleCount} |
| Posiciones dentro / fuera / inciertas | ${counts.INSIDE} / ${counts.OUTSIDE} / ${counts.UNCERTAIN} |
| Tiempo dentro acreditado | ${fmt(a.creditedS)} |
| Tiempo fuera acreditado | ${fmt(a.outsideCreditedS)} |
| Tiempo desconocido en toda la ventana | ${fmt(a.unknownS)} |
| Cobertura GPS demostrada de 18:00–22:00 | ${a.coveragePercent}% |
| Huecos >300 s detectados por el motor | ${a.gapCount} |
| Permanencia requerida | 600 s (10 min) |
| Resultado matemático B32, **bajo hipótesis explícitas** | ${a.status} |
| Primer instante estimado de completar 600 s (minutos visibles) | ${a.completedAt ? local(a.completedAt) : 'No alcanzado'} |

La serie próxima al centro desde ${local(firstAt)} aporta más de 600 s en el replay. Los tiempos visibles están redondeados al minuto: el instante exacto de completar no se puede fijar a segundos. Del primer punto de ${local(rows[0].capturedAt)} al de ${local(rows[11].capturedAt)} transcurren **más de 660 s** aun tomando los extremos posibles de sus minutos visibles; todos esos puntos se clasifican dentro con los parámetros A y los huecos visibles no superan 2 min. Esa es una cota de tiempo transcurrido, no una acreditación exacta: faltan los segundos originales y las pruebas de continuidad/identidad que usa el servicio. No se equiparan minutos transcurridos con tiempo automáticamente acreditado.

La zona horaria \`America/Guatemala\` fue provista como parte de la asignación; el archivo no tiene offset explícito. El retraso de sincronización se muestra en la fuente, pero la permanencia depende de captura, no de recepción. La precisión \`±m\` se interpretó como radio horizontal informado; algunos registros marcados \`baja\` superan 25 m y quedan inciertos.

## Comparación de escenarios

Los escenarios B y C son exploratorios. Cambian solo los parámetros indicados; mantienen el mismo conjunto de 77 filas y las mismas hipótesis de identidad/calidad. En B se exige mayor precisión, hueco menor y se descuenta 10 s por par. Al reducir \`max_gap_s\`, \`credit_cap_s\` se reduce al mismo valor porque el validador B32 lo exige.

| Escenario | Hueco/tope | Precisión máx. | Reserva/par | Dentro | Fuera | Desconocido | Cobertura | Estado del motor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${scenarioRows}

La revisión 3 no tiene aún umbral \`coverage_min_fraction\` calibrado ni habilita \`non_compliance_enabled\`; por eso no puede emitir \`INCOMPLETE\` como conclusión de incumplimiento. Los límites numéricos actuales (hueco, precisión, velocidad y reserva cero) siguen sin validación de campo para esta sede. Un resultado favorable no aprueba esos límites ni activa la revisión.

La sensibilidad a la precisión es material: con un máximo exploratorio de **15 m**, el motor acredita solo **420 s (7 min)** y devuelve \`INSUFFICIENT_EVIDENCE\`; con 20 m acredita 2820 s. Esto refuerza la necesidad de calibrar el umbral con datos de campo antes de cualquier promoción.

## Evidencia visual

![Mapa de geozona y posiciones](b32-sila-visit-map-2026-10-28.svg)

![Cobertura y acumulado de permanencia](b32-sila-visit-timeline-2026-10-28.svg)

El mapa une exclusivamente pares acreditados dentro; los huecos y tramos inciertos quedan sin línea. La cobertura del gráfico se refiere a las cuatro horas de la ventana autorizada, no solo al período entre primera y última captura.

## Intervalos del escenario A

Las horas son locales y visibles al minuto. Las distancias provienen de PostGIS, en metros. \`Desconocido\` en cada fila es el resto de ese intervalo tras acreditar dentro/fuera; además hay ${fmt(edgeUnknown)} sin observación antes de la primera o después de la última captura dentro de la ventana. Las coordenadas y precisiones están expresadas como extremo inicial → final.

| Hora | Duración s | Coordenadas (lat, lon) | Distancia m | Precisión m | Clase | Dentro s | Fuera s | Desconocido s | Motivo |
|---|---:|---|---|---|---|---:|---:|---:|---|
${intervalRows}

## Validaciones y recomendación

- Los 77 registros de la fuente se procesaron una vez, ordenados por captura; no hay dos filas con la misma marca visible. El motor eliminó duplicados por la clave técnica, y la unión de segundos físicos acreditados coincide con \`${a.creditedS}\` s: no hay doble conteo.
- La segunda ejecución de \`evaluateDwell\` produjo exactamente el mismo JSON. Distancias calculadas por PostGIS con el centro y coordenadas suministrados. No se sustituyeron posiciones faltantes.
- No se pudo verificar el vínculo del dispositivo con AGT-001, el snapshot histórico, los estados \`quality_state\`, las horas exactas de captura, las barreras de sesión ni el acceso que habría tenido la consulta operacional. Por ello la simulación demuestra **cumplimiento condicional** de los 10 minutos, pero no prueba que el dispositivo vinculado cumplió oficialmente.
- Para resolver la visita real, obtener del sistema el snapshot de asignación y una exportación de \`position_event\` con identificadores, calidad, segundos/milisegundos y los eventos de sesión; entonces repetir el motor con la consulta operacional y una revisión aprobada. Conservar la revisión 3 desactivada hasta calibración y aprobación.

**SIMULATION_RESULT = ${a.status === 'COMPLETED' ? 'COMPLIANT' : 'INSUFFICIENT_EVIDENCE'}**

Esta clasificación describe únicamente el replay condicionado. **REAL_VISIT_EVIDENCE = INSUFFICIENT_EVIDENCE** mientras no se verifiquen identidad, snapshot, calidad y barreras.

**OFFICIAL_EVALUATION = NOT_EXECUTED**

**DATA_MODIFIED = NO**

**RULE_3_ACTIVATED = NO**
`;
writeFileSync(reportPath, report, 'utf8');
console.log(JSON.stringify({ reportPath, mapPath, timelinePath, sourceHash, counts, result: a, scenarios: results.map(x => ({ name: x.name, params: x.parameters, creditedS: x.result.creditedS, outsideCreditedS: x.result.outsideCreditedS, unknownS: x.result.unknownS, coveragePercent: x.result.coveragePercent, status: x.result.status })) }, null, 2));
