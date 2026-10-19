# SPEC-02 — Staging en `geops-staging.duckdns.org`

**Estado:** configuración local preparada para un Staging exclusivamente sintético; sin despliegue ni acceso al servidor. Este diseño sustituye la propuesta bajo `https://18.209.159.208/staging/`. La PoC permanece en `https://18.209.159.208/`. Según el usuario, DuckDNS ya resuelve a `18.209.159.208` desde AWS; no se verificó aquí el DNS ni el certificado público.

## Enrutamiento y aislamiento

| Origen HTTPS | Caddy existente | Destino |
| --- | --- | --- |
| `https://18.209.159.208/` | Bloque PoC original, incluido `tls` ACME shortlived | SPA PoC en `/srv`; `/api/*` y `/health/*` a `poc-api:3600` |
| `https://geops-staging.duckdns.org/` | Segundo sitio con HTTPS automático y certificado propio administrado por Caddy | `geops-spec02-stage-web:8080`; Nginx sirve la SPA y envía `/v1/*` a `geops-api:3500` |

El [Caddyfile propuesto](../../infrastructure/staging/Caddyfile.poc-proposed) conserva el bloque PoC completo y agrega el sitio DuckDNS; el [overlay](../../infrastructure/staging/compose.poc-edge.override.yaml) monta el archivo en solo lectura y conecta únicamente Caddy a la red privada `geops_spec02_stage_edge`. Caddy reutiliza 80/443 y sus volúmenes actuales; no se copian ni exportan claves de la PoC. El certificado DuckDNS depende de ACME y debe verificarse en el servidor antes de anunciar la ruta. La resolución por nombre y SNI seleccionan el sitio, aun cuando ambos hostnames apunten a la misma IP.

[Compose Staging](../../infrastructure/compose/compose.staging.yaml) mantiene PostGIS, redes, volúmenes, secretos y límites de recursos independientes; no publica Web, API ni DB. Caddy → Web usa HTTP dentro de un bridge Docker privado del mismo host; Web → API usa la red interna `stage_app`. Quien controle el host Docker o integre contenedores a esa red conserva acceso al salto privado.

## Web, API, sesión y Android

La Web se construye con base `/`; React Router usa raíz y los clientes llaman `/v1/*`. El desarrollo local conserva base `/` y proxy Vite. Refresh y enlaces internos se resuelven por fallback SPA; assets inexistentes devuelven 404.

La API Staging permite solo `Origin: https://geops-staging.duckdns.org` para mutaciones. Usa cookie **host-only** `__Host-geops_stage_admin; Path=/; Secure; HttpOnly; SameSite=Strict`, sin atributo `Domain`, con nombre y secretos distintos de la PoC. Login, logout y CSRF conservan su contrato; el backend sigue aplicando capacidades y tenant. El prefijo `__Host-` exige HTTPS, `Path=/` y ausencia de `Domain` en navegadores compatibles. Un script del origen PoC ya no puede leer respuestas del origen DuckDNS mediante la Same Origin Policy; un XSS dentro de Staging sigue siendo un riesgo propio que requiere CSP, revisión y pruebas de navegador. La separación por hostname no sustituye autorización backend.

Android expone la constante sintética `SYNTHETIC_STAGING_BASE_URL=https://geops-staging.duckdns.org/` para la futura activación. `PopHttpClient` acepta una base HTTPS raíz, rechaza prefijos, query, fragmento y rutas ambiguas, y firma la misma ruta canónica `/v1/device/*` que llega a Fastify sin strip. Mantiene nonce nuevo por solicitud, reintentos y rechazo de redirecciones. No se ha conectado una APK a un dispositivo.

## Evidencia local

- Caddy 2.10.2: `adapt`, `validate` y ensayo HTTP aislado por Host pasaron. Se verificaron rutas PoC y DuckDNS, aislamiento de upstreams y paso de Authorization, Origin, nonce y Cookie a Staging.
- `docker compose config` original y con overlay, más Compose Staging, pasó sin puertos públicos nuevos ni cambio en puertos/volúmenes/variables de la PoC.
- Build Web/API/contratos, typecheck, contratos y suite Node/Web pasaron; 15 pruebas Kotlin/JVM sintéticas pasaron con vector PoP compartido.
- Lint, escaneo de secretos y `git diff --check` se verifican en el cierre de este cambio. No se ha probado HTTPS real, emisión/renovación del certificado DuckDNS, navegador E2E, carga o teléfonos.

## Procedimiento posterior de despliegue — no ejecutado

1. Obtener aprobación de cambio y revisión independiente; comprobar DNS efectivo, control del hostname, salida ACME, puertos 80/443, recursos y Caddyfile/Compose activos. Registrar el estado de `/`, `/api/*`, `/health/*`, TLS y volúmenes PoC, y disponer de copia exacta del Caddyfile original.
2. Crear la red bridge privada `geops_spec02_stage_edge` y los secretos exclusivos de Staging. Fijar `GEOPS_STAGE_ORIGIN=https://geops-staging.duckdns.org` y una etiqueta de imagen inmutable. Validar Compose y el gate de restauración antes de arrancar.
3. Construir la Web con base `/`; iniciar DB/API/Web Staging sin puertos publicados. Validar health checks y migraciones solamente en su DB independiente. No activar Android ni datos reales.
4. Montar el Caddyfile propuesto mediante el overlay PoC en una ventana de cambio. Validar Caddy y comprobar el certificado DuckDNS; no tocar las claves/volúmenes PoC.
5. Probar HTTPS de ambos hostnames: rutas PoC; raíz, assets, refresh, `/v1/*`, login/logout, cookie `__Host-`, Origin, CSRF, 401/403/404/429, PoP, aislamiento de respuestas y ausencia de puertos extra. Hacer E2E de navegador con identidades sintéticas y ejecutar el rollback si se altera la PoC.

## Rollback posterior — no ejecutado

1. Restaurar el Caddyfile y Compose originales de la PoC, retirando el overlay, sin borrar `/data` ni `/config` de Caddy. Validar TLS y rutas PoC.
2. Detener API/Web/DB Staging después de conservar logs y backup para diagnóstico. Desconectar la red privada solo cuando no tenga contenedores conectados; mantener volúmenes y secretos para una decisión de recuperación.
3. Cuarentenar cualquier DB restaurada y aplicar el gate de restore antes de reabrirla. Rotar secretos Staging si existe sospecha de exposición.

## Gates pendientes

Certificado y enrutamiento HTTPS efectivos en el servidor, E2E de navegador, revisión independiente de seguridad y privacidad, prueba de carga/restore operativos y validación física Android. La configuración preparada no autoriza despliegue ni uso operativo.
