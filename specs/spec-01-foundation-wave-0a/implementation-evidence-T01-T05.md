# Evidencia de implementación T01–T05 — 2026-10-16

**Rama:** `codex/spec-01-wave-0a`. **Entorno:** Windows, Node 24.16.0, npm 11.13.0, Docker Engine 27.3.1, Compose 2.29.7; Docker Linux amd64. Exclusivamente configuración y marcadores sintéticos. No se cargó `apps/api/.env.local`, no se hizo OAuth ni se llamó ManageEngine. El corte inicial no tenía commit; la validación CI de T02 prepara uno y registrará SHA y workflow tras una ejecución remota exitosa. La revisión externa Free/Android de SPEC-00 permanece BLOCKED.

## Resultado por tarea

| Tarea | Implementación | Cierre formal |
| --- | --- | --- |
| T01 | Workspaces raíz/API/Web/contratos, lockfile y scripts; diagnóstico OAuth heredado conservado. | **DONE**: `npm ci --ignore-scripts --offline=false` instaló 136 paquetes desde lockfile; 18 pruebas de diagnóstico siguen pasando sin credenciales reales. |
| T02 | TS strict, Biome y workflow `.github/workflows/wave-0a.yml`. | **IMPLEMENTED / CI_PENDING**: comandos equivalentes pasaron localmente; el job GitHub Actions espera publicación autorizada de la rama. |
| T03 | OpenAPI 3.1 versionado y validado contra SPEC-01, esquemas de health/error, layouts canónicos PoP/enrollment/session/attestation/rotation. | **DONE para contrato**: Swagger Parser + igualdad del contrato + 4 pruebas de vectores sintéticos; los controladores de identidad pertenecen a T10–T12. |
| T04 | Fastify con `/health/live`, `/health/ready`, configuración `GEOPS_DATA_MODE=synthetic`, errores y logging sanitizados, verificación DB/PostGIS/checksum. | **DONE para esqueleto**: 4 pruebas nuevas y prueba real de caída/recuperación DB. Ningún endpoint admin, device o MDM fue implementado. |
| T05 | Dockerfiles, Compose GEOPS aislado, PostGIS 18/3.6, migración SQL versionada con lock/checksum, volumen persistente y health checks. | **DONE en alcance T05**: P03 y la parte fundacional de P04 pasaron. P04 completo sigue pendiente: conservar revocaciones en restore requiere T09/T12 y se cierra en T18. |

## Evidencia ejecutada

- **P01:** `npm ci --ignore-scripts --offline=false --no-audit --no-fund` PASS (136 paquetes). `npm run lint` PASS (18 archivos nuevos, 0 errores); `npm run typecheck` PASS en los tres workspaces; `npm run build` PASS en contratos, API y Web. No se ejecutó CI remoto.
- **P02:** `npm run contracts:check` PASS (OpenAPI 3.1, igualdad semántica con SPEC-01, rutas de identidad y securitySchemes). Contratos: 4/4 PASS; Fastify: 4/4 PASS; regresión OAuth existente: 18/18 PASS. Se verificaron solo las dos rutas health implementadas; las demás rutas son contrato para tareas posteriores.
- **P03:** antes del primer arranque se comprobaron 3500/3501 libres. `geops-api`, `geops-web`, `geops-db` sanos y `geops-migrate` terminó con código 0. GET API live 200, ready 200, Web health 200. Al detener únicamente `geops-db`, ready devolvió 503 en **3452 ms**; al reactivarlo, ready volvió a 200 en **2508 ms**. La API siguió en ejecución tras corregir el manejador de errores de conexiones inactivas. Un marcador ficticio persistió tras reinicio de DB (conteo 1).
- **P04 fundacional:** PostGIS disponible; repetición del migrador aplicó 0 cambios. Se hizo `pg_dump` de la base ficticia, se restauró en `geops_wave0a_restore_test` y se comprobaron marcador/migración/PostGIS = **1/1/1**; se eliminaron base de prueba, tabla marcadora y dump temporal. Alterar temporalmente el checksum de migración produjo ready 503 y migrador exit 1; un bloque `finally` restauró el checksum y ready regresó a 200. La conservación de revocaciones espera T09/T12; P04 completo sigue PENDING.
- **Seguridad:** `git check-ignore -v` confirmó `apps/api/.env.local` e `infrastructure/compose/.env.local` excluidos. La base no publica puerto; API/Web solo escuchan en 127.0.0.1:3500/3501 del host. El secreto sintético de Compose se generó aleatoriamente en archivo ignorado; no se imprime aquí ni en logs. La imagen API excluye archivos OAuth y `.env.local` mediante `.dockerignore`. No se consultó ManageEngine.

## Defectos encontrados y corrección

El health check inicial con `pg_isready` permitió una carrera durante la inicialización de PostGIS; el primer job migrador terminó con código 1. Se cambió a una consulta de PostGIS y se habilitaron hasta tres reintentos del job. La primera prueba de caída de DB reveló que un error de conexión inactiva de `pg` terminaba el proceso API; ahora el pool maneja el evento sin registrar datos internos. Se repitió P03 y pasó con 503/200. Los fallos iniciales quedan registrados; no se presentan como PASS.

## Decisiones y límites

La API de Wave 0A rechaza variables OAuth en su entorno y exige modo sintético; el diagnóstico heredado permanece separado. El migrador usa advisory lock transaccional, versión y SHA-256 del SQL; readiness falla si la base, PostGIS o checksum no están disponibles. No hay tablas de admin, identidad, dispositivos ni datos GPS porque son tareas posteriores. El Web actual es solo bootstrap de React/Vite, no el shell de T16. El contenedor API corre como UID 1000 y Web como UID 101; el health Web y ready API respondieron 200 tras el cambio a Nginx sin privilegios. Un canario sintético en query no apareció ni en la respuesta 404 ni en las últimas 60 líneas de logs API. Los resultados de Docker corresponden a este host Windows/amd64; Linux CI y revisión de seguridad de implementación siguen pendientes. No hay aprobación operativa ni despliegue de producción.

## Validación CI T02 — prepublicación 2026-10-16

Se revisaron los 52 archivos sin seguimiento antes de agregar: nombres, tamaños, alcance y patrones de credenciales. Ningún nombre sensible ni patrón de credencial fue detectado. `apps/api/.env.local` e `infrastructure/compose/.env.local` siguen ignorados y no rastreados. Se revisó el workflow `.github/workflows/wave-0a.yml`: trigger push para esta rama, permisos `contents: read` y pasos `npm ci`, OpenAPI, lint, typecheck, test y build, sin secretos ni despliegue.

| Control local repetido | Resultado |
| --- | --- |
| `npm ci --ignore-scripts --offline=false --no-audit --no-fund` | PASS: 136 paquetes |
| `npm run lint` | PASS: 18 archivos, 0 errores |
| `npm run typecheck` | PASS: API, Web y contratos |
| `npm run build` | PASS: API, Web y contratos |
| `npm test` | PASS: 26 pruebas sintéticas/mock (18 diagnóstico heredado + 4 API + 4 contratos) |
| `npm run contracts:check` | PASS: OpenAPI 3.1 y paridad con SPEC-01 |
| `git diff --check` | PASS |

El commit y el run remoto se registrarán después de publicar la rama con autorización explícita. Hasta entonces T02 y P01 CI siguen PENDING; SPEC-01 conserva su estado y SPEC-00 permanece BLOCKED.
