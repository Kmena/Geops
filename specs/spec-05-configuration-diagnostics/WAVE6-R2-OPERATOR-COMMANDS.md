# W6-R2 — Comandos de operador

## A. Único bloque de inventario privilegiado, solo lectura

Bloque histórico de inventario, conservado para trazabilidad. El operador confirmó que `abi` tiene sudo completo con contraseña; las comprobaciones aún pendientes quedan consolidadas en el script de la sección B. No modificar grupos/sudoers ni imprimir `.Config.Env` completa o secretos.

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

## B. Intervención única: script de operador

Revisar el [script completo](../../scripts/deploy/simple/spec05_w6r2_operator_rehearsal.py) y su SHA-256 publicado en el cierre. `abi` ejecuta sudo con contraseña mediante su cuenta autorizada. La única variable necesaria es la **ruta absoluta del archivo Compose privado existente**; el operador la fija localmente y no comparte su valor. No se requieren rondas manuales de inspección.

```bash
# En la estación autorizada, copiar el archivo aprobado al servidor; no copiar datos de staging de vuelta.
scp scripts/deploy/simple/spec05_w6r2_operator_rehearsal.py abi@geops-staging:/home/abi/spec05_w6r2_operator_rehearsal.py
ssh -t abi@geops-staging
export STAGE_ENV='/ruta/absoluta/privada/existente/de/variables-compose'
sudo install -o root -g root -m 0700 /home/abi/spec05_w6r2_operator_rehearsal.py /usr/local/sbin/spec05-w6r2-operator-rehearsal
sudo sha256sum /usr/local/sbin/spec05-w6r2-operator-rehearsal
sudo python3 /usr/local/sbin/spec05-w6r2-operator-rehearsal --self-test
sudo python3 /usr/local/sbin/spec05-w6r2-operator-rehearsal \
  --compose-env-file "$STAGE_ENV" --authorize-isolated-gate-open
```

Comprobar que `sha256sum` coincide **exactamente** con el valor en [cierre](WAVE6-R2-CLOSEOUT.md) antes de ejecutar. El flag autoriza abrir solo el gate de la copia restaurada, después de invalidar credenciales y verificar el destino `geops_verify_*_restore`; no autoriza promoción. El script comprueba proyecto, digests y estado antes de usar Docker, exige ≥7 GiB libres en Docker y ≥3 GiB de RAM disponible, y detiene el ensayo si cambian las precondiciones. La copia, API y Web candidatas usan `--network none` sin puertos publicados; la API lleva `MDM_ENABLED=false` y claves efímeras. El script nunca invoca `deploy`, `rollback`, Compose `down` ni `prune`. Solo elimina contenedores/volumen/directorio temporal identificados con el ID único de su ejecución; conserva dump y reporte privado.

Resultado esperado: reporte JSON sanitizado en `/var/lib/geops-spec05-w6r2-evidence/` con permisos 0600, ruta y SHA-256 impresos. Los cinco gates de inventario/ledger, OCI, backup, restore y migración pueden pasar a `PASS` tras el ensayo real. `STAGING_OPERATOR_REHEARSAL_PASS` y `STAGING_PROMOTION_READY` permanecen `BLOCKED` si el controlador protegido no demuestra una interfaz que apunte exclusivamente a la copia; la verificación estática de su código no se atribuye a ensayo operativo. `STAGING_PROMOTION_AUTHORIZED` y `STAGING_DEPLOYED` permanecen `NOT_RUN`.

## C. Promoción futura, no ejecutar en W6-R2

La interfaz histórica del operador es `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` y usa `/usr/local/sbin/geops-staging-simple`. El script lee el controlador protegido con sudo, comprueba su sintaxis/capacidades y observa `status` antes/después; no invoca despliegue operativo. Si el controlador no expone un modo verificable para ensayar sobre la copia aislada, se conserva el bloqueo específico de ensayo del operador. No invocar `deploy` ni `rollback` sobre staging hasta autorización independiente.

La futura autorización de promoción se solicitará por separado, con el reporte de este ensayo. El ensayo del controlador debe apuntar a la copia restaurada aislada, nunca a `geops_dev` operativo.
