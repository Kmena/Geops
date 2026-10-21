# Staging — nombres canónicos en vistas GPS

Este procedimiento prepara una actualización **solo de API y Web** desde API `b5b20e8` y Web `8e89f0e`. No se ejecutó en esta tarea. Requiere un SHA aprobado y CI correcto de `codex/spec-02-wave-1`. PostgreSQL conserva sus 15 migraciones, volúmenes, administrador y permisos; gate y epoch quedan intactos. No ejecutar migraciones, comandos de gate, `down`, ni recrear otros servicios. Caddy, PoC y Android quedan fuera del cambio.

## Preparación

1. En el host autorizado, registrar el SHA aprobado, los IDs y tags actuales de `geops-api`, `geops-web` y `geops-db`, el estado del gate y el epoch. Conservar las imágenes anteriores, el checkout anterior y el archivo privado de variables para rollback. No copiar secretos al repositorio.
2. Descargar el SHA aprobado en un checkout separado y limpio:

   ```sh
   git fetch origin codex/spec-02-wave-1
   test "$(git rev-parse origin/codex/spec-02-wave-1)" = "$SHA_APROBADO"
   git worktree add --detach "$RELEASE_DIR" "$SHA_APROBADO"
   cd "$RELEASE_DIR"
   test -z "$(git status --porcelain)"
   ```

3. Mantener `GEOPS_STAGE_IMAGE_TAG=b5b20e8` en el archivo privado actual; ese tag sigue aplicando a migrador y gate. Definir `GEOPS_STAGE_API_IMAGE_TAG=$SHA_APROBADO` y `GEOPS_STAGE_WEB_IMAGE_TAG=$SHA_APROBADO` solo para los overrides. Con el mismo archivo privado de Staging, comprobar la resolución de imágenes antes de construir:

   ```sh
   docker compose --env-file "$STAGE_ENV" \
     -f infrastructure/compose/compose.staging.yaml \
     -f infrastructure/compose/compose.staging.api-only.override.yaml \
     -f infrastructure/compose/compose.staging.web-only.override.yaml \
     --profile maintenance config --images
   ```

   Confirmar `geops-spec02-api:$SHA_APROBADO` para `geops-api`, `geops-spec02-web:$SHA_APROBADO` para `geops-web`, y `geops-spec02-api:b5b20e8` para migrador/gate. Los overrides no modifican PostgreSQL, Caddy ni la configuración Nginx Web.

## Construcción y actualización controlada

Construir ambas imágenes desde el SHA aprobado. Mantener las imágenes antiguas disponibles.

```sh
docker compose --env-file "$STAGE_ENV" \
  -f infrastructure/compose/compose.staging.yaml \
  -f infrastructure/compose/compose.staging.api-only.override.yaml \
  -f infrastructure/compose/compose.staging.web-only.override.yaml \
  build geops-api geops-web

docker compose --env-file "$STAGE_ENV" \
  -f infrastructure/compose/compose.staging.yaml \
  -f infrastructure/compose/compose.staging.api-only.override.yaml \
  -f infrastructure/compose/compose.staging.web-only.override.yaml \
  up -d --no-deps geops-api

docker compose --env-file "$STAGE_ENV" \
  -f infrastructure/compose/compose.staging.yaml \
  -f infrastructure/compose/compose.staging.api-only.override.yaml \
  -f infrastructure/compose/compose.staging.web-only.override.yaml \
  up -d --no-deps geops-web
```

Comprobar `/health/ready` entre las dos recreaciones. Después, confirmar que solo cambiaron los IDs de contenedor de API y Web; el ID de PostgreSQL, las 15 versiones de esquema, el estado del gate y el epoch coinciden con el registro inicial. El nombre se añade a la respuesta GPS sin alterar identificadores, relaciones, permisos ni esquema. La Web anterior es compatible con el campo nuevo; la API anterior no aporta nombres a la Web nueva.

## Verificación autenticada

Con un administrador autorizado, comparar `GET /v1/admin/devices` y `GET /v1/admin/gps-devices` por `id`/`device_id` dentro del tenant `synthetic`. Confirmar `display_label` idéntico para cada dispositivo elegible, identidad ACTIVE en Inventario, vínculo MDM activo y grant de tenant vigente. El endpoint GPS exige `gps.session.read`; las ubicaciones siguen exigiendo `gps.location.read`. No copiar cookies, tokens ni respuestas con datos privados al informe.

Abrir Dispositivos GPS y comprobar que el selector muestra `Android-Prueba-01` a `Android-Prueba-05` si los cinco aparecen en la consulta GPS. Revisar sesiones, políticas/asignaciones, dashboard e historial. Los nombres únicos no deben llevar sufijo; los vacíos o duplicados sí llevan ID corto. El UUID completo debe quedar en detalles técnicos. Confirmar que un administrador sin permiso recibe 403 y que no aparecen dispositivos de otros tenants. **Staging no es PASS** hasta completar esta comparación en el navegador autenticado.

## Rollback de ambas imágenes

Si falla la verificación, restaurar `GEOPS_STAGE_API_IMAGE_TAG` y `GEOPS_STAGE_WEB_IMAGE_TAG` a los tags guardados (`b5b20e8` y `8e89f0e` respectivamente) usando el checkout/configuración anterior si corresponde. Ejecutar `up -d --no-deps geops-api` y luego `up -d --no-deps geops-web` con los mismos tres archivos Compose. Confirmar health, acceso autenticado, IDs de base/gate sin cambios y respuesta GPS previa. Conservar evidencia del fallo y las imágenes nuevas para análisis; no ejecutar migraciones.
