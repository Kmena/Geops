# SPEC-03 — Cierre técnico local Wave 3: planificación

> Registro histórico del worktree SPEC-03 original. En la copia de integración con MDM, `0024_agents_assignments.sql` pasó a `0026_agents_assignments.sql`; ver [informe de integración](mdm-integration-report.md).

**Fecha:** 2026-10-26. **Worktree:** `C:/Users/kmena/.codex/worktrees/geops-clients-routes-sdd/Geops`. **Rama:** `codex/spec03-wave1`. Datos exclusivamente sintéticos. **Estado:** `WAVE3_PLANNING_TECHNICAL_PASS`; `AGENT_DEVICE_INTEGRATION_PENDING`.

## Implementación terminada

- Catálogo administrativo de agentes independiente de MDM: código único por tenant, nombre, estado activo/inactivo, edición con versión, permisos `visit.schedule.read/write` y auditoría.
- Asignaciones manuales, extraordinarias y recurrentes de rutas **publicadas** con revisión exacta. Un agente admite varias rutas distintas en una fecha si sus intervalos no se solapan. El API rechaza agentes/rutas inactivos, revisiones no publicadas, fechas civiles inválidas, zona IANA inválida y hora DST ambigua o inexistente.
- Snapshot histórico de agente, ruta, revisión, clientes, sedes, geozonas circulares, radio, permanencia mínima, obligatoriedad y orden visual. `assignment_visit` prohíbe UPDATE/DELETE; cancelar conserva el snapshot. Las modificaciones posteriores de plantilla no alteran la asignación.
- Reglas semanales con vigencia, días ISO, zona IANA, horario local y versión. Materialización explícita de máximo 31 fechas civiles, idempotente por regla/fecha/versión. Excepciones `SKIP`, `CANCEL` y `REPLACE`; cambios futuros cancelan la asignación planificada previa y conservan su historia. La asignación extraordinaria se registra con origen propio.
- Calendario Web semanal y mensual en `/schedule`, con navegación, filtros por agente/ruta, varias rutas en un día, formularios de agente/asignación/recurrencia/excepción, cancelación, detalle de versión y snapshot con mapa y lista. Chrome de 1280 y 390 px no presenta desbordamiento horizontal.

## API y controles

`GET /v1/admin/schedule-capabilities`; `GET/POST /agents`, `GET/PATCH /agents/{id}`; `GET/POST /assignments`, `GET /assignments/{id}`, `POST /assignments/{id}/cancel`; `GET /calendar`; `GET/POST /schedule-rules`, `GET/PATCH /schedule-rules/{id}`, `PUT /schedule-rules/{id}/exceptions/{date}`, `POST /schedule-rules/{id}/materialize`.

Sesión administrativa, tenant operativo derivado en servidor, concesión explícita de permisos, Origin/CSRF, `Idempotency-Key`, cursor/límite, ETag/`If-Match` y eventos de auditoría. La exclusión GiST y las transacciones serializan conflictos entre administradores. Android no puede escribir estos recursos. No se agregó `device_id` al contrato de asignación.

## Base de datos y compatibilidad

`0024_agents_assignments.sql` agrega `agent`, `route_assignment`, `assignment_visit`, `route_schedule_rule`, `route_schedule_exception`, `route_schedule_occurrence`, idempotencia e índices/FKs compuestas por tenant. Se conservan las migraciones 0022/0023 y sus modelos. Antes de crear 0024 se observó hasta 0021 en los worktrees MDM/GPS y 0022/0023 locales; ninguna migración aplicada se editó ni renumeró. El runner aplica el esquema mediante el migrador con checksum en una base `geops_verify_*` recién creada en `postgis/postgis:18-3.6`, sin volumen persistente, y destruye contenedor/base al terminar. Numeración y checksums deben reconciliarse otra vez al integrar ramas concurrentes.

## Verificación final

| Gate | Resultado observado |
| --- | --- |
| Integración Wave 3 en PostGIS descartable | **70/70 PASS**: agentes, rutas distintas el mismo día, exclusión de solapes y concurrencia, snapshots, cancelación, idempotencia, recurrencia, SKIP/CANCEL/REPLACE, DST, tenant, permisos, CSRF, ETag y auditoría. |
| Chrome Wave 3 | **20/20 PASS**: agente, dos rutas distintas en una fecha, persistencia, regla, excepción, materialización, cancelación, snapshot, semana/mes, navegación, filtro y móvil 390 px. |
| Regresión Wave 1 | **57/57** integración y **15/15** navegador PASS en la misma ejecución. |
| Regresión Wave 2 | **76/76** integración y **14/14** navegador PASS en la misma ejecución. |
| `npm test` | PASS, exit 0; API, Web, contratos, migraciones y fixtures restore/release. |
| `npm run build` | PASS, exit 0; contratos, API y Web. |
| `npm run typecheck` | PASS, exit 0 en los tres workspaces. |
| Biome dirigido Wave 3 | PASS sin errores ni advertencias en 12 archivos de aplicación/integración; fixture Playwright PASS con formatter desactivado por su sintaxis de ejecución. |
| `git diff --check` | PASS, sin errores de whitespace. |

Runner reproducible: `scripts/run-spec03-browser-e2e.ps1` (Docker/PostGIS y Chrome locales, puertos loopback 3500/3501/55442). No se usaron datos reales ni bases persistentes. Los errores globales de lint `TD-EXT-01` continúan como deuda ajena en GPS/scripts; los archivos SPEC-03 modificados pasan lint dirigido.

## Pendientes y riesgos

`geops_device` no tiene tenant canónico verificable sin consultar `mdm_binding`. Por aislamiento de tenant y atribución histórica, **no se implementó** `agent_device_assignment` ni se asoció GPS a agentes. El frente MDM/identidad debe definir un identificador/tenant confiable y vigencias antes de habilitar esa relación. Tampoco se implementaron motor de permanencia, cumplimiento, navegación vial, optimización, workers periódicos ni validación física; corresponden a Waves 4/5 u operación posterior. Los límites de radio y permanencia de Wave 1 siguen pendientes de calibración física para uso real. La ventana de materialización es explícita y acotada; programarla y monitorearla en producción requiere decisión operativa posterior.

No hay regresiones nuevas observadas. No se modificaron GPS, Android, MDM, OAuth, `mdm_binding`, controlador de despliegues ni políticas offline. Los archivos Wave 1/2 siguen sin commit en esta misma rama aislada.

## Estado de cierre

Los criterios de planificación local de Wave 3 están satisfechos y Waves 1/2 conservan PASS. La integración agente–dispositivo y cualquier validación GPS completa siguen pendientes.

`WAVE3_PLANNING_TECHNICAL_PASS`
`AGENT_DEVICE_INTEGRATION_PENDING`
`DEPLOYED = NO`
`COMMITTED = NO`
`PUSHED = NO`
`MERGED = NO`
