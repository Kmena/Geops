# Corrección integral de evaluación de visitas — auditoría y cierre técnico

Fecha: 2026-10-29. Alcance: código local de `codex/b32-staging-promotion`. No se consultaron datos reales ni se desplegó.

## Cadena de datos comprobada

- Android persiste y sincroniza sesiones/posiciones con ACK; la evaluación no participa en la captura ni en el protocolo v2 (`apps/android-agent/src/main/kotlin/com/geops/agent/AgentStore.kt`, `PendingUpload.kt`, `apps/api/src/gps-event-service.ts`).
- `position_event` conserva dispositivo, sesión, captura, recepción, geometría, precisión e identidad de instalación (`apps/api/src/db/migrations/0012_gps_events.sql`, `0029_geops_gps_identity.sql`).
- `client_geofence_revision` conserva revisiones inmutables de centro, radio y permanencia; `route_stop_revision` y `assignment_visit` copian la configuración aplicable a la asignación (`0024_client_geofences.sql`, `0025_route_catalog.sql`, `0026_agents_assignments.sql`, `apps/api/src/visit-schedule.ts`). La evaluación usa el snapshot, no la geozona actual.
- `agent_device_link` atribuye por intervalo de `captured_at`; la consulta de muestras exige además sesión efectiva y programada, jornada y tenant (`0028_agent_device_links.sql`, `apps/api/src/visit-evaluation.ts:samples`).

## Hallazgos y causas

1. `visit-dwell-engine.ts` ya implementa deduplicación por evento, orden por captura, clasificación conservadora con precisión, pares interiores consecutivos, límite de hueco, barreras de sesión, velocidad y crédito acotado. La consulta `visit-evaluation.ts:samples` obtiene distancias geográficas en metros mediante PostGIS `ST_Distance`. Una muestra aislada acredita cero. `visit_evaluation` e intervalos preservan revisiones y referencias de evidencia (`0027_visit_dwell_engine.sql`). El motor es técnico, no una regla física aprobada.
2. La revisión 1 de `dwell-pair-v1` es `LAB_ONLY` y la revisión 2 es `TECHNICAL_ONLY` (`0027`, `0028`). `reconcileOperational` retorna sin encolar si no existe revisión `APPROVED`; `enqueueAssignment` también rechaza operación real sin ella (`visit-evaluation.ts`). Aprobar una revisión requiere calibración y decisión de producto/GIS/privacidad/seguridad; no se hará por este cambio.
3. `visit-evaluation-worker.ts` reconcilia y drena, pero no está invocado por `main.ts`, `compose.staging.yaml` ni `api-entrypoint.sh`. En cambio, `main.ts` ya ejecuta mantenimiento GPS cada minuto. Esta desconexión explica por qué una posición aceptada no dispara por sí sola una evaluación. El estado `NOT_QUEUED` se presenta como «Sin evaluación solicitada».
4. La API ya ofrece POST administrativo por asignación o día, con permiso `visit.evaluation.recompute`, CSRF, idempotencia y auditoría (`visit-evaluation-routes.ts`, `visit-evaluation.ts`). La Web solo consume resultados/historial; no expone la acción (`ComplianceDashboard.tsx`, `api/client.ts`).
5. `normalizeVisit` muestra `INSUFFICIENT_EVIDENCE` y `0` al cerrar la jornada cuando no hay evaluación (`compliance-dashboard.ts`). Es una proyección provisional, pero puede interpretarse como resultado calculado. `NOT_VISITED` no se produce: falta una política de cobertura y cierre aprobada. `INCOMPLETE` solo expresa segundos acreditados inferiores al mínimo; tampoco demuestra ausencia física.
6. `ComplianceMap` muestra círculos del snapshot y una última ubicación, mientras `GpsMap` muestra recorridos sin geozona. Ninguna vista superpone el conjunto de posiciones históricas de la visita con el snapshot de su sede. Las coordenadas fuente solo deben exponerse con `gps.location.read` y motivo auditado.
7. La reconciliación compara conteo de posiciones y solo reencola jobs `DONE` de la misma revisión. Debe revisarse el cambio de versión aprobada, la recuperación de jobs fallidos y la concurrencia. `processNext` usa `FOR UPDATE SKIP LOCKED` y transacción, conservando el job pendiente tras reinicio antes de commit.

## Caso del 28 de octubre

Las capturas aportadas muestran asignación de 18:00 a 22:00, geozona histórica v1 de 100 m, mínimo 600 s, dispositivo vinculado, una posición a las 21:59 con precisión aproximada de 7,3 m, ACK a las 22:06 y `NOT_QUEUED`. Esto demuestra que al menos una posición llegó; no demuestra diez minutos. No hay identificador de asignación, coordenadas numéricas ni acceso autorizado a `position_event`/cola/base del entorno en uso. El diagnóstico de causa en el despliegue y una simulación histórica requieren lectura auditada de esos datos. No se inventarán posiciones ni resultados.

## Decisiones pendientes

- Parámetros y nueva revisión `APPROVED` tras protocolo físico de `wave4b-physical-protocol.md`.
- Criterio de cobertura para `NOT_VISITED` y cierre de evidencia tardía.
- Retención de evaluaciones, intervalos y auditoría.
- Identidad y cadencia operativa del evaluador en el despliegue; el cambio técnico puede quedar preparado sin activar la regla.

## Trabajo realizado por wave

- **Wave 1:** Se conservó el algoritmo conservador. La reconciliación ahora contempla asignaciones sin vínculo operativo, usa la hora del evaluador para determinar cierre de jornada y reencola un job `DONE` cuando cambia la revisión aprobada o aumenta la evidencia. Sin vínculo, el resultado puede ser `UNATTRIBUTABLE`; no se atribuye GPS por proximidad. Las evaluaciones anteriores permanecen inmutables. El estado sin evaluación es `PENDING` y la permanencia se muestra «Aún sin cálculo».
- **Wave 2:** `VisitEvaluationScheduler` se ejecuta al iniciar la API y cada 60 segundos desde `main.ts`, el mismo proceso incluido en `infrastructure/docker/api.Dockerfile` y `infrastructure/staging/api-entrypoint.sh`. Un advisory lock de PostgreSQL excluye instancias concurrentes; los jobs viven en la base y sobreviven reinicios. El scheduler solo actúa con una revisión `APPROVED`, respeta el restore gate, usa lotes de 100, registra contadores `queued`/`processed`/`skipped` y código de error sanitizado. Los reintentos de jobs usan `next_attempt_at` y backoff existentes. No hay migración ni variable de entorno nueva.
- **Wave 3:** La Web ofrece «Evaluar visita» y «Reevaluar visita» al administrador con permiso, motivo obligatorio y CSRF; deshabilita la acción si la jornada no ha terminado, hay un job activo o falta revisión aprobada. Actualiza la vista mediante polling sin recargar el documento. El mapa de evidencia muestra sede, geozona del snapshot, geozona actual, posiciones atribuidas, precisión, hora y trayectorias por sesión. La lectura exige `visit.result.read`, `visit.device.read`, `gps.location.read`, tenant y motivo auditado.
- **Wave 4:** En PostGIS desechable se probó replay tardío, versión aprobada sintética, concurrencia del scheduler, recuperación mediante instancia nueva, mapa y aislamiento. El navegador probó la ausencia de falso `0/10`, el botón inhabilitado antes del cierre y el dibujo de ambas geozonas. Se ejecutaron regresiones de catálogos, rutas, programación y GPS.
- **Wave 5:** Build y pruebas completados. No se accedió a datos reales, no se desplegó, no se insertó una revisión `APPROVED` fuera de la base desechable y no se ejecutó el reprocesamiento del 28 de octubre.

## Evidencia de validación local

| Verificación | Resultado |
| --- | --- |
| `npm run build` | API contracts, API y Web completados |
| `npm run test --workspace @geops/api` | 67 pruebas aprobadas; 12 corresponden al motor de permanencia |
| `npm run test --workspace @geops/web` | 53 pruebas aprobadas |
| Integración PostGIS de catálogo, rutas, programación y evaluación | 57 + 76 + 70 + 40 + 60 comprobaciones aprobadas |
| Navegador escritorio y 390 px | 15 + 14 + 27 comprobaciones aprobadas |
| Regresión GPS policy, health y operations | 48 + 37 + 58 comprobaciones aprobadas |

La aprobación de revisión 3 ocurrió **solo** en el contenedor PostGIS sintético que el runner destruye al finalizar. Comprobó que el scheduler omite la evaluación antes de la aprobación y que, al existir una revisión aprobada, dos ticks concurrentes producen un único replay y un reinicio no duplica resultados.

## Caso del 28 de octubre: diagnóstico reproducible

1. Buscar la asignación del 28/10/2026 para Paco Perez y SILA · Sede principal en Cumplimiento; registrar `assignment_id`, `stop_id`, tenant, `starts_at`, `ends_at` y snapshot de radio y permanencia. La captura muestra 18:00–22:00, radio 100 m y 600 s, pero no revela los IDs.
2. Consultar el job y el historial en `GET /v1/admin/assignments/:id/evaluations` y `GET /v1/admin/assignments/:id/visits/:stopId/evaluations`. Verificar revisión aprobada, estado, intentos y error. El pantallazo solo demuestra `NOT_QUEUED` en ese momento; no demuestra el estado actual del backend.
3. Con permisos y motivo, consultar el nuevo mapa de visita; comparar cada `captured_at` (no `received_at`) con la jornada, sesión, vínculo agente-dispositivo, distancia al snapshot y precisión. Consultar además el backlog y ACK del dispositivo. El único punto visible alrededor de 21:59 no acredita 600 s; puede haber otros puntos no visibles en la captura o pendientes de sincronización.
4. Tras aprobar y desplegar una revisión calibrada, ejecutar una evaluación de simulación de solo lectura con el conjunto real de posiciones y los parámetros versionados. Después, usar el POST administrativo oficial con motivo e idempotency key para reprocesar y conservar el historial. Si la evidencia sigue siendo insuficiente, registrar `INSUFFICIENT_EVIDENCE`; no fabricar puntos ni inferir permanencia.

Sin acceso autorizado a la base o al dispositivo real, el identificador, el total de posiciones, el backlog local y el resultado del caso no son verificables en esta sesión. La causa técnica confirmada para la falta de automatismo en el código anterior es la doble condición de revisión no aprobada y worker no conectado; cuál de ellas operó en el despliegue observado requiere inspección del entorno.

## Despliegue, rollback y límites

- El nuevo scheduler está dentro de `apps/api/dist/main.js`, que ejecutan la imagen API y el entrypoint de staging. No necesita otro contenedor. El health check actual comprueba `/health/ready`, base y restore gate; los contadores del scheduler aparecen en logs, no en un endpoint de métricas. Staging no se ha ensayado con esta imagen.
- No se requieren migraciones nuevas; sí deben existir las migraciones 0024–0029 y las tablas de jobs y vínculos. Antes de activar visitas reales se necesitan la revisión `APPROVED`, calibración de campo y política de cobertura/cierre. La retención de evidencia y auditoría sigue pendiente de decisión.
- Rollback técnico: restaurar la imagen API/Web anterior mediante el procedimiento de despliegue existente. Las versiones de evaluación ya persistidas permanecen auditables y no se borran. Una aprobación de algoritmo es un cambio de datos versionado y se gestiona separadamente.
- Estado: **PARTIAL, no desplegado**. Se validó el flujo técnico en base sintética; la regla de negocio real y la revisión del caso del 28/10 siguen pendientes de aprobación y acceso a evidencia real.
