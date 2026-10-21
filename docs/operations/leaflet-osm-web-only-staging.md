# Staging — actualización exclusiva de GEOPS Web con Leaflet y OSM

Este procedimiento requiere un SHA aprobado de `codex/spec-02-wave-1`. **No se ejecutó en esta tarea.** La API de Staging debe permanecer en `b5b20e8`; no se cambian PostgreSQL, gate, epoch, migraciones ni otros servicios. La fuente pública de OpenStreetMap es solo para el piloto limitado, conforme a su [política de teselas](https://operations.osmfoundation.org/policies/tiles/): sin precarga, con caché y atribución, sin SLA.

## Preparar y comprobar

1. En el host autorizado, conservar el checkout y la imagen Web actuales. Anotar el ID del contenedor y la imagen de `geops-web`, así como los de `geops-api` y `geops-db`. Conservar una copia de la configuración Nginx Web previa y el checkout anterior para rollback. No borrar imágenes antiguas.
2. Descargar la rama y comprobar el SHA aprobado antes de construir:

   ```sh
   git fetch origin codex/spec-02-wave-1
   test "$(git rev-parse origin/codex/spec-02-wave-1)" = "$SHA_APROBADO"
   git worktree add --detach "$RELEASE_WEB_DIR" "$SHA_APROBADO"
   cd "$RELEASE_WEB_DIR"
   ```

   `SHA_APROBADO` es el SHA completo informado tras CI; `RELEASE_WEB_DIR` es una carpeta nueva y separada de cualquier checkout con cambios locales. Confirmar `git status --porcelain` vacío allí.
3. Usar el archivo privado de variables de Staging existente. **Mantener** `GEOPS_STAGE_IMAGE_TAG=b5b20e8` para API, migrador y gate. Definir solo `GEOPS_STAGE_WEB_IMAGE_TAG=$SHA_APROBADO` para el override Web. No publicar ese archivo ni secretos. Antes de seguir, confirmar que la configuración combinada resuelve `geops-spec02-api:b5b20e8` para API y `geops-spec02-web:$SHA_APROBADO` para Web:

   ```sh
   docker compose --env-file "$STAGE_ENV" \
     -f infrastructure/compose/compose.staging.yaml \
     -f infrastructure/compose/compose.staging.web-only.override.yaml \
     config --images
   ```

4. Confirmar que `infrastructure/nginx/geops-staging-web.conf` del SHA aprobado permite `https://tile.openstreetmap.org` en `img-src` y usa `Referrer-Policy: strict-origin-when-cross-origin`. El servicio `geops-web` monta ese archivo como `stage_web_nginx` al recrearse. Dejar `VITE_GPS_TILE_URL` sin definir para usar la URL estándar de la PoC, o fijarla exactamente en `https://tile.openstreetmap.org/{z}/{x}/{y}.png` antes del build. No introducir claves en variables `VITE_*`.

## Construir y recrear solo Web

Ejecutar únicamente tras aprobar el SHA y las comprobaciones anteriores:

```sh
docker compose --env-file "$STAGE_ENV" \
  -f infrastructure/compose/compose.staging.yaml \
  -f infrastructure/compose/compose.staging.web-only.override.yaml \
  build geops-web

docker compose --env-file "$STAGE_ENV" \
  -f infrastructure/compose/compose.staging.yaml \
  -f infrastructure/compose/compose.staging.web-only.override.yaml \
  up -d --no-deps geops-web
```

Comprobar que los IDs de contenedor de API y PostgreSQL no cambiaron y que gate y epoch siguen iguales. No ejecutar `up` sin `--no-deps`, ni `migrate`, ni `gate`, ni `down`.

## Verificación autenticada

1. Confirmar HTTPS, `GET /health`, assets y ausencia de errores de Nginx. Revisar en la respuesta Web el CSP con `img-src https://tile.openstreetmap.org` y `Referrer-Policy: strict-origin-when-cross-origin`.
2. Con un administrador autorizado y `gps.location.read`, abrir **Dispositivos GPS** en navegador. Elegir un dispositivo con posiciones reales ya existentes y un período autorizado; comprobar calles, nombres, marcadores, recorrido, huecos, precisión, zoom, filtros rápidos y tabla. No generar capturas GPS artificiales ni forzar consultas repetitivas.
3. En Network del navegador, confirmar que las teselas se piden solo con el mapa visible, responden HTTP 200, envían `Referer` con el origen HTTPS de Staging y usan la caché del navegador. Comprobar atribución visible de OpenStreetMap. Probar escritorio y móvil sin desbordamiento horizontal.
4. Si falla una tesela, comprobar que el aviso aparece y las posiciones continúan en la tabla. Registrar los resultados y el SHA del build. **No declarar Staging PASS** hasta ver calles reales en el navegador autenticado.

## Rollback Web

Conservar la imagen Web anterior y el checkout anterior durante toda la validación. Si falla Web, volver al tag anterior de Web mediante el mismo override, con `GEOPS_STAGE_IMAGE_TAG=b5b20e8` sin cambios, y recrear **solo** `geops-web` con `up -d --no-deps geops-web`. Usar el checkout/configuración Nginx Web anterior si se debe restaurar también el CSP y `Referrer-Policy`; confirmar de nuevo HTTPS y datos GPS. No tocar API, PostgreSQL, gate ni epoch.
