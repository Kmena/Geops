# Staging — actualización de seguridad de inscripción

**Estado:** procedimiento preparado; no ejecutado en AWS. Requiere un SHA publicado con CI aprobado, una ventana autorizada y revisión de seguridad independiente. Solo sustituye imágenes de GEOPS API y Web. No habilita inscripción física, GPS real ni MDM.

## Condiciones previas

1. En el servidor, comprobar que el checkout y el SHA son los aprobados, el árbol Git está limpio y `GEOPS_STAGE_ORIGIN=https://geops-staging.duckdns.org`. Anotar el tag y los digests actuales de `geops-api` y `geops-web` y conservar sus imágenes para rollback.
2. Confirmar **15** pares versión/checksum en `geops_schema_migrations`, PostGIS operativo, `security_epoch` y gate externo en fase `open` con el mismo epoch. Registrar el epoch y el hash del marcador por canal privado. Confirmar que las capacidades y concesiones del principal incluyen `gps.installation.manage` y `synthetic`; registrar recuentos, sin copiar credenciales ni sesiones.
3. Confirmar backup vigente y restauración de ensayo aislada conforme al runbook. Si el esquema, el epoch o el gate difieren, detener la actualización. El diff de este release no contiene SQL nuevo ni cambios Compose/Caddy.

## Sustitución de imágenes, solo tras autorización de despliegue

Ejecutar desde el checkout privado en Ubuntu. El archivo `env_file` sigue siendo el archivo privado existente; no crear secretos nuevos ni rotarlos. `new_sha` debe coincidir con el SHA publicado y aprobado. Guardar el tag anterior fuera de este bloque y verificarlo antes de ejecutar.

```bash
cd /opt/geops-staging
env_file=/ruta/privada/staging.env
new_sha=SHA_APROBADO
test "$(git rev-parse HEAD)" = "$new_sha"
test -z "$(git status --porcelain)"
dc=(docker compose --env-file "$env_file" -f "$PWD/infrastructure/compose/compose.staging.yaml")
GEOPS_STAGE_IMAGE_TAG="$new_sha" "${dc[@]}" config --quiet
GEOPS_STAGE_IMAGE_TAG="$new_sha" "${dc[@]}" build geops-api geops-web
"${dc[@]}" stop geops-web geops-api
GEOPS_STAGE_IMAGE_TAG="$new_sha" "${dc[@]}" up -d --no-deps --no-build --wait geops-api
GEOPS_STAGE_IMAGE_TAG="$new_sha" "${dc[@]}" up -d --no-deps --no-build --wait geops-web
```

No usar el perfil `maintenance`, `geops-migrate`, `geops-gate-init`, `down -v`, `prune` ni `up` sobre `geops-db`. No cambiar Caddy, redes, volúmenes, secretos, PoC, Inventori ni Billing. Tras la validación, actualizar únicamente `GEOPS_STAGE_IMAGE_TAG` en el archivo env privado al SHA nuevo; no publicarlo en Git.

## Verificación y rollback

Comprobar `/health/ready` y HTTPS, login/logout, CSRF/Origin, `/v1/admin/auth/me`, las diez capacidades y `tenant_ids:["synthetic"]`. En Web comprobar inventario, políticas y vistas GPS. Probar con cuentas sintéticas autorizadas que emisión, revocación, evidencia y activación exigen `gps.installation.manage` **y** acceso tenant; ausencia de cualquiera da 403. El teléfono conserva claim y PoP existentes; la activación requiere código de emparejamiento, evidencia presencial y confirmación en Web. Verificar auditoría sin secretos. Comparar nuevamente los 15 checksums, epoch, hash de gate y recuentos de capacidades/concesiones. Comprobar la PoC en la IP sin modificarla.

Si falla el smoke antes de aceptar nuevas inscripciones, detener únicamente API/Web y arrancarlas con `GEOPS_STAGE_IMAGE_TAG=<tag_anterior>` usando el mismo `dc`, `up -d --no-deps --no-build --wait geops-api` y luego `geops-web`. Repetir salud, autorización, 15 checksums y epoch. Si difiere DB o gate, mantener API/Web detenidas y escalar; no restaurar ni reabrir un gate automáticamente. La validación física Android y la revisión independiente siguen pendientes.
