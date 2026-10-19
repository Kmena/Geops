# SPEC-02 — Staging bajo `/staging/` con Caddy de la PoC

**Estado:** artefactos locales preparados; despliegue pendiente de gates. La [revisión de seguridad del path](staging-path-security-review-2026-10-19.md) clasifica la preparación sintética `ACCEPTABLE_WITH_MITIGATIONS`, sujeta a aceptación del riesgo de origen compartido. No se accedió al servidor ni se cambió la PoC activa. Este documento sustituye solo el diseño de transporte HTTPS propio de la [preparación Staging anterior](staging-readiness-2026-10-19.md); su evidencia histórica, gates de datos, restore y seguridad siguen vigentes. ADR-018 continúa propuesto.

## Arquitectura propuesta

| URL pública | Caddy existente | Destino |
| --- | --- | --- |
| `/` y rutas de la SPA de la PoC | `handle` de archivo existente | `/srv` de la PoC |
| `/api/*`, `/health/*` | `handle @backend` existente | `poc-api:3600` |
| `/staging` | `308` a `/staging/` | sin API |
| `/staging/*` | `handle_path` antes de PoC; elimina solo `/staging` | `geops-spec02-stage-web:8080` |
| `/staging/v1/*` | la misma ruta Staging; Nginx reenvía `/v1/*` | `geops-api:3500` |

[Caddyfile propuesto](../../infrastructure/staging/Caddyfile.poc-proposed) es una copia independiente: preserva TLS/ACME, compresión, backend y SPA originales y añade una ruta antes de la PoC. [Overlay de Compose PoC](../../infrastructure/staging/compose.poc-edge.override.yaml) monta ese archivo en solo lectura y conecta **solo** `poc-https` a la red externa `geops_spec02_stage_edge`; no cambia puertos ni volúmenes de certificado. [Compose Staging](../../infrastructure/compose/compose.staging.yaml) conecta a esa red solo `geops-web`. API y DB permanecen en redes propias sin puertos publicados. Crear la red y aplicar el overlay requerirá autorización posterior; no se hizo aquí.

TLS público termina en el Caddy existente y conserva su certificado y claves dentro de sus volúmenes originales. El salto Caddy → Nginx Staging usa HTTP **solo en un bridge Docker privado del mismo host**, sin publicación de puerto; Nginx → API usa `stage_app` interna. Es la alternativa privada al TLS entre contenedores para este Staging sintético. Quien controle Docker o un contenedor unido a esa red puede observar ese salto: inspeccionar membresía de red y endurecimiento del host antes de desplegar. No se exporta clave privada, no se desactiva validación TLS del navegador y no se crea certificado paralelo.

## Web, API y sesiones

La imagen Web se construye con `GEOPS_WEB_BASE=/staging/`; Vite emite assets `/staging/assets/*`, React Router usa basename `/staging` y el cliente Web llama `/staging/v1/*`. Localmente el valor por defecto sigue `/` con proxy Vite `/v1`. Caddy elimina `/staging` antes de Nginx, por lo que Fastify conserva los contratos `/v1/*`. Refresh y enlaces directos de la SPA usan fallback a `index.html`; assets faltantes reciben 404 real y la ruta React desconocida muestra la página 404. `/staging` redirige a `/staging/`.

La API Staging exige `Origin: https://18.209.159.208` para mutaciones, token CSRF por sesión y cookie `geops_stage_admin; Path=/staging; HttpOnly; Secure; SameSite=Lax`. Logout expira exactamente ese nombre/path. La PoC usa `poc_admin; Path=/api/admin; SameSite=Strict`; las claves de sesión y secretos de Staging deben ser nuevos. Las cookies son credenciales diferentes, pero **el aislamiento por path no crea una frontera de seguridad entre JavaScript del mismo origen**: un XSS en cualquiera de las aplicaciones podría llamar rutas de la otra con la sesión del navegador. Este riesgo requiere aceptación explícita o un host separado antes de datos reales/operación.

La PoC y Fastify no tienen redirecciones API observadas en esta revisión; el `308` explícito es solo para `/staging`. Cambios futuros que emitan `Location: /v1/...` deben mapearse y probarse antes de publicar. La firma PoP del backend usa el path canónico `/v1/device/*` tras el proxy. Kotlin ahora construye la URL pública con `/staging` y firma la ruta canónica `/v1/device/*`; un vector compartido con Node y 15 escenarios JVM sintéticos pasaron. Rechaza bases/rutas ambiguas y redirecciones. No se añadió bypass PoP ni cabecera de path confiada al cliente. No se habilitan teléfonos físicos.

## Evidencia local de este corte

- `npm run staging:check`: Compose sin puertos Staging, redes/volúmenes/secretos propios, cookie y base Web; comparación estática del Caddyfile con la PoC.
- `caddy validate` con imagen local `caddy:2.10.2-alpine` y `--network none`: configuración válida. `npm run staging:caddy:check`: JSON adaptado y ensayo HTTP aislado confirman `/staging/*` con strip, rutas PoC y conservación de Authorization, Origin, Cookie y nonce hacia upstreams sintéticos.
- `docker compose config --quiet` de Staging y de PoC+overlay con valores **sintéticos**: válidos; la PoC conserva 80/443 y volúmenes `/data`/`/config`, y el nuevo bind es de solo lectura. No se inició contenedor de aplicación.
- Build Web bajo `/staging/`: `dist/index.html` referencia `/staging/assets/*`; typecheck, pruebas Web y API, contratos y lint se registran en el informe de entrega. Las pruebas de cookies usan Fastify `inject`, sin DB ni servidor.
- Las pruebas de cliente cubren 401/403/409/429 existentes; la prueba nueva cubre `Origin`, CSRF, login/logout y rechazo de cookies PoC/raíz. Nginx Staging devolvió CSP/cabeceras de seguridad en un contenedor local. **No hay E2E de navegador ni prueba del Caddy/certificado activos del servidor.** No se declara PASS de esos gates ni de certificado público/hostname actual.

## Procedimiento de despliegue posterior, no ejecutado

1. Obtener aprobación de cambio, revisar seguridad de mismo origen, inventario de host/puertos/redes y evidencia del certificado público vigente para la IP. Programar ventana y registrar estado previo de la PoC (`/`, `/api/*`, `/health/*`, 80/443, Caddyfile y Compose efectivos). No exportar claves.
2. En checkout aislado y revisado, crear `geops_spec02_stage_edge` como bridge exclusivo. Crear secretos/volúmenes Staging propios según el runbook anterior. Fijar `GEOPS_STAGE_ORIGIN=https://18.209.159.208` y tag inmutable; verificar `config --quiet` y `staging:check`.
3. Construir imagen Web con `/staging/`, preparar DB Staging vacía y migraciones/gate siguiendo el runbook anterior; levantar API y Web sin puertos públicos. Comprobar sus health checks desde el entorno privado. No iniciar Android ni datos reales.
4. Resolver `GEOPS_STAGE_CADDYFILE` a la **ruta absoluta existente** del Caddyfile propuesto. Validarlo con `caddy validate` y ejecutar Compose PoC con su archivo original más el overlay; comprobar que `poc-https` conserva `poc_internal`, puertos y volúmenes, y añade solo `geops_stage_edge`. La operación sobre Caddy activo exige una aprobación posterior específica.
5. Hacer smoke HTTPS de PoC en `/`, `/api/*`, `/health/*` y de Staging en `/staging/`, enlace directo/refresco, assets, `/staging/v1/*`, login/logout, cookie, CSRF, 401/403/404/429, logs sanitizados y ausencia de fuga a PoC. Probar E2E autenticado en navegador con datos sintéticos. Si falla cualquier ruta PoC, revertir de inmediato.

## Rollback posterior, no ejecutado

1. Retirar el overlay PoC y volver al Caddyfile/Compose originales conservando los volúmenes Caddy. Validar Caddy y las tres rutas de la PoC; el certificado original permanece en su volumen.
2. Detener Web/API Staging y desconectar/eliminar la red de borde **solo tras comprobar** que no hay contenedores conectados. Conservar DB, volúmenes, logs y dump para análisis; no borrar datos automáticamente.
3. Si hubo migración o sesiones activas, aplicar las reglas de cuarentena/restore del runbook anterior; no reabrir una base restaurada sin gate válido. Rotar secretos Staging si hubo exposición.

## Gates pendientes

No se ha confirmado el estado real del certificado IP, puertos, recursos, red Docker, Caddyfile desplegado ni salud de la PoC en el servidor. Faltan E2E HTTPS/navegador, load sostenido de 25 identidades sintéticas, restore operativo, revisión independiente de seguridad y aceptación del riesgo de mismo origen. **Readiness:** `ACCEPTABLE_WITH_MITIGATIONS` para preparar Staging sintético; despliegue y uso operativo siguen sujetos a gates y aprobación. W1-E1/E2 mantienen sus gates previos.
