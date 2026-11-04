# SPEC-03 — Cierre de integración y gate de staging

Fecha: 2026-11-04. Estado: **`SPEC03_PUSHED_STAGING_BLOCKED`**.

## Identidad de la integración

| Elemento | Evidencia |
| --- | --- |
| Base de la rama autorizada | `4471f0e8986794e68740fd6f73dd9164825f911f` |
| Reconciliación previa | `1e3fe461123b1dc8d37c15b0fb4382be8062b12e` |
| Corrección de recuperación y pruebas | `dc43617b469c2adf0d3cca6c4359458226e35048` |
| Merge local | `7929ec62f4be13b379cb304d8612a71b714e174b` |
| Rama integrada | `codex/apk-v9-b32-staging-integration` |
| Push | No forzado, `24859e2..7929ec6`; `git ls-remote` confirmó `7929ec62f4be13b379cb304d8612a71b714e174b` |
| SHA desplegado | Ninguno de SPEC-03; staging permanece en `00dbb254d574e64e06fa17e6a3e5b3bc9430fb27` |

El repositorio de trabajo se integró desde la base `4471f0e` sin conflictos. El clon local `b32-promotion` conserva sus 27 modificaciones y archivos sin seguimiento; no se hizo stash, reset ni commit sobre ese clon. Los archivos Nginx no cambiaron por SPEC-03. Las migraciones históricas 0001–0035 no se modificaron respecto a la base de integración.

## Correcciones finales

- `apps/api/src/db/maintenance-recovery.ts`: extiende el catálogo de recuperación a 0040, comprueba orden y checksums, rechaza versiones desconocidas y divergencias de estructura, y protege inventarios operativos GPS/MDM, `client`, `client_site`, rutas y visitas durante la recuperación. La reapertura requiere el esquema 0040 completo.
- `apps/api/test/spec03-maintenance-recovery.integration.mjs`: prueba 0031→0040 y 0035→0040 sobre bases PostgreSQL/PostGIS descartables, incluyendo checksum alterado, fallo inducido antes del commit de 0036, reintento, colisión de objeto, ledger desconocido, vista ausente y gate cerrado ante fallos.
- `apps/api/test/spec03-b32-e2e.integration.mjs`: conserva y amplía la prueba del catálogo único `client`/`client_site` con denegación de permisos, auditoría, actualización selectiva, rollback, confirmación concurrente e idempotencia.

## Migraciones y ledger

El controlador protegido de staging informó **35 migraciones**, gate abierto, API/Web/DB saludables y hash de ledger `58cc3e64c07fbbd7420c68133b965ac33a5af6e1a279d847040b3285052603b2`. El cálculo local de los archivos 0001–0035 dio el mismo hash. El ledger completo propuesto 0001–0040 tiene hash `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf`.

| Archivo nuevo | SHA-256 de contenido |
| --- | --- |
| `0036_kmz_staging.sql` | `1dd00e28a8fd3d398237002ee8533c987b547cdc2e00a13d4cbb9be9d244c2a0` |
| `0037_kmz_analysis.sql` | `c394883a763e8fa5876fdb628e9caecfa2d4c3e5ee20dae64ea39484db428f97` |
| `0038_kmz_review.sql` | `125fb03324faf653f077bd929af1963a352a3f505efbfbc19bc66f4e809f3a45` |
| `0039_kmz_confirmation.sql` | `c6c32b78677612fe266883e7fc9b2e1bee48f72774c4148008da3432680c548d` |
| `0040_kmz_retention.sql` | `d03e2209dec4447355e575934bd91d92e77f6dd6b6ae48c6162e751c7c56cecb` |

Ninguna de 0036–0040 figura en el ledger real de staging. La última comprobación de staging fue de solo lectura; no se ejecutaron migraciones operativas.

## Validaciones

| Gate | Resultado y evidencia |
| --- | --- |
| Recuperación | PASS en bases descartables `geops_verify_1208` (0035→0040) y `geops_verify_1209` (0031→0040), con checksum, fallo inducido, rollback, reintento y gate seguro. |
| Upgrade 0035→0040 | PASS en `geops_verify_1204`; orden, reintento, colisión, checksums y objetos GPS/MDM. |
| E2E KMZ y catálogo único | PASS en `geops_verify_1205`; permisos, aprobación selectiva en `client`/`client_site`, transacción fallida, concurrencia, idempotencia y auditoría. |
| Retención D-06 | PASS en `geops_verify_1205`; `dry-run`, 30 días, limpieza idempotente, fallo y concurrencia; tablas operativas intactas. |
| GPS/MDM | PASS de la regresión anterior de la misma fuente y `npm test` posterior al merge. No se modificaron sus servicios durante el cierre. |
| Suite posterior al merge | `npm test`: PASS. |
| Build / typecheck | `npm run build`: PASS; `npm run typecheck`: PASS. Vite emitió solo aviso de tamaño de chunk. |
| Lint dirigido | `npx biome check` de los tres archivos del cierre: PASS, cero cambios aplicados. |
| Secretos | `npm run security:scan`: PASS, 785 archivos elegibles. |
| Git | Merge sin conflictos, árbol limpio al push, remoto ancestro (9 commits delante, 0 divergentes), push no forzado y SHA remoto confirmado. |

La primera ejecución paralela de `npm test`, build y escaneo fue detenida por `spawn EPERM` del sandbox local; al repetir cada gate con permiso de ejecución de procesos, pasaron. Ese fallo ambiental no corresponde a una regresión del código.

## Gate de despliegue a staging

| Comprobación | Estado |
| --- | --- |
| SHA remoto idéntico al validado | PASS: `7929ec62f4be13b379cb304d8612a71b714e174b` al cierre del push de código. |
| Destino identificado | PASS: proyecto `geops-spec02-staging`, host `geops-staging`. |
| Ledger y checksums base | PASS: 35 migraciones y hash de prefijo idéntico al local. |
| Servicios y gate actuales | PASS: API/Web/DB saludables, gate `open`. |
| Controlador protegido disponible | PARTIAL: `sudo -n /usr/local/sbin/geops-staging-simple check` funciona; el controlador B32 anterior pide contraseña. El controlador simple no se ensayó con el paquete SPEC-03 0035→0040. |
| Imágenes y manifiesto exactos | **BLOCKED**: no hay digests API/Web ni manifiesto de release verificados para `7929ec6`. `.github/workflows/deploy-b32-images.yml` está fijado al SHA `06b6599...` y a 33 migraciones; no publica este commit. |
| Respaldo recuperable actual | NOT VERIFIED: el estado registra un backup de la promoción anterior 0033→0035. La creación y verificación de un backup 0035 previo a SPEC-03 ocurriría dentro del despliegue protegido, que no se inició. |
| Procedimiento de recuperación 0035→0040 | PARTIAL: la recuperación API pasó en laboratorio; falta ensayo del controlador protegido con imágenes y manifiesto exactos. |
| Ausencia de despliegue concurrente | PASS puntual: `check` obtuvo el lock de lectura y concluyó; repetir inmediatamente antes del despliegue. |
| Recursos | PARTIAL: 11 GB libres (65 % de uso) según el controlador; falta confirmar tamaño de imágenes, backup y margen real del paquete SPEC-03. |
| Continuidad GPS/MDM | PASS local; verificación operativa posterior queda pendiente de un despliegue autorizado y ejecutable. |

No se ejecutó `deploy`, no se cargaron imágenes nuevas, no se modificó staging y no hubo smoke tests posteriores a SPEC-03. La ruta de publicación por digest y el ensayo del controlador para 0035→0040 deben completarse antes de reabrir el gate; no se puede sustituir por migraciones manuales ni por el workflow B32 fijado a otro SHA.

## Riesgos y restricciones

- `D05_PRODUCTION_CAPACITY_PENDING`: la capacidad productiva con KMZ real sigue pendiente.
- El aviso de bundle Web grande requiere seguimiento de rendimiento, sin bloquear esta integración local.
- Los 27 cambios del clon operativo siguen fuera del commit integrado; permanecen preservados.
- `PRODUCTION_DEPLOY_AUTHORIZED = NO`.
- `PRODUCTION_MIGRATION_AUTHORIZED = NO`.
