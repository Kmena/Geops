# GEOPS Staging: actualización Web del flujo QR (preparación)

Este procedimiento se ejecuta **solo con autorización de despliegue posterior**. La publicación Git de este cambio no lo ejecuta. Supone `/opt/geops-staging` en `detached HEAD`, la API y el esquema 0015 de `b5b20e8`, y el archivo privado `infrastructure/compose/.env.staging` existente. La APK se distribuye por un canal separado; nunca por Git.

## Preflight en Ubuntu

```bash
set -euo pipefail
cd /opt/geops-staging
test -z "$(git status --porcelain)" || { echo 'Árbol local no limpio'; exit 1; }
approved_sha='<SHA exacto del informe de publicación>'
git fetch origin codex/spec-02-wave-1
test "$(git rev-parse origin/codex/spec-02-wave-1)" = "$approved_sha"
git switch --detach "$approved_sha"
test "$(git rev-parse HEAD)" = "$approved_sha"

export GEOPS_STAGE_WEB_IMAGE_TAG="$approved_sha"
dc=(docker compose --env-file infrastructure/compose/.env.staging \
  -f infrastructure/compose/compose.staging.yaml \
  -f infrastructure/compose/compose.staging.web-only.override.yaml)
"${dc[@]}" config --quiet
api_before=$("${dc[@]}" ps -q geops-api)
db_before=$("${dc[@]}" ps -q geops-db)
web_before=$("${dc[@]}" ps -q geops-web)
test -n "$api_before" && test -n "$db_before" && test -n "$web_before"
old_web_image=$(docker inspect --format '{{.Config.Image}}' "$web_before")
test "${old_web_image%%:*}" = 'geops-spec02-web'
old_web_tag="${old_web_image##*:}"
printf 'API=%s DB=%s Web anterior=%s\n' "$api_before" "$db_before" "$old_web_image"
```

Confirmar que `GEOPS_STAGE_IMAGE_TAG` en el env privado sigue fijado a la imagen API existente `b5b20e8` y que `docker compose config` muestra únicamente `geops-web` con el tag nuevo. Conservar `old_web_tag` en la sesión del operador para rollback. No ejecutar perfiles `maintenance`, `migrate`, `gate init` ni `down`.

## Actualizar únicamente Web

```bash
"${dc[@]}" build geops-web
"${dc[@]}" up -d --no-deps --no-build geops-web
test "$("${dc[@]}" ps -q geops-api)" = "$api_before"
test "$("${dc[@]}" ps -q geops-db)" = "$db_before"
"${dc[@]}" ps geops-web geops-api geops-db
curl --fail --silent --show-error https://geops-staging.duckdns.org/ >/dev/null
curl --fail --silent --show-error https://geops-staging.duckdns.org/health/ready >/dev/null
```

En navegador autenticado: comprobar sesión y capacidades, selección persistente del dispositivo, confirmación presencial, QR de activación vigente, lectura GPS con `gps.location.read` y tenant, y mensajes 401/403/409/500. Verificar que la PoC HTTPS en la IP sigue disponible. No declarar validación física hasta probar Android autorizado con ventana GPS y permisos.

## Rollback exclusivo de Web

```bash
export GEOPS_STAGE_WEB_IMAGE_TAG="$old_web_tag"
"${dc[@]}" config --quiet
"${dc[@]}" up -d --no-deps --no-build geops-web
test "$("${dc[@]}" ps -q geops-api)" = "$api_before"
test "$("${dc[@]}" ps -q geops-db)" = "$db_before"
curl --fail --silent --show-error https://geops-staging.duckdns.org/health/ready >/dev/null
```

La actualización y el rollback no cambian API, PostgreSQL, gate, epoch, Caddy ni redes. El QR de activación contiene identificadores públicos y caduca en 15 minutos; no es una credencial ni evita PoP, estado activo, permisos Android o política horaria. Reescanear el mismo QR en el equipo inscrito solo repone identificadores; un equipo ajeno no posee la clave inscrita.

## APK de prueba

La APK release local se genera con el mismo keystore privado de prueba y un `versionCode` superior al anterior. Antes de distribuirla, comparar `apksigner verify --print-certs`, `aapt dump badging` y el SHA-256 del archivo con el informe de publicación. En un teléfono **autorizado posteriormente**, la actualización supervisada sería `adb install -r GeopsAndroid-release.apk`; comprobar que conserva los datos de la aplicación, escanear el QR de activación y pulsar «Iniciar seguimiento» dentro de una ventana autorizada. No instalar durante la publicación Git.
