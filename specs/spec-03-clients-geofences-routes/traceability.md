# Matriz de trazabilidad

| Decisión/requisito | Diseño | API/modelo | Pruebas | Wave |
| --- | --- | --- | --- | --- |
| DEC-GEO-001 / FR-02–03 | `architecture.md` clasificación; ADR-021 | `client_site`, `client_geofence_revision`; geofence endpoints | G-01–05, P-01 | 1 |
| DEC-GEO-002 / FR-07–09 | `architecture.md` algoritmo; ADR-022 | `assignment_visit`, `visit_evaluation/evidence`; resultados | D-01–09, O-01–05 | 4 |
| DEC-ROUTE-001 / FR-04/10 | ADR-023 | `route_revision/stop`; routes endpoints | A-01–03 | 2,5 |
| FR-01 | `requirements.md` | `client`; clients endpoints | G-04–05, S-01 | 1 |
| FR-05 | ADR-024 | revisiones + snapshots | G-03, D-08, A-03 | 2,3 |
| FR-06 | ADR-026 | `agent`, vínculo, reglas, asignaciones | A-03–05, D-04/09 | 3 |
| FR-08/09, NFR-03/04 | ADR-025; `architecture.md` | outbox, historial, sync/coverage | D-05–09, O-01–05 | 4 |
| FR-11, NFR-08 | `architecture.md` | compliance/calendar/evidence | A-02, P-01, S-01 | 5 |
| FR-12, NFR-01/06 | `risks.md` | capacidades, auditoría, retención | S-01/02, O-04 | 1–5 |
| NFR-02 | `audit.md` compatibilidad | GPS v2 sin cambios | NR-01/02, O-03 | 0–5 |
| NFR-05/07 | `architecture.md`, `api-contracts.md` | worker, cursor, ETag, idempotencia | L-01, S-02 | 4–5 |

**Puerta documental:** ningún requisito queda sin diseño, contrato o prueba. Las filas enlazan identificadores del plan, no resultados. Decisiones P-01–P-09 de `risks.md` deben cerrarse antes de sus waves dependientes.

## Evidencia Wave 1 — 2026-10-26

| Requisito | Implementación | Evidencia local | Estado |
| --- | --- | --- | --- |
| FR-01/02 | `client`, `client_site`; servicio y rutas de catálogo | Integración PostGIS: creación, duplicados, búsqueda, edición, estados, varias sedes y auditoría | TESTED |
| FR-03 / DEC-GEO-001 | `client_geofence_revision`, PostGIS `geography`, editor Leaflet | Integración: radio, dwell, historia inmutable; navegador: centro elegido, círculo visible, revisión creada y editada, recarga | TESTED |
| FR-12 / NFR-01 | capacidades explícitas, sesión, CSRF, tenant y `audit_event` | Integración: acceso negativo y positivo, tenant forjado, 403/404, auditoría | TESTED |
| NFR-07 | listas paginadas, clave idempotente y ETag | Integración: cursor, límites, replay, conflicto y precondiciones | TESTED |
| NFR-08 | formulario alterno al mapa, foco y responsive | Playwright E2E repetible: 15 aserciones en escritorio/móvil; captura móvil y navegación Tab manual | TESTED local |
| NFR-02 | GPS y MDM sin modificaciones de protocolo | Suite local y regresiones de políticas GPS, eventos e inscripción sintética | TESTED local |

**Gate Wave 1:** `TECHNICAL_PASS` local tras revisar los 12 criterios de aceptación, lint dirigido y 57 + 15 comprobaciones de integración/navegador. `DEPLOYED = NO`. La deuda de lint global preexistente queda en `risks.md` como `TD-EXT-01`. Ver [wave1-closure.md](wave1-closure.md) para evidencia y límites.

## Evidencia Wave 2 — 2026-10-26

| Requisito | Implementación | Evidencia local | Estado |
| --- | --- | --- | --- |
| DEC-ROUTE-001 / FR-04 | `route_template`, `route_draft_stop`, UI de paradas y mapa Leaflet | Integración: dos sedes de un cliente, misma sede en varias rutas, orden editable, dwell/obligatoria; Web Chrome: selección, mapa/círculos y orden | TESTED local |
| FR-05 / NFR-06 | `route_revision`, `route_stop_revision` con snapshots y sellado SQL | Integración: dos publicaciones, edición posterior, revisión exacta, cambio de geozona sin mutar historia, UPDATE/INSERT tardío rechazados | TESTED local |
| NFR-01 / FR-12 | sesión, `visit.catalog.read/write`, tenant, CSRF y auditoría | Integración: lector sin escritura, tenant forjado, FK cruzada, CSRF y eventos `route.*` | TESTED local |
| NFR-07 | cursor, idempotencia y ETag de ruta | Integración: búsqueda, paginación, replay, conflicto, 428/412 | TESTED local |
| NFR-08 | constructor Web y mapa con lista/controles alternos | 14 aserciones Chrome 1280/390 px, incluido error textual, recarga y versiones | TESTED local |
| NFR-02 | aislamiento respecto a GPS/MDM | `npm test`, typecheck, builds y revisión de diff; Wave 1 57+15 reejecutadas | TESTED local |

**Gate Wave 2:** `TECHNICAL_PASS` local: 14/14 criterios de aceptación con evidencia de 76 + 14 comprobaciones Wave 2 y 57 + 15 de regresión Wave 1. `DEPLOYED = NO`. No incluye asignaciones, motor GPS ni prueba física. Ver [wave2-closure.md](wave2-closure.md).

## Evidencia Wave 3 — planificación local

| Requisito | Implementación | Evidencia local | Estado |
| --- | --- | --- | --- |
| FR-06 / agentes | `agent`, API y catálogo Web | CRUD, código duplicado, estados, tenant, permisos y auditoría en integración | TESTED local |
| FR-06 / asignaciones | `route_assignment`, `assignment_visit`, `/calendar` | Ruta publicada, varias rutas por día, solape, snapshots, cancelación, ETag e idempotencia | TESTED local |
| FR-06 / recurrencia | Regla, excepción y ocurrencia versionada | Días ISO, ventana de 31 días, reejecución, SKIP/CANCEL/REPLACE, zona IANA | TESTED local |
| NFR-08 | Calendario semanal/mensual, detalle y mapa | E2E Chrome escritorio/móvil, persistencia tras recarga | TESTED local |
| Vínculo agente–dispositivo | Pendiente de tenant canónico MDM-free | No se atribuye GPS ni se ofrece vínculo falso | PENDING |

**Gate Wave 3:** `WAVE3_PLANNING_TECHNICAL_PASS` con 70/70 comprobaciones PostGIS y 20/20 Chrome, más regresión Wave 1 (57+15) y Wave 2 (76+14). `AGENT_DEVICE_INTEGRATION_PENDING`; `DEPLOYED = NO`. Ver [wave3-closure.md](wave3-closure.md).

## Evidencia Wave 4A — motor local

| Requisito | Implementación | Evidencia | Estado |
| --- | --- | --- | --- |
| DEC-GEO-001 / DEC-GPS-001 | `ST_Distance(geography)` más radio de precisión; pares interiores consecutivos y tope por hueco | Unitarios de borde, incertidumbre, radio, velocidad, muestra aislada y geografía PostGIS en integración | TESTED sintético |
| DEC-GEO-002 / DEC-ROUTE-001 | Acumulación en `assignment_visit` y `[starts_at,ends_at)`; ninguna restricción de orden | Unitarios de reingreso, medianoche y ventana; integración de varios intervalos | TESTED sintético |
| DEC-GPS-002 | Digest de fuentes, job serializado, revisión inmutable y proyección | Replay sin revisión nueva, evidencia tardía desordenada crea revisión nueva y conserva anterior | TESTED sintético |
| Identidad | `visit_lab_agent_device_link` con exclusión temporal; sin vinculación implícita | Sin vínculo `UNATTRIBUTABLE`; vínculo temporal sintético explícito | TESTED sintético; Wave 4B pendiente |
| Acceso / privacidad | Permisos específicos, tenant, razón de acceso y auditoría; evidencia sin coordenadas | Integración administrativa y SQL de historia | TESTED sintético |
| Activación automática / física | No conectada a ingestión; sin fuente de identidad real ni umbrales aprobados | Pendiente de Wave 4B, retención y calibración | PENDING |

**Gate Wave 4A:** `WAVE4A_ENGINE_TECHNICAL_PASS` local con 12/12 unitarios y 40/40 integración sintética PostGIS; Waves 1–3 y GPS conservan PASS. `WAVE4B_PHYSICAL_INTEGRATION_PENDING`; `DEPLOYED = NO`. Ver [wave4a-closure.md](wave4a-closure.md) para conteos y límites.
