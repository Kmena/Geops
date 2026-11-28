# W6-R1 — Acciones pendientes del operador, en orden

El acceso SSH de lectura ya obtuvo proyecto, digests activos, esquema 0040, salud, gate, SHA de release, puertos y recursos. No repetir ese inventario. Faltan únicamente datos que el usuario `abi` no puede leer por el socket Docker, la consola ManageEngine o el Moto G06. Enviar resultados **sanitizados**; nunca contraseñas, tokens, OAuth secrets, llaves privadas, IMEI, serial completo ni coordenadas por chat.

## P0 — Completar inventario privilegiado de staging, solo lectura

Un operador con sudo Docker en `geops-staging` puede ejecutar **este único bloque**. No usa `docker exec` para modificar datos, no imprime `docker inspect .Config.Env`, no reinicia contenedores y no lee secretos. Revisar el resultado antes de compartirlo; ocultar identificadores personales si aparecen en nombres.

```bash
set -eu
project=geops-spec02-staging
echo '== containers and compose =='
sudo docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'
sudo docker compose ls --format json
echo '== image ids, registry digests and revision labels =='
for cid in $(sudo docker ps -q --filter "label=com.docker.compose.project=$project"); do
  sudo docker inspect --format '{{.Name}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}|{{json .NetworkSettings.Ports}}' "$cid"
  image_id=$(sudo docker inspect --format '{{.Image}}' "$cid")
  sudo docker image inspect --format '{{.Id}}|{{json .RepoDigests}}|revision={{index .Config.Labels "org.opencontainers.image.revision"}}|variant={{index .Config.Labels "org.geops.api.variant"}}|web_variant={{index .Config.Labels "org.geops.web.variant"}}' "$image_id"
done
echo '== GEOPS volumes and networks =='
sudo docker volume ls --format '{{.Name}}' | grep '^geops_' || true
sudo docker network ls --format '{{.Name}}' | grep '^geops_' || true
echo '== host resources =='
df -h / /var/lib/docker
free -h
echo '== database and migration ledger =='
db=$(sudo docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=geops-db')
test -n "$db"
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -c "SELECT current_database(),current_setting('server_version'),PostGIS_Version();"
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -c 'SELECT version,checksum,applied_at FROM geops_schema_migrations ORDER BY version;'
sudo docker exec "$db" psql -U geops_stage -d geops_dev -X -A -F '|' -c 'SELECT (SELECT count(*) FROM geops_device) AS devices,(SELECT count(*) FROM gps_device_installation) AS installations,(SELECT count(*) FROM position_event) AS positions,(SELECT count(*) FROM mdm_integration) AS mdm_integrations,(SELECT count(*) FROM mdm_oauth_client_config) AS mdm_oauth_clients;'
echo '== proxy route summary =='
web=$(sudo docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=geops-web')
test -n "$web"
sudo docker exec "$web" nginx -T 2>&1 | grep -E 'location (/v1/|/v2/|/v3/|= /health)|proxy_pass' || true
```

Si `psql` solicita contraseña, detener esa parte y comunicar solo el error sanitizado. El operador puede repetirla mediante su canal protegido habitual; **no** escribir una contraseña en el comando o en la respuesta. El bloque no determina por sí solo la configuración del proxy de borde externo; confirmar el archivo/servicio Caddy efectivo con resumen de rutas sin certificados ni secretos. Informar también la presencia, fecha, tamaño y checksum de un backup vigente mediante el procedimiento protegido de staging, sin transferir el dump.

## P1 — ManageEngine, lectura de consola o cuenta READ

Desde el tenant **real** de laboratorio: capturar producto, edición, licencia, versión, modalidad Cloud/On-Premises, URL/región, cliente/tenant MSP si aplica y scopes READ disponibles. En Inventario, localizar Moto G06 por un identificador de custodia confiable; entregar ID MDM real, nombre/modelo/Android, enrolamiento y modo de administración, último contacto, app GEOPS (`package`, versión y estado), perfiles asignados y estado de distribución, configuración administrada y cualquier pantalla de permisos/batería/ubicación. Distinguir datos de consola de endpoints API. Si no existe cuenta READ, entregar capturas sanitizadas de esas pantallas; no enviar credenciales en chat. No asociar un equipo por modelo solamente ni usar `fake-*`.

## P2 — Moto G06 y APK instalada, sin cambiarlo

Con acceso físico autorizado: leer paquete, versionCode/versionName, estado de instalación, Android/SDK, identidad GEOPS/`installation_id` bajo custodia, Managed Configurations, enrolamiento y reporte técnico sanitizado. Para verificar la firma, usar inventario MDM **solo si expone un hash de certificado verificable**; en caso contrario, en laboratorio y con depuración ya autorizada, usar `adb shell pm path com.geops.corporate`, extraer `base.apk` a almacenamiento protegido y ejecutar `apksigner verify --print-certs base.apk`. No habilitar USB debugging remotamente, no dejar ADB como dependencia operativa, no enviar APK instalada o identidad/token por chat. Comparar con el certificado de la candidata en [compatibilidad APK](WAVE6-R1-APK-COMPATIBILITY.md).

## P3 — Respaldo/restore real y aprobación de promoción

Tras P0, un responsable autorizado debe generar dump fresco y hash, restaurar **en DB aislada**, comparar ledger/conteos/identidades, ensayar 0040→0042 y medir backup, restore, migración y recuperación. El [procedimiento](WAVE6-R1-BACKUP-RESTORE-EVIDENCE.md) fija las verificaciones. No sobrescribir staging ni cambiar el gate operativo durante la prueba. Solo entonces preparar una solicitud de promoción con SHA exacto, digests GHCR, CI, backup, restore, duración y pruebas; W6-R1 se detiene antes del despliegue.

## P4 — Validación posterior, todavía no autorizada para ejecución

Después de aprobar **por separado** staging y la instalación individual: registrar diagnóstico real en APK con hora UTC y correlacionarlo con portal; comparar deseado/MDM/efectivo; observar FGS, permisos, batería, última captura, transmisión, ACK, cola, auth y conectividad. Repetir con interfaz minimizada, retirada de recientes, pantalla apagada, bloqueo, pérdida/retorno de red, reboot y logout. Guardar timestamps de inicio/fin, capturas locales, recepciones backend y timeline. Clasificar causa solo con evidencia discriminante; no modificar motor GPS antes. Una prueba de 24 horas exige 24 horas físicas reales.
