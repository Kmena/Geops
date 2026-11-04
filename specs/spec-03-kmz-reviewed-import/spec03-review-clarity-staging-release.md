# SPEC-03 — Publicación de claridad de revisión KMZ a staging

**Estado:** `SPEC03_STAGING_DEPLOY_PASS`

**Fecha:** 2026-11-04 19:28:43 UTC

**Entorno:** `geops-spec02-staging`

**Operador:** `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` → `/usr/local/sbin/geops-staging-simple`

## Identidad del release

| Elemento | Valor |
| --- | --- |
| Commit de código y promoción | `01eafb4486402d6d9497aa3caef9e44f042a30a2` |
| Rama publicada | `codex/spec03-kmz-review-clarity` |
| API | `ghcr.io/kmena/geops-api@sha256:22076a4a2ebd23a0a9798d7b9e17c012aedb90bd7faf1bec03817069a374e605` |
| Web | `ghcr.io/kmena/geops-web@sha256:e6fd30aab2604a20d94fb7a3e160bdaff7866530f2c8e883cb7d408b2b984525` |
| Manifiesto | `spec03-review-clarity-staging-release.json` |
| SHA-256 del manifiesto | `902b4fa3fe38128716a43fc682d0ba7302cb071b2ef4f54ead925133128e0b14` |
| Ledger | 40 migraciones, `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` |

Los digests de las etiquetas publicadas se verificaron en GHCR con `docker buildx imagetools inspect`. Las imágenes locales son `linux/amd64` y llevan `org.opencontainers.image.revision` igual al commit. La imagen API incluye las 40 migraciones con el hash indicado. El manifiesto contiene exactamente los seis campos del contrato del operador simple y las mismas 40 entradas de migración, sin cambios de SQL.

## Gates previos

- `git` confirmó que el commit anterior instalado (`3b3d618f32fdc9c91da1cf32638d2d49afba1dab`) es ancestro del nuevo commit y que el código de construcción no tenía cambios rastreados pendientes. El archivo local previo `spec03-name-staging-release.json` permaneció intacto.
- Lint dirigido, typecheck, build API/Web, 59 pruebas Web, 11 pruebas W2/W3 y escaneo de secretos: PASS.
- Regresión E2E SPEC-03 sobre PostGIS descartable: PASS; comprobó permisos, cliente/sede canónicos, actualización selectiva, rollback, concurrencia y reintento. Las dos consultas SQL nuevas de comparación y progreso de ruta ejecutaron sobre el esquema 0040. El laboratorio se retiró.
- Preflight del operador simple: tres servicios saludables, gate abierto, ledger 0040 compatible, disco con 10 GB disponibles y sin error reciente ni despliegue concurrente.

## Resultado del operador y smoke tests

El operador verificó configuración Compose, descargó e inspeccionó ambas imágenes por digest, confirmó el catálogo SQL de la API, actualizó API/Web y emitió `deployment.success` con 40 migraciones. No hubo migraciones nuevas ni respaldo de esquema (`backup: null`); la base permaneció en 0040. El estado posterior confirmó los digests indicados, API/Web/DB `healthy`, gate `open` y sin errores recientes.

Pruebas HTTP sin sesión: `/` y `/health` devolvieron 200; `/v1/admin/kmz-imports`, `/v1/admin/gps-capabilities`, `/v1/admin/routes` y `/v1/admin/mdm/status` devolvieron 401. El bundle Web servido contiene las nuevas opciones “Definir rutas”, “Preparar vínculo con este cliente” y “Preparar creación de ruta”. Una carga sintética sin credenciales de 2 MiB devolvió 401, lo que confirma que el proxy ya no la rechaza con 413. No se importaron ni confirmaron clientes reales.

## Límite de verificación

No se probó visualmente la revisión con una sesión administrativa real después de este despliegue. La comprobación interactiva de los datos de Nicoya y las rutas queda para la persona administradora. No se desplegó a producción.
