# SPEC-03 — Evidencia de implementación W1-A

**Corte:** 2026-11-03. **Estado:** W1_A_TECHNICAL_PASS en rama aislada; sin despliegue. Esta evidencia cubre solo infraestructura persistente del catálogo base. W1-B y W2–W6 siguen pendientes.

## Implementación

- Migración 0016_catalog_base.sql: catalog_source, catalog_customer, catalog_establishment, catalog_customer_establishment, catalog_pin, catalog_territory_group/member, catalog_route/version/stop y catalog_revision. Índices de geografía, unicidad de namespace/identidad externa/referencia de establecimiento, FK de asociaciones y CHECK que impiden activar rutas y paradas.
- CatalogService y rutas /v1/admin/catalog: CRUD con archivo lógico para fuentes, clientes, establecimientos, pins, grupos y rutas; listado/edición/borrado de paradas candidatas; vínculos explícitos de cliente con establecimiento y miembros de grupo; lectura de revisión del catálogo. If-Match y versiones para cambios; motivo obligatorio y audit_event.
- Permisos catalog.import.read, catalog.import.write y catalog.import.confirm en esquema, administración de usuarios y Web. La migración no otorga ninguno. La API W1-A usa read/write; confirm no tiene endpoint de importación.
- El servicio solo crea clientes CANDIDATE y fuentes PENDING. La base exige fuente CSV/XLSX autorizada para identidad VERIFIED. No se usan códigos de KMZ como identidad comercial ni se crean visitas.

## Contratos disponibles

Base /v1/admin/catalog. GET /revision; GET/POST /sources, /customers, /establishments, /pins, /groups y /routes; GET/PATCH/DELETE de cada recurso por /{id}. GET/POST /establishments/{id}/customers y DELETE /establishments/{id}/customers/{customerId}. GET /groups/{id}/members; POST/DELETE /groups/{id}/members/{establishmentId}. GET/POST /routes/{id}/stops y GET/PATCH/DELETE /routes/{id}/stops/{stopId}. GET requiere catalog.import.read; toda mutación exige sesión admin, Origin, CSRF y catalog.import.write. PATCH/DELETE y cambios de asociación exigen If-Match. DELETE de recursos principales archiva y rechaza referencias vigentes; DELETE de parada elimina el candidato. No existe contrato de carga comercial ni de KMZ.

## Validación ejecutada

| Comando o escenario | Entorno | Resultado |
| --- | --- | --- |
| catalog:w1a:integration | PostgreSQL/PostGIS descartable geops_verify_1109, GEOPS_DATA_MODE=synthetic | PASS: migración 0001–0016 limpia, API, permisos denegados por defecto y revocación, validación de coordenadas, identidad no autoritativa, unicidad, FK, asociaciones, rutas DRAFT, paradas CANDIDATE, carrera de dos PATCH (200/409), auditoría y catalog_revision. |
| catalog:w1a:upgrade:integration | geops_verify_1110 | PASS: 0015→0016, fallo inyectado y rollback, admin/dispositivo conservados, cero grants nuevos, repetición idempotente. |
| npm run test --workspace @geops/api | local sintético | PASS: 32 pruebas. |
| npm run test --workspace @geops/web | local sintético | PASS: 41 pruebas. |
| npm run gps:integration --workspace @geops/api | geops_verify_1107 | PASS: 45 verificaciones de políticas GPS. |
| npm run admin:users:integration --workspace @geops/api | geops_verify_1108 | PASS: 42 verificaciones de administración de usuarios. |
| tsc --noEmit, API y Web | worktree aislado | PASS ambos. |

Las pruebas nuevas están en apps/api/test/catalog-w1a.integration.mjs y catalog-w1a-upgrade.integration.mjs. Usan exclusivamente bases geops_verify_* sintéticas y exigen una base vacía. La imagen local fue postgis/postgis:18-3.6. No se ejecutó migración en staging ni producción. La primera tentativa de regresión GPS se hizo antes de preparar su base y falló por ausencia de admin_user; se preparó geops_verify_1107 con el guard de migración y la repetición pasó. No se atribuye ese fallo inicial al producto.

## Pendientes y límites

- W1-B: muestra/diccionario y contrato autorizado CSV/XLSX para crear/actualizar identidad comercial VERIFIED, resolver campos oficiales y procedencia. No existe flujo de aprobación de fuente ni ingestión comercial en W1-A.
- W2–W6: upload/parser, matching, revisión Web, confirmación idempotente, ledger y validación integral con fixture autorizado. Los P01–P19 de esas waves no se declaran ejecutados por esta evidencia.
- El catálogo queda en borrador/candidato. No hay publicación de geometrías, rutas operativas ni visitas. La API W1-A se ha probado en bases aisladas y aún requiere revisión de integración y autorización separada antes de cualquier despliegue.

## Estado de Git

Worktree aislado: C:\Users\kmena\.codex\worktrees\geops-spec03-w1a\Geops; rama codex/spec-03-w1a, base 26efc9a39d1a1c95ede6cb353656e3c54bfd92cf. Cambios locales sin commit, push, merge ni despliegue. El checkout principal conserva sus cambios previos.
