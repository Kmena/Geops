# SPEC-03 — Confirmación selectiva en staging

**Estado:** `SPEC03_STAGING_DEPLOY_PASS`  
**Fecha:** 2026-11-04 20:32:02 UTC  
**Proyecto:** `geops-spec02-staging`  
**Operador:** `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` → `/usr/local/sbin/geops-staging-simple`

## Identidad instalada

| Elemento | Valor |
| --- | --- |
| Commit de código y promoción | `2e338d646f32582247cd0e7d2b055d89ba3daf38` |
| Rama local | `codex/spec03-kmz-selective-confirmation` |
| API | `ghcr.io/kmena/geops-api@sha256:c38b9aae961a1fefb9b5d0cdb9d2582b1fba8162e5acb3d0702b7bd284da108f` |
| Web | `ghcr.io/kmena/geops-web@sha256:38da806997b750add8692d825f8341036082981c213b261335e860b4ad512087` |
| Manifiesto | `spec03-selective-confirmation-staging-release.json` |
| SHA-256 del manifiesto | `f372c4273848492eb8a065d8634eb857f6dd15d82793320fee867b00e956ccc56` |
| Ledger | 40 migraciones; SHA-256 `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` |

Los digests publicados se verificaron en GHCR. Las imágenes locales son `linux/amd64`, llevan `org.opencontainers.image.revision` igual al SHA de código y las variantes B32 esperadas. La API contiene 40 migraciones con el hash anterior. El diff de migraciones desde el SHA instalado previamente `c99f6981796fc0d1000f075bba68bb05e697a352` es vacío. No se ejecutaron migraciones.

## Cambio y validación

La validación ya no bloquea la confirmación por registros `PENDING` con estado `CONFLICT` o `INVALID`: no tienen una operación aprobada. La aplicación sigue omitiendo todos los `PENDING`. Una operación aprobada inválida continúa bloqueada. La pantalla indica que los pendientes no se incorporan y que la revisión se cierra al aplicar la importación.

- E2E SPEC-03 en PostGIS local descartable: PASS. Comprobó pendientes en conflicto e inválidos fuera de las operaciones, bloqueo de una creación aprobada inválida, creación y actualización selectiva, rollback inducido, concurrencia y reintento. El laboratorio se retiró.
- Lint dirigido, typecheck y build API/Web: PASS.
- Suite Web: 61/61 PASS. Escaneo de secretos: PASS (794 archivos elegibles).
- Preflight del operador simple: tres servicios saludables, gate abierto, ledger 0040 y 9.9 GB disponibles.

## Despliegue y smoke

El operador simple validó el manifiesto, descargó las imágenes por digest, comprobó sus etiquetas y el inventario SQL de la API, actualizó API/Web y emitió `deployment.success`. El estado posterior confirmó los digests de la tabla, tres servicios `healthy`, gate `open`, 40 migraciones y ningún error reciente. Al no cambiar el esquema, el operador registró `backup: null`.

HTTP sin sesión: `/` y `/health` devolvieron 200; las rutas protegidas KMZ, GPS y catálogo devolvieron 401. El bundle Web servido incluye los textos nuevos de confirmación selectiva y el flujo de creación. No se ejecutó validación autenticada de la revisión real ni se confirmaron clientes, rutas o visitas. El administrador debe recargar la página y volver a pulsar **Validar decisiones para confirmar**; el resultado dependerá de las decisiones vigentes en la base al momento de validar.

No hubo push Git ni despliegue a producción.
