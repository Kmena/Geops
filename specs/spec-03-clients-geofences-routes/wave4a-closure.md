# SPEC-03 — Cierre técnico local Wave 4A: motor de permanencia

> Registro histórico del worktree SPEC-03 original. En la copia de integración con MDM, `0025_visit_dwell_engine.sql` pasó a `0027_visit_dwell_engine.sql`; ver [informe de integración](mdm-integration-report.md).

**Fecha:** 2026-10-26. **Worktree:** `C:/Users/kmena/.codex/worktrees/geops-clients-routes-sdd/Geops`. **Rama:** `codex/spec03-wave1`. **HEAD inicial conservado:** `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`. Solo datos sintéticos y PostGIS descartable.

## A. Arquitectura

La evaluación lee `position_event` ya persistida y los snapshots `assignment_visit` de Wave 3. Ninguna llamada HTTP recorre posiciones: `POST` administrativo encola en `visit_evaluation_job`; `visit-evaluation-worker.ts` reconcilia evidencia sintética nueva y procesa hasta 100 jobs por ejecución con `FOR UPDATE SKIP LOCKED`. Cada visita limita su lectura a 5000 posiciones del tenant, agente vinculado explícitamente, dispositivo, jornada y sesiones GPS efectiva/programada. No se alteraron ingesta, ACK, Android, MDM, `mdm_binding`, OAuth ni despliegues. No hay outbox de ingestión ni programador productivo: ejecutar periódicamente el worker y resolver su identidad operativa pertenecen a Wave 4B/operaciones.

## B. Algoritmo

`dwell-pair-v1` revisión 1 es `LAB_ONLY`: `max_gap_s=300`, `credit_cap_s=300`, `uncertainty_guard_s=0`, `max_accuracy_m=25`, `boundary_tolerance_m=0`, `max_speed_m_s=50`. Estos son **valores provisionales de laboratorio**, no umbrales aprobados para visitas reales. La lógica usa `ST_Distance` sobre `geography` en metros y clasifica interior solo cuando distancia + precisión + tolerancia ≤ radio histórico. Fuera requiere distancia − precisión > radio + tolerancia; los demás puntos son inciertos. Solo pares consecutivos interiores, con mismo vínculo, sesión, arranque y ancla, sin interrupción y dentro del hueco/velocidad permitidos, acreditan `floor(min(Δ,cap) − guard)` segundos. Una muestra aislada, huecos grandes y bordes inciertos acreditan cero. Salir y reingresar conserva el saldo de la jornada; `[starts_at,ends_at)` impide transferir segundos entre jornadas. `completed_at` es estimación basada en el par que cruza el mínimo, no instante GPS observado de llegada.

## C. Modelo de datos y migración

`0025_visit_dwell_engine.sql` agrega tres capacidades explícitas, `visit_algorithm_revision`, vínculo temporal sintético `visit_lab_agent_device_link` con exclusiones GiST, jobs, historia append-only `visit_evaluation`, proyección `visit_evaluation_current` e intervalos `visit_evaluation_interval`. El intervalo retiene IDs y tiempos, sin coordenadas ni FK a `position_event` que impida su purga. FKs compuestas preservan tenant/visita/asignación; triggers prohíben alterar o borrar evaluaciones, intervalos, versiones de algoritmo y vínculos históricos de laboratorio. `position_count` del job se toma **antes** de evaluar para que llegadas concurrentes se detecten en la siguiente reconciliación. El migrador registra y verifica checksum en `geops_schema_migrations`. Las migraciones de worktrees MDM/GPS inspeccionados llegaban hasta 0021; 0022–0024 son locales de Waves 1–3. No se editó ninguna migración previa; 0025 debe volver a reconciliarse al integrar.

## D. Evaluación y acceso

Estados: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `INCOMPLETE`, `INSUFFICIENT_EVIDENCE` y `UNATTRIBUTABLE`; `NOT_VISITED` está reservado hasta aprobar una política de cobertura suficiente. Sin vínculo temporal, el estado es `UNATTRIBUTABLE`; ausencia de posiciones no se interpreta como visita ausente. `visit.result.read`, `visit.evidence.read` y `visit.evaluation.recompute` exigen sesión administrativa, tenant operativo explícitamente concedido y autorización individual; mutaciones exigen Origin/CSRF e idempotencia. La lectura de evidencia exige motivo y deja auditoría. API administrativa: encolar asignación, encolar fecha/agent, consultar resultado, historial y pares de evidencia. No se exponen coordenadas en evaluación. `physical_credited_s` une rangos temporales compartidos y `visit_credited_sum_s` expresa el crédito por cada requisito: una geozona compartida puede satisfacer dos visitas sin convertir un segundo físico en dos segundos agregados.

## E. Reprocesamiento

El digest de snapshot, fase temporal, algoritmo, vínculos, posiciones y barreras evita una revisión nueva si nada cambió. Evidencia tardía o desordenada causa nueva revisión y actualiza la proyección en una transacción, sin borrar el resultado anterior. El poller sintético compara número de posiciones recibidas con las observadas por el último job; el administrador puede forzar reproceso de asignación o fecha. Un conteo igual no detecta correcciones de una fila existente; necesitan reproceso explícito. El acceso del worker a la regla `LAB_ONLY` se bloquea fuera de modo sintético y de base `geops_verify_*` descartable. La integración física, retención final y activación automática operativa siguen pendientes.

## F. Pruebas

| Gate | Resultado final |
| --- | --- |
| Motor unitario | **12/12 PASS**: bordes, precisión, radios, reingresos, huecos, barreras, orden, medianoche, estados, redondeo y unión física. |
| Integración Wave 4A PostGIS | **40/40 PASS**: historial, identidad sintética, evidencia tardía/desordenada, idempotencia, poller, workers concurrentes, fecha, cancelación, acceso e inmutabilidad de vínculo/algoritmo. |
| Migración/checksum 0025 en base descartable | **PASS** por migrador y fila en `geops_schema_migrations`; esquema creado en PostGIS 18-3.6 sin volumen. |
| API/autorización/auditoría | **PASS** dentro de las 38 comprobaciones: 403/404/409/422, razón de acceso, auditoría y sin coordenadas en resultado. |
| `npm test` | **PASS**, exit 0; API, Web, contratos, migraciones y restore/release. |
| `npm run build` | **PASS**, exit 0; contratos, API y Web. |
| `npm run typecheck` | **PASS**, exit 0 en los tres workspaces. |
| Biome dirigido / `git diff --check` | **PASS**, 11 archivos de aplicación/prueba sin errores ni advertencias; diff sin whitespace inválido. |

Runner reproducible: `pwsh -NoProfile -File scripts/run-spec03-browser-e2e.ps1`. Crea `geops_verify_*` en `postgis/postgis:18-3.6` sin volumen persistente, usa puertos loopback y destruye contenedor/base al finalizar. La fixture Wave 4A usa agentes, dispositivos, posiciones y vínculos exclusivamente sintéticos. No se usaron datos reales ni bases persistentes.

## G. Regresiones

| Alcance | Resultado final |
| --- | --- |
| Wave 1 integración / Chrome | **57/57 + 15/15 PASS**. |
| Wave 2 integración / Chrome | **76/76 + 14/14 PASS**. |
| Wave 3 integración / Chrome | **70/70 + 20/20 PASS**. |
| GPS políticas, salud y operaciones | **45/45 + 37/37 + 58/58 PASS**. |

## H. Riesgos y límites

La identidad agente–dispositivo real sigue sin contrato fiable independiente de MDM. El vínculo implementado es exclusivamente de laboratorio y no es una vía de atribución física. La regla conservadora puede aun sobreestimar presencia entre dos muestras o subestimar señal intermitente; parámetros y cobertura necesitan calibración física. La retención de evaluaciones, intervalos e IDs de eventos no tiene plazo aprobado por privacidad; una vez purgada la fuente GPS, la revisión histórica permanece pero el detalle original no es reconstruible. Falta activar reconciliación operativa con garantías de lag/outbox, carga sostenida y observabilidad. Nada de esto equivale a validación GPS física. Riesgos en [risks.md](risks.md) y ADR-025.

`TD-EXT-01` (lint global preexistente en archivos GPS/scripts ajenos a SPEC-03) continúa como deuda externa; el lint dirigido de todos los archivos de aplicación/prueba tocados por Wave 4A pasó sin errores nuevos.

## I. Estado técnico final

Los criterios del **motor local sintético** están satisfechos: geografía circular y precisión; permanencia acumulada con reingreso y sin muestra aislada/huecos largos; snapshots y horario histórico; replay determinista, nueva evidencia tardía y trazabilidad; atribución solo con vínculo temporal; migración descartable; pruebas y regresiones aprobadas; aislamiento de GPS/Android/MDM/despliegues. `TECHNICAL_PASS` se limita al motor Wave 4A. La integración física y la afirmación de cumplimiento GPS real permanecen pendientes de Wave 4B.

`WAVE4A_ENGINE_TECHNICAL_PASS`
`WAVE4B_PHYSICAL_INTEGRATION_PENDING`
`AGENT_DEVICE_INTEGRATION_PENDING`

`DEPLOYED = NO`
`COMMITTED = NO`
`PUSHED = NO`
`MERGED = NO`
