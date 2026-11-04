# SPEC-03 — Aclaración del origen de coincidencias en staging

**Estado:** `SPEC03_STAGING_DEPLOY_PASS`  
**Fecha del operador:** 2026-11-04 22:07:03 UTC  
**Proyecto:** `geops-spec02-staging`  
**Operador:** `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` → `/usr/local/sbin/geops-staging-simple`

## Identidad

| Elemento | Valor |
| --- | --- |
| Commit de código y promoción | `998152b369c78b2e0ddf015584c3332194644141` |
| Commit anterior instalado | `71384d06d82901516783f5196b175f3f1c43c8be` |
| API | `ghcr.io/kmena/geops-api@sha256:d3c14d23cd3ed2ea2ee75ea73de971148dbe6e2d3e014fb2c8bee2448c39ce9c` |
| Web | `ghcr.io/kmena/geops-web@sha256:a6042b87eaf55bd9458cb1a6f48cb6346b1741e177926db8222c298c47a9a14d` |
| Manifiesto | `spec03-catalog-origin-staging-release.json` |
| SHA-256 del manifiesto | `a7bbde3d5e2f35feef77982ca8e03252c81de88bdbd28bd340b523b03d76390b` |
| Ledger | 40 migraciones, SHA-256 `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` |

## Cambio y validación

Solo cambió el texto de la revisión Web: el panel dice «Ningún cliente de GEOPS seleccionado» cuando no hay una selección y explica que «Otro registro del KMZ» pertenece al archivo, mientras «Cliente existente» pertenece al catálogo. La regla de coincidencias por nombre **o** código no cambió. El SHA anterior es ancestro del nuevo y no cambió ningún archivo API ni SQL.

Las imágenes `linux/amd64` llevan `org.opencontainers.image.revision` igual al commit, variante `B32-integrated` y Web MDM habilitado. Los digests publicados se confirmaron en GHCR con `docker buildx imagetools inspect`. La API contiene 40 migraciones con el hash esperado. Lint dirigido y typecheck Web: PASS. Build Docker de API/Web: PASS. Escaneo de secretos: PASS, 798 archivos elegibles.

El preflight del operador simple encontró API, Web y DB saludables, gate abierto, ledger 0040 compatible y 9.9 GB libres. El operador validó el manifiesto, descargó ambas imágenes por digest, verificó etiquetas e inventario de migraciones y emitió `deployment.success`. No aplicó migraciones ni creó un respaldo de esquema porque el ledger no cambió (`backup: null`). El estado posterior confirmó los digests instalados, los tres servicios `healthy`, gate `open` y `recentErrors: []`.

Smoke HTTP desde el host de staging: `/` y `/health` devolvieron 200; `/v1/admin/kmz-imports`, `/v1/admin/gps-capabilities`, `/v1/admin/routes` y `/v1/admin/mdm/status` devolvieron 401 sin sesión. La Web sirvió `index-CtkZI6_X.js` con el texto «Ningún cliente de GEOPS seleccionado». No se importaron ni confirmaron registros reales durante el despliegue. No hubo push Git ni despliegue a producción; el JSON local previo sin seguimiento permaneció intacto.
