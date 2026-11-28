# W6-R2 — Inventario privilegiado de staging

**Inventario informado por el operador; gates pendientes de evidencia del script.** El operador confirmó que `abi` tiene sudo completo mediante contraseña y obtuvo el inventario real. No se alteraron permisos, servicios ni base operativa. El [script único](../../scripts/deploy/simple/spec05_w6r2_operator_rehearsal.py) verificará en el host los digests/labels y las 40 filas con checksum; el dato resumido del operador no basta por sí solo para elevar esos gates a PASS.

Datos informados: proyecto `geops-spec02-staging`, API/Web/PostGIS saludables, commit activo `b597c9f52f3f53da5e9d9be0fce43351f9eb4561`, 40 migraciones, PostgreSQL 18.6/PostGIS 3.6, `geops_dev` 189 MB, RAM disponible 6.4 GiB, disco disponible 9.7 GB, 2 dispositivos, 2 instalaciones GPS, 1327 posiciones y 1 integración MDM. Labels OCI activos confirmados por el operador. Controlador `/opt/geops-simple/staging.py`, wrapper `/usr/local/sbin/geops-staging-simple`, Compose `/opt/geops-simple/bundle/infrastructure/compose`, servicio `geops-backup`, perfil `maintenance`, volumen `geops_spec02_stage_backups` y script `/opt/geops-simple/bundle/infrastructure/staging/backup.sh`.

| Dato | Evidencia actual | Pendiente |
| --- | --- | --- |
| Proyecto Compose | `geops-spec02-staging` por controlador | Confirmar labels de contenedores. |
| API activa | `ghcr.io/kmena/geops-api@sha256:dbf7ec20aa4900a4bdf8487684dda7aeac0c95c99aaa1968770deeffe8f5125f` | Label OCI `revision`, ID local y configuración efectiva. |
| Web activa | `ghcr.io/kmena/geops-web@sha256:9098f2162c06ebf9d9eedf4d5a5eb9037a4c62129c21322f437230ea592b90a0` | Label OCI `revision`, ID local y configuración efectiva. |
| Release reportado | `b597c9f52f3f53da5e9d9be0fce43351f9eb4561` | Corroborar con labels de imágenes y contenedores. |
| DB | `postgis/postgis:18-3.6`, healthy | PostgreSQL/PostGIS efectivos, volúmenes, conteos. |
| Ledger | 40, hash de lista `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` | Las 40 filas con checksum y `applied_at`. |

La [intervención única](WAVE6-R2-OPERATOR-COMMANDS.md) cubre las verificaciones restantes y genera un reporte sanitizado; no compartir `docker inspect .Config.Env`, secretos, dump, tokens, coordenadas ni identificadores personales. El script compara cada fila del ledger con los 40 archivos de la imagen candidata aprobada. Hasta su ejecución, `STAGING_REAL_LEDGER_VERIFIED` y `STAGING_ACTIVE_OCI_LABELS_VERIFIED` permanecen BLOCKED.
