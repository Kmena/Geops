# W6-R2 — Respaldo real de staging

**STAGING_REAL_BACKUP_PASS = BLOCKED.** El acceso SSH disponible no puede invocar Docker ni leer el volumen protegido. `lastDeployment.backup=null` en el estado del controlador solo describe esa promoción; no acredita ausencia de otros respaldos. No se creó ni copió un dump real.

El operador autorizado debe comprobar espacio libre, proyecto Compose, DB/volumen efectivos y procedimiento vigente. El script existente [`infrastructure/staging/backup.sh`](../../infrastructure/staging/backup.sh) ejecuta `pg_dump -Fc` con contraseña desde secreto montado, `umask 077`, guarda en volumen `stage_backups` y crea `.sha256`. Invocarlo **mediante el flujo de administración protegido** para el proyecto efectivo; no introducir contraseña en shell ni chat. Guardar aparte, en almacenamiento protegido, una copia de Compose, configuración de proxy, referencias de imágenes por digest, ledger, inventario de volúmenes/redes y referencias a secretos (sin valores). Registrar responsable y hora UTC.

| Metadato requerido | Valor |
| --- | --- |
| Fecha/hora UTC, operador y ubicación protegida | PENDIENTE |
| Archivo dump, tamaño y SHA-256 | PENDIENTE |
| `pg_restore --list` y verificación de checksum | PENDIENTE |
| PostgreSQL, PostGIS, esquema 0040 y ledger | PENDIENTE |
| Compose/proxy efectivos, volumen DB y backups | PENDIENTE |
| Digests API/Web/DB activos | API/Web en [inventario](WAVE6-R2-PRIVILEGED-INVENTORY.md); verificar runtime |

No guardar dump, secretos, coordenadas, datos de personas ni manifiestos que los contengan en este repositorio. Un hash y `pg_restore --list` prueban integridad del archivo, no recuperabilidad funcional; ésta requiere el [ensayo aislado](WAVE6-R2-RESTORE-REHEARSAL.md).
