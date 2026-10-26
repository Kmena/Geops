# SPEC-03 Wave 2 — cierre técnico local

> Registro histórico del worktree SPEC-03 original. En la copia de integración con MDM, `0023_route_catalog.sql` pasó a `0025_route_catalog.sql`; ver [informe de integración](mdm-integration-report.md).

**Fecha:** 2026-10-26. **Worktree:** `C:/Users/kmena/.codex/worktrees/geops-clients-routes-sdd/Geops`. **Rama:** `codex/spec03-wave1`. Base observada `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`. Se preservaron todos los cambios sin commit de Wave 1. Las pruebas usan datos sintéticos, PostGIS descartable y Chrome local.

## A. Implementación

Catálogo de rutas reutilizables con alta, consulta, búsqueda/filtro/paginación, edición, activación/desactivación y consulta de versiones. El borrador contiene paradas de sedes existentes, geozona publicada activa, permanencia heredada o sobrescrita, obligatoriedad y orden sugerido. Una sede aparece una vez por ruta; distintas sedes del mismo cliente son visitas distintas y la misma sede se admite en varias rutas. Publicar requiere al menos una parada obligatoria. `suggested_order` solo ordena la Web; no existe lógica de cumplimiento ni navegación optimizada. La duplicación de una ruta mediante operación especial se omitió por ser opcional; crear otra ruta con las mismas sedes está probado. Wave 3–5 siguen pendientes.

## B. Código

Nuevos: `apps/api/src/route-catalog.ts`, `apps/api/src/route-catalog-routes.ts`, `apps/web/src/RouteCatalog.tsx`, `apps/web/src/RouteMap.tsx`, pruebas `route-catalog.integration.mjs` y `route-catalog.e2e.js`. Integración mínima en `apps/api/src/app.ts`, `main.ts`, fixture de navegador, `apps/web/src/app.tsx`, `api/client.ts`, `styles.css` y runner SPEC-03. No se modificaron Android, GPS v2, ingesta, MDM/OAuth, `mdm_binding`, políticas offline ni despliegues por Wave 2.

## C. Base de datos

`0023_route_catalog.sql` agrega `route_template`, `route_draft_stop`, `route_revision`, `route_stop_revision` e idempotencia. FKs compuestas, unicidad por tenant/ruta/sede, CHECK de estados/dwell/centro/radio e índices de lista/historial. Publicación crea snapshot y hash, inserta paradas, sella la revisión y actualiza cabecera en una sola transacción. Triggers rechazan UPDATE/DELETE de revisiones y paradas publicadas, y INSERT de paradas tras sellado. La migración se aplicó y probó solo en una base `geops_verify_*` nueva dentro de `postgis/postgis:18-3.6` sin volumen persistente. Se verificó antes de escribir que los frentes MDM/GPS visibles terminaban en 0021, con 0022 local de Wave 1; numeración pendiente de reconciliación al integrar.

## D. API

`GET/POST /v1/admin/routes`, `GET/PATCH /routes/{id}`, `PUT /routes/{id}/draft/stops`, `POST /routes/{id}/publish`, `POST /routes/{id}/activate|deactivate`, `GET /routes/{id}/revisions` y `GET /routes/{id}/revisions/{revision}`. Lectura requiere `visit.catalog.read`; escritura `visit.catalog.write`, sesión administrativa, Origin/CSRF, acceso al tenant operativo derivado del servidor. Escrituras con `Idempotency-Key`; cambios con `If-Match` y ETag. Listas con cursor y límite 1–100. Errores sanitizados según Wave 1. No existe endpoint de escritura para dispositivo.

## E. Web

Catálogo y constructor en `/routes`: búsqueda de rutas y clientes, selección de sedes activas, mapa Leaflet con centro/círculo por parada, dwell heredado/override, obligatoriedad, orden visual, guardar/recargar, publicar, activar/desactivar y consultar snapshots anteriores. Controles de lista y formulario acompañan al mapa. Se verificó a 1280 y 390 px sin desbordamiento horizontal; la pantalla de error de ruta vacía se probó en Chrome. El mapa no dibuja recorrido GPS ficticio.

## F. Pruebas

| Gate | Resultado final observado |
| --- | --- |
| Integración PostGIS Wave 2 | **76/76** comprobaciones PASS: CRUD, reglas de paradas, referencias inválidas/inactivas, permisos, tenant, CSRF, ETag, idempotencia, auditoría, versiones, snapshot y sellado SQL. |
| E2E Chrome Wave 2 | **14/14** comprobaciones PASS, escritorio 1280 px y móvil 390 px; flujo crear/seleccionar/mapa/editar/guardar/recargar/publicar/historial/error. |
| Regresión PostGIS Wave 1 | **57/57** comprobaciones PASS en la misma ejecución descartable. |
| Regresión Chrome Wave 1 | **15/15** comprobaciones PASS en escritorio/móvil. |
| `npm test` monorepo | PASS, exit 0 (API, Web, contratos, migración, restore y release fixture). |
| API y Web build | PASS, exit 0 cada uno; `tsc` y Vite. |
| `npm run typecheck` monorepo | PASS, exit 0. |
| Biome dirigido | PASS sin errores ni advertencias sobre los archivos Wave 2; fixture E2E con formatter desactivado por sintaxis especial de Playwright CLI. |

El runner `scripts/run-spec03-browser-e2e.ps1` verifica que puertos estén libres, arranca PostGIS descartable solo en loopback, crea `geops_verify_*`, ejecuta 57+76 y 15+14 pruebas, y detiene Chrome, procesos y contenedor en `finally`. No se tocó ninguna base persistente.

## G. Compatibilidad

Wave 1 conserva `TECHNICAL_PASS`: sus 57 pruebas de integración y 15 de navegador pasaron después de añadir Wave 2. El catálogo de clientes/geozonas sigue siendo la fuente maestra; los snapshots publicados de rutas no cambian si cambia después una geozona. Las rutas almacenan solo condiciones; no se inició Wave 3 (asignaciones), Wave 4 (permanencia GPS) ni Wave 5 (cumplimiento).

## H. Riesgos y deuda

`TD-EXT-01`: errores globales preexistentes de lint en GPS/scripts ajenos; se conserva como deuda externa, no se modificaron esos archivos. Límites de radio/permanencia son configurables y pendientes de calibración física para uso operativo. La retención/purga de claves idempotentes requiere política antes de operación sostenida. Reconciliar numeración/checksums con MDM/GPS antes de integración. ADR-024 sigue como propuesta para adopción de producción. La entidad agente, asignaciones y vínculo MDM-free siguen pendientes de Waves posteriores.

## I. Estado

**TECHNICAL_PASS = YES** para Wave 2 local. Los 14 criterios de aceptación tienen evidencia: catálogo (API/Web), múltiples sedes, requisitos de visita, mapa, orden solo visual, historia y sellado, reutilización, capacidad/tenant, migración descartable, E2E escritorio/móvil, regresión Wave 1, suite general y aislamiento de frentes. Esta calificación es técnica y local; no autoriza uso operativo.

`DEPLOYED = NO`
`COMMITTED = NO`
`PUSHED = NO`
`MERGED = NO`
