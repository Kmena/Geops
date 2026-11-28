# W6-R1 — Inventario de staging

Fecha de consulta: 2026-11-28 UTC. Fuente: SSH `geops-staging`, controlador instalado `sudo -n /usr/local/sbin/geops-staging-simple status` y GET HTTPS de solo lectura. Evidencia sanitizada: `output/spec05-wave6-r1/staging-controller-status.json` y `staging-http-probes.json`. No se leyeron variables de entorno sensibles ni se modificaron servicios.

| Elemento | Observado | Límite de evidencia |
| --- | --- | --- |
| Proyecto | `geops-spec02-staging` | Controlador instalado. |
| API | running/healthy; `ghcr.io/kmena/geops-api@sha256:dbf7ec20aa4900a4bdf8487684dda7aeac0c95c99aaa1968770deeffe8f5125f` | Digest activo y referencia reportados; label OCI de revisión no legible con acceso actual. |
| Web | running/healthy; `ghcr.io/kmena/geops-web@sha256:9098f2162c06ebf9d9eedf4d5a5eb9037a4c62129c21322f437230ea592b90a0` | Digest activo y referencia reportados; label OCI pendiente. |
| DB | running/healthy; imagen `postgis/postgis:18-3.6`, ID `sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677` | Tag/ID observados; `SELECT version()` y `PostGIS_Version()` pendientes. |
| Release | controlador: commit de aplicación `b597c9f52f3f53da5e9d9be0fce43351f9eb4561`, promoción del mismo SHA, 2026-11-27T19:57:04Z | El checkout `/opt/geops-staging` está en ese SHA, pero contiene modificación local del Nginx y copia previa sin trackear; no usar el checkout como prueba única de bytes de imagen. |
| Ledger | 40 migraciones; hash de lista `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` | Coincide **exactamente** con el prefijo local 0001–0040. Filas, `applied_at` y DB efectiva pendientes de lectura. |
| Gate | `open`; `recentErrors=[]`; health de los tres servicios `healthy` | No equivale a `/health/ready` externo. |
| Recursos host | raíz 29 GB, 19 GB usados, 9.7 GB libres (66%); RAM 7.7 GiB, disponible 6.4 GiB; 2 vCPU, sin swap | Capacidad de build/restauración requiere dimensionar, no inferir espacio suficiente para dos imágenes + dump. |
| Puertos host | listeners 22, 80, 443, 2500, 5173 y DNS local | Sin Docker inspect no atribuir 2500/5173 a GEOPS. No se observó puerto API/DB publicado. |
| Proxy | archivo del checkout añade `location /v2/` y `/v3/`; `/v1/` también enruta a `geops-api:3500`. HTTPS devuelve JSON de backend en `/v1/*` | Configuración activa exacta de Caddy/Nginx, puertos publicados y labels Compose pendientes de inspección privilegiada. |
| Compose previsto | `geops-api`, `geops-web`, `geops-db` más mantenimiento; DB `geops_dev`, volúmenes `geops_spec02_stage_{pgdata,security,backups}`; redes `geops_spec02_stage_{db,app,edge}` | Son valores de `infrastructure/compose/compose.staging.yaml` del checkout, **no** inventario runtime verificado. |

El usuario SSH `abi` puede ejecutar sin contraseña solo `geops-staging-simple check/status/deploy/rollback`; se usaron únicamente `check/status`. `docker ps`, `docker compose ls` y `docker version` directos devolvieron `permission denied` sobre `/var/run/docker.sock`. No se intentó el `sudo docker` que pide contraseña ni se usó `deploy/rollback`. El [documento único de acciones](WAVE6-R1-OPERATOR-ACTIONS.md) contiene un bloque read-only para obtener labels, volúmenes, redes, DB, ledger y configuración activa faltantes.

## Rutas HTTP observadas

| GET | Resultado | Lectura |
| --- | --- | --- |
| `/health` | 200 `text/plain` `ok` | Health de Nginx Web. |
| `/health/ready` | 200 `text/html` SPA | Fallback web; **no** readiness de API. |
| `/v1/admin/auth/me` | 401 JSON `unauthorized` | Ruta y auth API existentes. |
| `/v1/admin/gps-policies` | 401 JSON `unauthorized` | Ruta GPS administrativa existente. |
| `/v1/device/diagnostics/self` | 404 JSON `not_found` | Contrato SPEC-05 ausente en API activa. |
| `/v1/admin/mdm/workspace/summary` | 404 JSON `not_found` | Contrato Wave 5 ausente en API activa. |
| `/v1/admin/mdm/capabilities` | 404 JSON `not_found` | Contrato Wave 3 ausente en API activa. |

`/v2/device/gps/batches` es POST; no se invocó remotamente por el límite de solo lectura. La existencia de GPS v2 en la fuente base no prueba que el contrato funcione en el runtime instalado.

## Causa de 404 SPEC-05

El commit de aplicación que reporta el controlador es exactamente el HEAD base del worktree. En ese commit no existen `device-diagnostics-routes.ts`, `mdm/policy-routes.ts`, `MdmWorkspace.tsx` ni migraciones 0041/0042; son cambios todavía no integrados en un commit candidato. Los 404 son JSON `not_found` de la API, mientras rutas conocidas en el mismo prefijo `/v1` devuelven 401, lo que descarta un fallo general del proxy y distingue ausencia de ruta de rechazo de autenticación. El bundle web instalado tampoco contiene el marcador `mdm/workspace/summary`. La bandera MDM del Compose visible es `false`, pero no explica por sí sola la ausencia del código API. El inventario privilegiado debe confirmar los labels OCI y el Compose efectivo para cerrar la cadena de procedencia de la imagen.
