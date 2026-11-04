# SPEC-03 — Coincidencias KMZ por nombre o código en staging

**Estado:** `SPEC03_STAGING_DEPLOY_PASS`  
**Fecha del operador:** 2026-11-04 21:22:47 UTC  
**Proyecto:** `geops-spec02-staging`  
**Operador:** `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` → `/usr/local/sbin/geops-staging-simple`

## Identidad instalada

| Elemento | Valor |
| --- | --- |
| Commit de código y promoción | `71384d06d82901516783f5196b175f3f1c43c8be` |
| Rama local | `codex/spec03-kmz-proximity-classification` |
| SHA anterior en staging | `2e338d646f32582247cd0e7d2b055d89ba3daf38` |
| API | `ghcr.io/kmena/geops-api@sha256:9822ac47f95612f127e61fbea4d0ce24bef0b0fafa0bdc451963e95b24c88943` |
| Web | `ghcr.io/kmena/geops-web@sha256:35dc5855135f74a92c31f4d55181a45700d7a35369b3a2167bf310bdf269296f` |
| Manifiesto | `spec03-name-code-or-staging-release.json` |
| SHA-256 del manifiesto transferido al operador (CRLF) | `90f3b75cfc69879118c74a937848fd5cefcdace1eda458445493d93613a08363` |
| SHA-256 del manifiesto normalizado en Git (LF) | `b5973452e1e870bf7f5e1381509c76102a915bae6a33cc74cef946ddf8621de3` |
| Ledger | 40 migraciones, SHA-256 `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` |

Las imágenes se construyeron desde el árbol rastreado del commit indicado, sin cambios rastreados pendientes. Los Dockerfiles copian rutas concretas y `.dockerignore` excluye `specs/`; el JSON local previo sin seguimiento no ingresó al contexto efectivo. Ambas imágenes son `linux/amd64`, llevan `org.opencontainers.image.revision` igual al commit y las variantes B32 exigidas. Web lleva `org.geops.web.mdm_enabled=true`. Las fechas de construcción registradas por Docker son 2026-11-04 21:18:46 UTC (API) y 21:19:13 UTC (Web). Los digests remotos se confirmaron con `docker buildx imagetools inspect` después de publicar.

## Cambio y gates

- La clasificación marca `POSSIBLE_DUPLICATE` si coincide exactamente el nombre normalizado **o** el código de referencia. Cercanía, nombre solo parecido y coordenadas idénticas sin nombre ni código igual permanecen como contexto o advertencia. La coincidencia automática con un cliente existente requiere evidencia más fuerte: nombre y código iguales, o identificador GEOPS explícito.
- La validación de operaciones aprobadas comprueba nombre o código repetidos dentro del plan y contra el catálogo. La Web nombra la señal `CUSTOMER_CODE` y explica el bloqueo por nombre o código.
- El SHA instalado previamente es ancestro del nuevo commit. No cambió ningún SQL entre ellos. El manifiesto tiene los seis campos del contrato oficial y las mismas 40 entradas ordenadas del release anterior.
- Lint dirigido, typecheck API/Web, build API/Web, pruebas unitarias del comparador y de la guía Web, y E2E SPEC-03 sobre PostGIS descartable: PASS. El E2E cubrió coincidencia solo por nombre, solo por código, cercanía sin coincidencia, validación final, permisos, creación, actualización, rollback y reintento.
- Escaneo de secretos: PASS, 796 archivos elegibles. La imagen API contiene 40 migraciones con el hash del ledger arriba indicado.
- Preflight del operador: API, Web y DB saludables; gate abierto; ledger `0040`; 9.9 GB disponibles. El operador usa un lock exclusivo para impedir despliegues concurrentes.

## Despliegue y smoke

El operador simple validó Compose y el manifiesto, descargó e inspeccionó las imágenes por digest, verificó sus etiquetas y el inventario de migraciones de la API, actualizó API/Web y emitió `deployment.success` con 40 migraciones. Al no cambiar el esquema no ejecutó migraciones ni creó respaldo de esquema (`backup: null`). El estado posterior confirmó los dos digests instalados, los tres servicios `healthy`, gate `open`, ledger sin cambios y `recentErrors: []`.

Desde el host de staging, `GET /` y `GET /health` devolvieron 200. Las rutas protegidas `/v1/admin/kmz-imports`, `/v1/admin/gps-capabilities`, `/v1/admin/routes` y `/v1/admin/mdm/status` devolvieron 401 sin sesión. La Web sirvió el bundle `index-SkTclmdv.js` con los textos nuevos de código y duplicado. Una carga sintética sin sesión de 2 MiB devolvió 401, no 413. No se importó ni confirmó ningún cliente real durante estos smoke tests.

No hubo push Git ni despliegue a producción. El archivo local previo sin seguimiento `spec03-name-staging-release.json` permaneció intacto.
