# SPEC-03 — Coincidencias por código y publicación a staging

**Resultado:** `SPEC03_STAGING_DEPLOY_PASS`
**Código desplegado:** `6445e328081f8b630f3bc93cdffc0e3e8e8d1fb0`
**Rama publicada:** `codex/spec03-kmz-proximity-classification`
**Destino:** `geops-spec02-staging`
**Manifiesto:** `spec03-distinct-code-staging-release.json`

## Cambio

- La comparación separa registros que ya existen en GEOPS, registros del mismo KMZ cuyo único indicio de duplicado es el código y otros indicios del KMZ. Conserva la regla aprobada de que nombre igual **o** código igual marca una posible coincidencia.
- Para códigos repetidos con nombres distintos, el administrador puede editar el código propuesto o elegir dos sugerencias con sufijos (`16-A`, `16-B`, etc.). La sugerencia solo prepara la revisión; el servidor comprueba unicidad y permisos en la validación y confirmación.
- Las distancias largas se muestran en kilómetros para que una coincidencia de código entre ubicaciones lejanas no parezca un punto cercano.
- No se cambiaron migraciones ni el comparador de duplicados del API.

## Validación previa

| Gate | Resultado |
| --- | --- |
| Lint dirigido, lint del repositorio y `git diff --check` | PASS; 12 advertencias preexistentes de non-null assertion en GPS, sin errores. |
| Typecheck API/Web y build API/Web | PASS; Vite informó tamaño del chunk Web. |
| Suite `npm test` | PASS. |
| Suite Web | PASS: 62 pruebas. |
| E2E SPEC-03 en PostgreSQL/PostGIS descartable | PASS: confirmó un cliente con código `16-A`, además de la creación con código interno y los controles previos de rollback, permisos, concurrencia e idempotencia. |
| Contratos y escaneo de secretos | PASS. |
| Detector visual Impeccable | PASS después de ajustar los bordes de los grupos. |
| Git remoto | PASS: rama publicada. GitHub Actions no ejecutó un workflow para ese SHA porque los workflows configurados no incluyen esta rama. |

## Artefactos y operador

| Artefacto | Digest GHCR verificado |
| --- | --- |
| API | `ghcr.io/kmena/geops-api@sha256:6cd61da0420ffbd44f0ec3550ec6834452c073bb8c58aee01d9a5e9091b17989` |
| Web | `ghcr.io/kmena/geops-web@sha256:0dd93fe520b88654529c634c6bedf8fdfb9da3585e4de4430dddca5407063611` |

Las dos imágenes son `linux/amd64`, llevan la etiqueta de revisión con el SHA completo y fueron inspeccionadas en GHCR. La imagen API incluye las 40 migraciones, hasta `0040_kmz_retention.sql`. El manifiesto contiene los checksums de cada SQL y el hash de ledger `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf`; SHA-256 del archivo de manifiesto: `e925b4b83c691eb47f0186d43a378835d556072fb7d2594500bd9afb16da73ea`.

Se utilizó exclusivamente `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` del clon operativo, que invoca `/usr/local/sbin/geops-staging-simple`. El preflight informó gate abierto, esquema 0040, ledger esperado y API/Web/DB saludables. El operador registró `deployment.success` el 2026-11-04 a las 22:31:02 UTC. Como la promoción conservó 40 migraciones, no ejecutó migraciones nuevas ni creó respaldo de base.

## Verificación posterior

- `status staging`: commit y ambos digests instalados coinciden con el manifiesto; gate `open`, API/Web/DB `healthy`, 40 migraciones y hash de ledger esperado, sin errores recientes.
- HTTP desde el host staging: `/` y `/health` devolvieron 200; rutas administrativas KMZ, GPS, rutas y MDM devolvieron 401 sin sesión, como corresponde.
- El bundle servido `/assets/index-B9DI9dww.js` contiene «Solo código repetido en este KMZ».
- No se confirmaron clientes reales ni se importó un KMZ durante los smoke tests.
- Producción no está autorizada.
