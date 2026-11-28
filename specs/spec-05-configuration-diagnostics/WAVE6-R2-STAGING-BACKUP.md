# W6-R2 — Respaldo real de staging

**STAGING_BACKUP_PASS = BLOCKED hasta ejecutar el script.** El operador confirmó acceso sudo con contraseña para `abi`, pero todavía no hay dump nuevo ni verificación de su integridad. `lastDeployment.backup=null` solo describe esa promoción; no acredita ausencia de otros respaldos.

El [script único de operador](../../scripts/deploy/simple/spec05_w6r2_operator_rehearsal.py) verifica espacio libre, proyecto Compose, DB/volumen efectivos y procedimiento vigente antes de invocar el servicio protegido `geops-backup` con `--profile maintenance --no-deps`. El script existente [`infrastructure/staging/backup.sh`](../../infrastructure/staging/backup.sh) ejecuta `pg_dump -Fc` con contraseña desde secreto montado, `umask 077`, guarda en el volumen `stage_backups` y crea `.sha256`. No introducir contraseña en shell ni chat. Se conserva el dump en el volumen protegido; el reporte privado registra tamaño, fecha UTC, SHA-256 y resultado de `pg_restore --list`.

Se leyeron **solo los archivos de código** en `/opt/geops-staging`: `backup.sh` SHA-256 `b6784af0ac4c6180e65b981a963b33ea79d2f4902ace966c2c23e99b02f6ef6f` y `compose.staging.yaml` SHA-256 `165865879bd3037c03ca4b033f3ea1a9ad283d45ae4c43439e7163adcf6248f4`; ambos coinciden byte a byte con este checkout. El servicio `geops-backup` usa `postgis/postgis:18-3.6`, secreto `db_password`, red `stage_db` y volumen `stage_backups`. La configuración efectiva y el archivo privado de variables se validarán durante la ejecución con la ruta `STAGE_ENV` local del operador.

| Metadato requerido | Valor |
| --- | --- |
| Fecha/hora UTC, operador y ubicación protegida | PENDIENTE |
| Archivo dump, tamaño y SHA-256 | PENDIENTE |
| `pg_restore --list` y verificación de checksum | PENDIENTE |
| PostgreSQL, PostGIS, esquema 0040 y ledger | PENDIENTE |
| Compose/proxy efectivos, volumen DB y backups | PENDIENTE |
| Digests API/Web/DB activos | API/Web en [inventario](WAVE6-R2-PRIVILEGED-INVENTORY.md); verificar runtime |

No guardar dump, secretos, coordenadas, datos de personas ni manifiestos que los contengan en este repositorio. Un hash y `pg_restore --list` prueban integridad del archivo, no recuperabilidad funcional; ésta requiere el [ensayo aislado](WAVE6-R2-RESTORE-REHEARSAL.md).
