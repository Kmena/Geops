# Staging 1: despliegue manual GPS/alertas con MDM deshabilitado

**Alcance:** rama `codex/geops-integration`, imagen con catálogo 0001–0018. Este documento prepara una operación manual futura; no registra acceso al servidor ni autorización de despliegue. No ejecutar `scripts/staging/clean-reinstall-0015.sh`, `geops-migrate` ni `gate init` sobre la base persistente. No usar `compose.staging.mdm.override.yaml` en Staging 1.

## Datos que el operador debe confirmar en el servidor

- Ruta real del checkout de GEOPS Staging y archivo privado de variables Compose. No se deducen del repositorio.
- SHA exacto publicado y aprobado, SHA anterior, árbol Git limpio y ausencia de divergencia con `origin/codex/geops-integration`.
- Proyecto Compose `geops-spec02-staging`, servicios y volúmenes de `infrastructure/compose/compose.staging.yaml`, red externa `geops_spec02_stage_edge`, hostname `geops-staging.duckdns.org` y estado de Caddy. No modificar Caddy.
- Versión efectiva del ledger `geops_schema_migrations` (14–18), checksums, gate `open`, epoch, integridad de la base y custodios vigentes. Si el estado no coincide con el catálogo esperado, detenerse.
- Respaldo privado y ensayo de restauración en una base PostGIS aislada. No copiar secretos/sesiones a un entorno público; mantener la copia en cuarentena. Si no hay destino aislado, detener el cambio.
- Aprobación operativa y de seguridad aplicable a esta versión. El resultado local/CI no constituye autorización para operar.

## Preflight y respaldo (comandos de referencia; **no ejecutados por Codex**)

El operador asigna `GEOPS_CHECKOUT` y `STAGE_ENV` a las rutas existentes, sin crear rutas supuestas. Desde ese checkout, usar exclusivamente el Compose base:

```sh
cd "$GEOPS_CHECKOUT"
git status --short --branch
git rev-parse HEAD
git remote -v
git fetch origin codex/geops-integration
git rev-parse origin/codex/geops-integration
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml config --quiet
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml ps
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml exec -T geops-db psql -U geops_stage -d geops_dev -Atc 'SELECT version FROM geops_schema_migrations ORDER BY version'
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml --profile maintenance run --rm geops-backup
```

Antes de cambiar Git, guardar el SHA anterior y comprobar árbol limpio. El backup del servicio `geops-backup` escribe un dump `pg_dump -Fc` y su SHA-256 en `geops_spec02_stage_backups`; verificar ambos desde ese volumen sin exponerlos. Inspeccionar el archivo con `pg_restore -l` y **restaurarlo de verdad** en una base PostGIS privada y descartable, distinta de `geops_dev`; verificar tablas, ledger, filas representativas y que las identidades restauradas permanezcan en cuarentena. Un listado de archivo o un checksum por sí solos no prueban restauración. No restaurar encima de la base activa.

## Cambio de código e imágenes

Solo con preflight y restore satisfactorios, confirmar que el SHA aprobado es el remoto, cambiar el checkout limpio a ese commit y construir imágenes inmutables. Guardar `PREVIOUS_SHA` fuera del repositorio; sustituir `<SHA_APROBADO>` por el SHA publicado tras CI.

```sh
git switch --detach <SHA_APROBADO>
test "$(git rev-parse HEAD)" = '<SHA_APROBADO>'
test -z "$(git status --porcelain)"
export GEOPS_STAGE_IMAGE_TAG='<SHA_APROBADO>'
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml config --quiet
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml build geops-api geops-web
```

El checkout puede estar en detached HEAD. No utilizar `git reset --hard`, `git clean`, `down -v` ni los overlays de MDM. Revisar el `config` resultante: `geops-api.environment.MDM_ENABLED=false`, `geops-web.build.args.MDM_ENABLED=false`, ningún secreto OAuth de ManageEngine montado ni red `stage_egress`. Los seis secretos base incluyen `mdm_grant_key` para el esquema local legado; **no** es un refresh token ManageEngine. La API rechaza credenciales OAuth reales cuando MDM está deshabilitado.

## Mantenimiento supervisado de la base persistente

Seguir [recuperación 14–18](recovery-14-18-report-2026-10-21.md) y el [runbook de recuperación](migration-0015-safe-recovery-2026-10-20.md), cuya sección 14–17 es histórica para esta imagen. Obtener solo el epoch del gate existente mediante inspección autorizada del volumen `geops_spec02_stage_security`; no imprimir nonce ni copiar el gate. Comparar epoch con `security_epoch` en la base. Configurar `GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev` y `GEOPS_CONFIRM_MAINTENANCE_EPOCH` con el valor **observado**, no uno nuevo.

1. Detener únicamente `geops-web` y `geops-api` de este Compose. Confirmar cero conexiones ajenas a `geops_dev` y que el respaldo/restore terminó. Con imagen nueva ya construida, ejecutar una sola vez `geops-gate-init gate maintenance-start` con las dos variables de confirmación. Verificar fase `maintenance`, marcador, OID, nonce y epoch con `gate maintenance-verify`.
2. Con aprobación explícita, ejecutar **interactivamente** `geops-gate-init maintenance-recover <principal> <custodio1> <custodio2> <UUID nuevo> <motivo>`, pasando `GEOPS_CONFIRM_FORWARD_RECOVERY=YES` y `GEOPS_CONFIRM_COMPATIBLE_RELEASE=YES` además de las variables anteriores. El CLI solicita las tres contraseñas sin eco; nunca incluirlas en argumentos, variables, historial o logs. El servicio tiene el gate escribible; `geops-migrate` lo monta solo lectura y no es el camino autorizado.
3. Si el estado previo era 14–17, el comando aplica solo las migraciones faltantes hasta 18. Si ya era 18, valida sin reaplicar. Comprobar 18 versiones/checksums, tablas e índices, datos existentes, auditoría y gate `open` con el **mismo epoch**. Un fallo deja API/Web detenidas; preservar volúmenes y evidencia. Para reintentar, diagnosticar primero y usar ceremonia y UUID nuevos. Nunca usar `maintenance-finish` para `geops_dev` ni abrir el gate a mano.

Forma del comando de mantenimiento (variables exportadas por el operador; no usar contraseñas en shell):

```sh
export GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev
export GEOPS_CONFIRM_MAINTENANCE_EPOCH='<epoch-observado>'
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml stop geops-web geops-api
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml --profile maintenance run --rm --no-deps -e GEOPS_CONFIRM_MAINTENANCE_TARGET -e GEOPS_CONFIRM_MAINTENANCE_EPOCH geops-gate-init gate maintenance-start
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml --profile maintenance run --rm --no-deps -e GEOPS_CONFIRM_MAINTENANCE_TARGET -e GEOPS_CONFIRM_MAINTENANCE_EPOCH geops-gate-init gate maintenance-verify
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml --profile maintenance run --rm --no-deps --interactive -e GEOPS_CONFIRM_MAINTENANCE_TARGET -e GEOPS_CONFIRM_MAINTENANCE_EPOCH -e GEOPS_CONFIRM_FORWARD_RECOVERY=YES -e GEOPS_CONFIRM_COMPATIBLE_RELEASE=YES geops-gate-init maintenance-recover '<principal>' '<custodio1>' '<custodio2>' '<UUID-nuevo>' 'Staging 1 GPS y alertas'
```

Antes del primer comando, verificar con una consulta de `pg_stat_activity` que API/Web están detenidas y no quedan conexiones ajenas. Si el gate ya está en `maintenance`, **no repetir `maintenance-start`**: usar el procedimiento de recuperación desde el estado observado.

## Arranque y aceptación

Arrancar solo la API de este Compose, verificar `geops-db` y `geops-api` saludables, luego Web. No recrear PostgreSQL, gate, volúmenes, Caddy ni otros proyectos.

```sh
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml up -d --no-deps geops-api
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml ps geops-db geops-api
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml exec -T geops-api node -e "fetch('http://127.0.0.1:3500/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml up -d --no-deps geops-web
docker compose --env-file "$STAGE_ENV" -f infrastructure/compose/compose.staging.yaml ps geops-web
```

El operador debe comprobar HTTPS y login de `geops-staging.duckdns.org`, políticas/asignaciones, dispositivos/inscripción, sesiones, posiciones, telemetría y alertas de continuidad con el tenant autorizado. Confirmar que el menú MDM no aparece ni provoca solicitudes, que los siete endpoints MDM dan `mdm_disabled` (503) **con sesión administrativa válida** y 401 sin ella, que no hay timer de inventario ni solicitudes OAuth, y que un reinicio controlado de API/Web conserva `MDM_ENABLED=false`. Comprobar salud no demuestra por sí sola funcionamiento GPS ni alertas. La validación física y la seguridad independiente mantienen sus gates propios.

## Fallos y reversión

- **Antes de migrar:** conservar el backup y retornar al SHA/imágenes anteriores únicamente si el gate y el ledger permanecen compatibles; verificar autenticación y salud.
- **Gate en mantenimiento o migración parcial confirmada:** mantener API/Web detenidas y gate cerrado. Reanudar mediante `maintenance-recover` con el mismo binario compatible, verificaciones completas y UUID nuevo. No bajar a una imagen cuyo catálogo termine antes de 0018 después de migrar.
- **Después de 0018 y apertura:** detener API/Web si hay incompatibilidad, iniciar nuevo mantenimiento supervisado con el binario compatible y aplicar corrección hacia adelante. Restaurar backup solo en entorno aislado con cuarentena, rotación de credenciales y nuevo epoch siguiendo el protocolo de restore; nunca sobreescribir `geops_dev` ni copiar un gate antiguo.
- No retirar volúmenes ni ejecutar `down -v`. No reiniciar PoC, Inventori, Billing o Caddy.
