# SPEC-03 Wave 5 — Cierre técnico local

## A. Implementación

Rama y worktree aislados: `codex/spec03-wave5`, derivado de `codex/spec03-wave4b` con copia de sus cambios locales sin commit. El worktree Wave 4B y el checkout principal permanecieron intactos. Pantalla `/compliance`: KPI, filtros de fecha/rango/agente/ruta/cliente/estado/sincronización, tablas paginadas, desglose por ruta/agente/cliente, mapa Leaflet, detalle de snapshot, historial y evidencia. Las tarjetas abren las visitas de la entidad filtrada. Filtros en URL persisten tras recargar. Responsive verificado a 1280 y 390 px.

## B. Arquitectura

`ComplianceDashboardService` consulta `route_assignment` y `assignment_visit` históricos, proyección `visit_evaluation_current`/`visit_evaluation`, job y vínculo temporal. No recalcula permanencia ni recorre todo el histórico GPS. Solo la vista de última ubicación autorizada consulta la última posición por dispositivo y jornada usando índices existentes. `gps_sync_status` aporta ACK/backlog observable, separado de la cola de evaluación. El detalle reutiliza el servicio Wave 4A para historial y evidencia. Las razones nuevas de reprocesamiento se guardan en `audit_event` append-only y se enlazan al historial por timestamp transaccional y clave de revisión.

## C. API y permisos

`GET /v1/admin/compliance?from=YYYY-MM-DD&to=YYYY-MM-DD&agent_id=&route_id=&client_id=&status=&sync_state=&limit=&offset=` exige sesión, usuario activo, acceso al tenant operativo y `visit.result.read`. La fecha es civil e inclusiva, máximo 31 días; `limit` 1–100 (50 por defecto), `offset` 0–10000. La respuesta contiene `indicators`, `routes`, `agents`, `clients`, `items`, `total_visits`, `next_offset`, `locations`, `location_access` y `reconciliation_policy=PENDING_APPROVAL`. Se rechazan campos, UUID, estados, fechas y límites inválidos. Las lecturas se auditan sin coordenadas en logs.

Los IDs de dispositivo solo se devuelven con `visit.device.read`. `sync_state` observable requiere además `gps.session.read`; de otro modo `UNKNOWN`. Las ubicaciones requieren además `gps.location.read`, tenant y vínculo temporal. El detalle histórico exige `visit.result.read`; los intervalos y referencias GPS exigen `visit.evidence.read` y `X-Geops-Access-Reason` de 8–240 caracteres. No hay endpoint de edición de resultados ni acceso Android.

## D. Indicadores y reglas

El universo filtrado son paradas de asignaciones en el rango y tenant, tras filtros; las canceladas se pueden inspeccionar con estado `CANCELLED`, pero se excluyen de todos los KPI de cumplimiento. `agents_with_routes` cuenta agentes distintos con asignación activa; `scheduled_routes`, asignaciones activas distintas; `scheduled_visits`, paradas activas. Los contadores por estado cubren esas paradas. `completed_routes` cuenta asignaciones activas cuyas paradas obligatorias, al menos una, están todas `COMPLETED`. Las opcionales no bloquean la ruta.

`accredited_compliance_percent = 100 × visitas obligatorias activas COMPLETED / visitas obligatorias activas`; se devuelve `null` cuando el denominador es cero. Es **provisional** en todas las respuestas por falta de política aprobada de cierre de evidencia tardía. Un job pendiente y una jornada aún abierta quedan `PENDING`; una jornada terminada sin evaluación queda `INSUFFICIENT_EVIDENCE`, también provisional. Nunca se transforma ausencia de posiciones, backlog o ACK antiguo en `NOT_VISITED`. Estados no reconocidos se muestran literalmente como desconocidos, sin clasificarse como incumplimiento.

## E. Mapa y comunicación

Leaflet dibuja centros y círculos del snapshot, marcadores y leyenda con texto además de color. El mapa usa las mismas visitas filtradas de la página de tabla (50 por defecto), con controles para avanzar. Al seleccionar un marcador se abre el detalle. La última ubicación conocida por agente/dispositivo solo aparece con permisos GPS y se limita a la jornada del vínculo temporal; incluye `captured_at`, `received_at`, precisión y antigüedad. Health distingue reporte reciente, red no disponible reportada y ausencia de comunicación reciente. Esas señales no acreditan ni niegan visitas. No se traza navegación vial.

## F. Evidencia, historia y reprocesamiento

Detalle: cliente/sede, agente, ruta/revisión, fecha/ventana, geozona/revisión/radio, permanencia requerida/acreditada, estado, evaluación, algoritmo, job, vínculo y timestamps de evidencia. Hasta 100 revisiones descendentes permiten ver cambio de estado/minutos y `supersedes_id`. Las nuevas revisiones muestran motivo auditable del job; las anteriores pueden decir “no disponible”. La lectura separada de intervalos informa IDs de eventos, captura, recepción, precisión y disponibilidad de cada evento crudo. Si la fuente fue purgada o no está disponible, se mantiene el intervalo sin fabricar coordenadas ni muestras.

## G. Rendimiento

Objetivo local: p95 <1500 ms por solicitud en ventanas de 1, 7 y 31 días con 25 agentes sintéticos; máximo 10 000 snapshots y 100 pares para mapa. En PostGIS descartable se generaron 25 agentes × 31 jornadas y **10 000 posiciones GPS históricas adicionales**: **1 día: 63 visitas, p95 17 ms; 7 días: 372 visitas, p95 57 ms; 31 días: 1574 visitas, p95 90 ms** (5 solicitudes por ventana, ejecución final). La medición es local y sintética; no valida dispositivos físicos ni volúmenes de producción. La consulta principal no lee `position_event`; la ubicación autorizada hace una lectura indexada y acotada por dispositivo.

## H. Pruebas y regresiones

`pwsh -NoProfile -File scripts/run-spec03-wave5-integration.ps1`: Wave 1 **57/57**, Wave 2 **76/76**, Wave 3 **70/70**, Wave 4A **40/40**, Wave 4B **53/53**, Wave 5 **72/72**; upgrade 0027→0029, checksums y replay **PASS**. Los 72 casos Wave 5 incluyen denominadores, opcionales, cancelaciones, filtros combinados, paginación, permisos separados, tenant, ausencia de datos, estados y causas de reprocesamiento, evidencia/retención, y carga sintética 25 agentes/31 días más 10 000 posiciones históricas.

`pwsh -NoProfile -File scripts/run-spec03-wave5-browser-e2e.ps1`: Chrome escritorio/móvil: Waves 1–3 **15+14+20**, Wave 5 **21**; GPS política **48**, health **37**, operaciones **58**. `pwsh -NoProfile -File scripts/run-spec03-mdm-integration.ps1`: **16/16** scripts MDM/GPS. `npm test`, `npm run typecheck`, `npm run build`, lint dirigido y `git diff --check`: **PASS**. El lint global del repositorio conserva advertencias preexistentes ajenas a Wave 5; no se agregaron advertencias en los archivos modificados.

Todos los ensayos PostgreSQL/PostGIS usaron `geops_verify_*` y contenedores sin volumen con datos sintéticos. No se usaron dispositivos reales ni servidores remotos.

## I. Migraciones

Wave 5 **no añade migración**. Se verificó catálogo hasta `0029_geops_gps_identity.sql`, instalación desde cero durante las suites, upgrade 0027→0029 y checksums/replay. La causa de reprocesamiento nueva usa `audit_event` existente. No se cambiaron migraciones aplicadas ni manifiestos de publicación. Reconciliar nuevamente numeración y checksums antes de integrar con ramas compartidas.

## J. Riesgos y decisiones pendientes

La validación física de Wave 4B, calibración de precisión/permanencia, política de retención de derivados y regla de cierre definitivo están pendientes. Los ACK actuales y la ausencia de comunicación reciente no prueban entrega completa ni incumplimiento. El umbral informativo de 15 minutos de ACK/health requiere calibración. La auditoría anterior a Wave 5 puede carecer de motivo por revisión. El mapa pagina marcadores; una vista mensual grande requiere navegar páginas. La prueba de rendimiento mide 25 agentes/31 días sintéticos y debe repetirse con carga representativa antes de producción. El manifiesto/controlador B23 permanece en 23 migraciones y deberá adaptarse en un frente autorizado previo a cualquier despliegue.

## K. Estado final

**WAVE5_TECHNICAL_PASS** local y sintético. Waves 1–4B mantienen sus gates técnicos. SPEC-03 está listo para revisión de integración de ramas/migraciones y decisiones operativas; no hay `OPERATIONAL_PASS` ni validación física.

`DEPLOYED = NO`

`PUSHED = NO`

`MERGED_TO_MAIN = NO`

`MERGED_TO_STAGING = NO`
`COMMITTED = NO` (rama Wave 5 con cambios locales sin commit).
