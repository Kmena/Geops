# SPEC-02 — revisión de seguridad de `/staging/`

> **Revisión histórica:** el riesgo de origen compartido aquí descrito corresponde a la propuesta anterior. El diseño vigente utiliza [hostname DuckDNS independiente](staging-duckdns-readiness-2026-10-19.md).

**Decisión: `ACCEPTABLE_WITH_MITIGATIONS` para preparar un Staging exclusivamente sintético.** Esta revisión es interna al trabajo; no sustituye una revisión independiente ni autoriza despliegue, datos reales, teléfonos físicos o concesiones operativas. La aceptación efectiva del riesgo de origen compartido corresponde a Seguridad y al propietario de la PoC antes de activar la ruta en el servidor.

## Hallazgos

| Área | Evidencia y conclusión |
| --- | --- |
| Origen compartido | PoC `/` y GEOPS `/staging/` usan `https://18.209.159.208`. La Same Origin Policy permite que JavaScript de una ruta lea respuestas de la otra. Un XSS en PoC puede consultar `/staging/v1/admin/auth/me`; uno en Staging puede consultar `/api/admin/me`. Ambas respuestas entregan el CSRF de la sesión correspondiente. |
| Cookies | PoC usa `poc_admin; Path=/api/admin; SameSite=Strict`; Staging usa `geops_stage_admin; Path=/staging; Secure; HttpOnly; SameSite=Lax`, con claves de sesión distintas. Nombre/path evitan envío accidental al otro backend y las pruebas rechazan cookies ajenas. `Path`, `HttpOnly` y `SameSite` **no separan aplicaciones frente a JavaScript del mismo origen**: el navegador envía la cookie adecuada al `fetch` de cada ruta. |
| Origin y CSRF | Fastify exige Origin exacto para login/mutaciones y CSRF por sesión; la PoC también exige ambos para mutar. Protegen contra sitios externos. Un script inyectado bajo el mismo origen presenta el Origin permitido y puede leer el token CSRF por las rutas `me`; siguen siendo mitigaciones parciales. No se añadió CORS ni endpoint anónimo. |
| Cabeceras y CSP | Nginx Staging entrega CSP restrictiva (`default-src 'none'`, scripts/estilos/conexiones solo `'self'`, `frame-ancestors 'none'`), `nosniff`, `DENY`, `no-referrer`, Permissions-Policy sin GPS/cámara/micrófono y `no-store`. Se verificaron sintaxis y cabeceras HTTP en un contenedor local. La PoC no declara CSP en su Caddyfile ni SPA; la CSP de Staging no restringe scripts que ya corren en la PoC. Incluso `'self'` abarca ambas rutas. |
| Proxy y rutas | Caddy 2.10.2 adaptó el archivo propuesto. Ensayo HTTP aislado: `/` → SPA PoC; `/api/*`, `/health/*` → backend PoC; `/staging/*` → Staging con strip del prefijo. El ensayo confirmó Authorization, Origin, Cookie y nonce a través de `reverse_proxy`. Nginx enruta solo `/v1/*` a Fastify; Compose no publica API/DB/Web. No se verificó el proxy ni certificado del servidor activo. |
| Kotlin/PoP | Kotlin acepta únicamente base HTTPS de raíz o `/staging/` y rutas canónicas `/v1/device/*` ASCII sin query, fragmento, escape o traversal. Construye URL pública con prefijo y firma los bytes `/v1/device/*` que verifica Fastify tras el strip. Node y Kotlin pasaron el mismo vector. Se genera nonce nuevo por solicitud, reintentos vuelven a solicitar y `HttpsURLConnection` no sigue redirecciones. No se confía en `X-Original-URI` del cliente ni se cambió el verificador PoP. |

La firma PoP liga método, path **canónico**, cuerpo, token, tiempo, nonce y clave; el prefijo público `/staging` queda fuera de los bytes firmados. Esto coincide con la ruta verificada por Fastify y no crea un bypass, pero exige que Caddy sea el único traductor autorizado y que no se añada otra ruta pública al mismo backend sin revisión. El rechazo de replay y duplicados fue probado en PostgreSQL desechable; el ensayo no equivale a Android físico ni a una prueba del Caddy del servidor.

## Mitigaciones y riesgo residual

Implementadas: cookie y secretos exclusivos de Staging, Origin/CSRF, capacidades del backend, CSP/cabeceras de Staging, Web sin mutaciones operativas, rutas Caddy excluyentes, redes privadas, sin puertos públicos adicionales, firma PoP canónica y rechazo de rutas Kotlin ambiguas. Son controles de defensa en profundidad.

Antes de habilitar Staging sintético: aprobación escrita del riesgo de mismo origen; cuentas de prueba con mínimo privilegio y **sin** concesiones de activación/tenant; solo datos sintéticos; perfiles de navegador separados para administradores PoC/Staging y cierre de sesiones al alternar; validación del Caddyfile/certificado efectivos, cookies, CSP, rutas y headers en el servidor; ventana de cambio y rollback PoC. La separación de perfiles es una medida operativa, no una garantía técnica. La revisión independiente de seguridad y privacidad sigue pendiente.

**Riesgo residual principal:** un XSS en una aplicación puede actuar con la sesión que el navegador mantenga en la otra. Las mitigaciones reducen probabilidad e impacto durante un ensayo sintético, pero no proporcionan aislamiento real. Por ello esta decisión no autoriza datos sensibles ni uso operativo en el origen compartido.

## Alternativa de aislamiento real

Si Seguridad o el propietario de la PoC no acepta ese riesgo, usar un hostname controlado independiente, por ejemplo `staging.<dominio-corporativo>` apuntando al mismo servidor. Caddy puede obtener **su propio certificado** para ese nombre y enrutar por Host a `geops-web` en la red privada, conservando los puertos 80/443 y los volúmenes/certificado de la PoC sin exportar claves. Construir la Web con base `/`, exponer API Staging en `/v1/*`, fijar `GEOPS_STAGE_ORIGIN` al nuevo origen y usar cookie host-only exclusiva de Staging. DNS, certificado, configuración exacta, recursos y pruebas HTTPS requieren una propuesta y autorización separadas. Un hostname distinto crea la frontera de origen que un prefijo de path no puede dar.

## Evidencia y gates

- Kotlin/JVM `syntheticTest`: 15 escenarios PASS, incluido prefijo/PoP; contrato Node: 5 pruebas PASS con vector compartido.
- Backend sobre PostGIS desechable: 14 migraciones, configuración GPS 24 aserciones y eventos GPS 69 aserciones PASS; replay/nonce y ACK incluidos. Contenedor desechable detenido.
- Caddy adaptado y ensayo HTTP local de rutas/headers PASS; `docker compose config` original+overlay y Staging PASS; Nginx `-t` y cabeceras de `/` PASS.
- Build, typecheck, Node/Web, lint, contratos, escaneo de secretos y `git diff --check` se registran al cierre de publicación local.
- Pendientes: inspección del servidor/certificado real, E2E HTTPS/navegador, revisión independiente, aprobación del riesgo de mismo origen, carga sostenida/restore operativos y Android físico. Ninguno se declara PASS aquí.
