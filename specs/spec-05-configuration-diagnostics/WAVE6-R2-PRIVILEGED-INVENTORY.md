# W6-R2 — Inventario privilegiado de staging

**Estado: BLOCKED para lectura privilegiada.** La evidencia de W6-R1 ya confirma proyecto `geops-spec02-staging`, gate `open`, API/Web/PostGIS healthy, 40 migraciones y los digests activos. El usuario SSH `abi` solo dispone de `sudo -n geops-staging-simple check/status/deploy/rollback`; el socket Docker directo devuelve `permission denied`. No se alteraron permisos, servicios ni base operativa. Fuente: [inventario W6-R1](WAVE6-R1-STAGING-INVENTORY.md) y `output/spec05-wave6-r1/staging-controller-status.json`.

| Dato | Evidencia actual | Pendiente |
| --- | --- | --- |
| Proyecto Compose | `geops-spec02-staging` por controlador | Confirmar labels de contenedores. |
| API activa | `ghcr.io/kmena/geops-api@sha256:dbf7ec20aa4900a4bdf8487684dda7aeac0c95c99aaa1968770deeffe8f5125f` | Label OCI `revision`, ID local y configuración efectiva. |
| Web activa | `ghcr.io/kmena/geops-web@sha256:9098f2162c06ebf9d9eedf4d5a5eb9037a4c62129c21322f437230ea592b90a0` | Label OCI `revision`, ID local y configuración efectiva. |
| Release reportado | `b597c9f52f3f53da5e9d9be0fce43351f9eb4561` | Corroborar con labels de imágenes y contenedores. |
| DB | `postgis/postgis:18-3.6`, healthy | PostgreSQL/PostGIS efectivos, volúmenes, conteos. |
| Ledger | 40, hash de lista `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` | Las 40 filas con checksum y `applied_at`. |

El [bloque único para operador](WAVE6-R2-OPERATOR-COMMANDS.md) cubre las lecturas restantes. Compartir salida sanitizada; no compartir `docker inspect .Config.Env`, archivos de secretos, dump, tokens, coordenadas ni identificadores personales. Si el operador entrega los resultados, contrastar cada fila del ledger con los archivos del SHA `809bb0678feaefdbbe8006a1ba05325ccb1ad0a8` antes de marcar PASS.
