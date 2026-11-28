# W6-R2 — Comandos de operador

## A. Único bloque de inventario privilegiado, solo lectura

Ejecutar en `geops-staging` **por un operador con sudo Docker ya autorizado**. Revisar y sanitizar la salida antes de compartirla. No ejecutar con la cuenta `abi` si sudo pide contraseña, no modificar grupos/sudoers y no imprimir `.Config.Env` completa ni secretos. Este bloque complementa los datos ya obtenidos por el controlador.

```bash
set -eu
project=geops-spec02-staging
echo '== UTC / project / containers / health =='
date -u +%FT%TZ
sudo docker compose ls --format json
sudo docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'
echo '== selected runtime identity, OCI labels and non-secret configuration =='
for cid in $(sudo docker ps -q --filter "label=com.docker.compose.project=$project"); do
  sudo docker inspect --format '{{.Name}}|service={{index .Config.Labels "com.docker.compose.service"}}|imageID={{.Image}}|readOnly={{.HostConfig.ReadonlyRootfs}}|memory={{.HostConfig.Memory}}|cpus={{.HostConfig.NanoCpus}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid"
  image_id=$(sudo docker inspect --format '{{.Image}}' "$cid")
  sudo docker image inspect --format '{{.Id}}|repoDigests={{json .RepoDigests}}|revision={{index .Config.Labels "org.opencontainers.image.revision"}}|apiVariant={{index .Config.Labels "org.geops.api.variant"}}|webVariant={{index .Config.Labels "org.geops.web.variant"}}|created={{.Created}}' "$image_id"
  sudo docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$cid"
  sudo docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | grep -E '^(MDM_ENABLED|GEOPS_DATA_MODE|PORT|VITE_MDM_ENABLED)=' || true
done
echo '== named volumes, networks and capacity =='
sudo docker volume ls --format '{{.Name}}' | grep '^geops_' || true
sudo docker network ls --format '{{.Name}}' | grep '^geops_' || true
df -h / /var/lib/docker
free -h
echo '== real DB versions, ordered ledger, allowed permission values, counts =='
db=$(sudo docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=geops-db')
test -n "$db"
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -v ON_ERROR_STOP=1 -c "SELECT current_database(),current_setting('server_version'),PostGIS_Version();"
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -v ON_ERROR_STOP=1 -c 'SELECT version,checksum,applied_at FROM geops_schema_migrations ORDER BY version;'
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -v ON_ERROR_STOP=1 -c 'SELECT permission,count(*) FROM admin_permission GROUP BY permission ORDER BY permission;'
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -v ON_ERROR_STOP=1 -c 'SELECT (SELECT count(*) FROM geops_device) devices,(SELECT count(*) FROM gps_device_installation) installations,(SELECT count(*) FROM position_event) positions,(SELECT count(*) FROM mdm_integration) mdm_integrations;'
echo '== effective web proxy routes, no headers or secrets =='
web=$(sudo docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=geops-web')
test -n "$web"
sudo docker exec "$web" nginx -T 2>&1 | grep -E 'location (/v1/|/v2/|/v3/|= /health)|proxy_pass' || true
```

Si `psql` pide contraseña, detener la parte DB y usar el canal protegido habitual; jamás incluirla en el comando o reporte. El proxy externo Caddy requiere inspección separada por el operador: entregar solo resumen de rutas, sin certificados, claves ni cabeceras sensibles. Verificar `version,checksum` contra los 40 archivos del SHA fuente antes de aprobar migraciones.

## B. Respaldo y restauración

El comando protegido existente de respaldo es el servicio Compose `geops-backup`, cuyo `backup.sh` hace `pg_dump -Fc` y `.sha256`. El **comando host exacto** para invocarlo depende del archivo Compose efectivo, su directorio de proyecto y las variables protegidas del host, aún no legibles con `abi`; el operador debe confirmarlos antes de ejecutar. No ejecutar un `docker compose run` con ruta/env inventados. Tras generarlo, verificar dentro del almacenamiento protegido tamaño, `sha256sum -c` y `pg_restore --list`, y registrar los metadatos de [backup](WAVE6-R2-STAGING-BACKUP.md). Restaurar solo a DB/volumen descartables conforme al [ensayo](WAVE6-R2-RESTORE-REHEARSAL.md).

## C. Promoción futura, no ejecutar en W6-R2

La interfaz histórica del operador es `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` y usa `/usr/local/sbin/geops-staging-simple`. El wrapper remoto es root-only y la copia actual de `geops.ps1` no está en este checkout; por ello no se puede fijar todavía un comando ejecutable con ruta/argumentos de manifiesto y migración para 0040→0042. El operador debe entregar `--help`/runbook del controlador protegido y demostrarlo contra el restore real. `sudo -n /usr/local/sbin/geops-staging-simple check` y `status` son los únicos comandos protegidos verificados y seguros en este punto. No invocar `deploy` ni `rollback` hasta autorización independiente y prueba del flujo de migración.
