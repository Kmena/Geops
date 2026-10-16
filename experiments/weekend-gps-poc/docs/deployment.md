# Despliegue experimental cloud — preparación, sin ejecución

**Estado:** BLOCKED_FOR_REMOTE_DEPLOYMENT. El acceso SSH desde Codex no está confirmado y no se ha realizado ninguna operación remota. La captura real permanece desactivada. Inventori no se modifica.

## Inventario aportado por el operador

| Dato | Estado |
| --- | --- |
| Ubuntu 24.04 LTS; SSH `abi`; directorio reservado `/opt/geops-poc` | Informado; no comprobado desde Codex |
| Docker 29.8.1; Compose 5.5.1; deploy key GitHub solo lectura | Informado; no comprobado desde Codex |
| 2 vCPU; 7.7 GiB RAM; ~17 GB libres | Informado; medir uso actual de Inventori antes de reservar recursos |
| IP privada 172.31.17.155 | Informada; nunca usar como origen público de la APK |
| 18.209.159.208 | El operador confirma acceso entrante a Inventori por esta IP; confirmar Public IPv4 de EC2 y asociación Elastic IP |
| 80/443 sin listeners; 3500/3501 candidatos libres | Última inspección; repetir justo antes del despliegue y verificar firewall/security group |
| Inventori en 2500 y 5173 | No ocupar esos puertos ni tocar sus contenedores, procesos, red, volúmenes o credenciales |
| Dominio GEOPS | Aún no existe |

No se ha confirmado si 18.209.159.208 es Elastic IP. Si es una IPv4 pública efímera, un cambio de dirección rompería el origen fijado en la APK y el certificado IP. La estabilidad de la dirección debe resolverse antes de la prueba física prolongada.

## HTTPS temporal por IP, sin dominio

La plantilla `infra/compose.cloud.yaml` publica únicamente Caddy en 80/443. El puerto 80 sirve desafíos ACME y redirige a HTTPS; el 443 entrega Web y API. API (`poc-api:3600`) y PostgreSQL (`poc-db:5432`) son internos y **no tienen bind al host**. Los candidatos 3500/3501 no se publican ni se necesitan en esta topología. La red y los volúmenes tienen nombres exclusivos `geops_weekend_poc_*`.

`infra/Caddyfile` admite una IPv4 pública o un futuro FQDN propio mediante `POC_PUBLIC_HOST`. Pide a Let's Encrypt un certificado público para la IP con el perfil ACME `shortlived`; se usa Caddy 2.10.2 y el volumen `poc_caddy_data` persiste su estado de renovación. Los certificados IP de Let's Encrypt duran aproximadamente 160 horas, por lo que la emisión y renovación reales deben comprobarse antes de instalar la APK. El `default_sni` atiende clientes que no envían SNI para una IP. La configuración está preparada, pero **no existe aún certificado emitido ni URL HTTPS validada**. [Let's Encrypt: certificados IP](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), [Caddy: perfil ACME](https://caddyserver.com/docs/caddyfile/directives/tls).

La APK deberá compilarse solo después con `-PpocApiOrigin=https://IP_PUBLICA_VERIFICADA` o con un futuro dominio propio. Conserva validación TLS normal; no se instala CA privada ni se omite la verificación de certificado. Si la emisión IP no funciona, detener el despliegue y esperar un FQDN propio o diseñar otra opción de confianza verificable; nunca servir GPS real por HTTP.

## Límites y aislamiento preparados

- Compose limita la PoC a 0.50 CPU/768 MiB para DB, 0.25 CPU/256 MiB para migración, 0.50 CPU/384 MiB para API y 0.25 CPU/256 MiB para Caddy. Son máximos, no una reserva garantizada; confirmar margen de Inventori y disco antes de usar el servidor.
- Logs Docker `json-file` rotan a tres archivos de 10 MiB por servicio. La API tiene filesystem de solo lectura, `tmpfs` temporal y `no-new-privileges`. PostgreSQL persiste en volumen propio y no publica puerto.
- El entorno inicial debe contener `POC_CAPTURE_ENABLED=false`, `POC_MAX_DEVICES=1` y retención aprobada de 1–168 horas. No reutilizar secretos de Inventori, Wave 0A ni ManageEngine.

## Secuencia futura con autorización de despliegue

1. Desde la terminal externa autorizada, ejecutar `bash infra/preflight-server.sh` en el módulo si el checkout ya existe. Es solo lectura: usuario, sistema, Docker/Compose, CPU, memoria, disco, sockets, contenedores, redes y volúmenes. También revisar uso actual de Inventori, EC2 Public IPv4, Elastic IP, security group, firewall y salida a Let's Encrypt. Registrar evidencia sanitizada sin copiar secretos.
2. Confirmar que 80/443 están libres y que abrirlos o usarlos no altera Inventori. Si otro proxy ocupa esos puertos, rediseñar el bind y solicitar nueva revisión; no detenerlo. Verificar de nuevo la dirección pública entrante y su estabilidad.
3. Tras autorización para preparar el host, situar el checkout solo lectura en `/opt/geops-poc` usando la deploy key ya configurada. Crear `infra/.env.local` ignorado con secretos experimentales nuevos, `POC_PUBLIC_HOST` igual a la IPv4 EC2 verificada, `POC_HTTP_BIND=0.0.0.0:80`, `POC_HTTPS_BIND=0.0.0.0:443`, retención aprobada y captura `false`. Permisos restrictivos. No copiar valores reales a Git ni imprimir `docker compose config` sin `--quiet`.
4. Ejecutar `node infra/cloud-config-preflight.mjs infra/.env.local` y `docker compose --env-file infra/.env.local -f infra/compose.cloud.yaml config --quiet`. El primer control valida formato y bloqueo de captura, pero no certifica EC2, TLS ni puertos. Revisar manualmente recursos GEOPS, capacidad libre y rutas de backup.
5. Solo con autorización de despliegue experimental, iniciar el proyecto Compose GEOPS. Verificar `ps`, health de DB/API, certificado público válido para la IP, renovación, `https://IP_PUBLICA_VERIFICADA/health/ready`, Web y acceso anónimo denegado. No inscribir teléfono ni habilitar captura en esta etapa.
6. Obtener una aprobación separada de seguridad, privacidad, retención y teléfono único antes de compilar la APK con captura real, activar la API e iniciar el checklist físico.

No se ejecutaron los pasos 1–6 en el servidor desde Codex. No cambiar security groups ni firewall sin autorización específica.

## Backups, retención y rollback

Antes de GPS real, definir almacenamiento de backups cifrado y restringido **fuera del checkout**, límite de espacio y fecha de eliminación. `infra/backup.mjs` y `infra/verify-backup.mjs` requieren `POC_BACKUP_DIR` y `POC_BACKUP_KEY_FILE` fuera del repositorio, con clave binaria aleatoria de 32 bytes. `POC_ENV_FILE` y `POC_COMPOSE_FILE` seleccionan el entorno; para cloud usar `infra/compose.cloud.yaml`. Probar restauración en una base PoC nueva y aislada con `POC_RESTORE_VERIFY=true`. En local pasó con datos sintéticos; en cloud sigue pendiente.

La API purga por `received_at` cada hora después de `POC_RETENTION_HOURS`; los backups requieren eliminación separada. Si falla la prueba: desactivar captura, revocar el dispositivo, detener solo `geops-weekend-poc`, conservar su volumen hasta el plazo aprobado y restaurar únicamente componentes PoC. Una restauración no reautoriza captura automáticamente; antes de reabrir, revisar y revocar identidades antiguas. No usar `down -v` hasta aprobar explícitamente el borrado final y verificar el nombre de proyecto. No tocar Inventori.

## Bloqueos actuales

Pendientes: inventario actual del host y consumo de Inventori; EC2 Public IPv4 y condición Elastic IP; firewall/puertos 80/443; emisión y renovación reales de TLS por IP; backups/restauración cloud; APK compilada; revisión de seguridad; aprobación de privacidad y captura. La configuración local no constituye despliegue ni prueba física.
