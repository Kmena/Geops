# Evidencia de validación local — POC-GPS-001

## APK de campo — 2026-10-16

Compilación local con `-PpocApiOrigin=https://18.209.159.208 -PpocRealCapture=true`, sin instalar ni activar seguimiento. `:app:testDebugUnitTest` pasó (14 pruebas, 0 fallos), `:app:lintDebug` y `:app:assembleDebug` pasaron. `apksigner` validó la firma y `dexdump` leyó en el APK `REAL_CAPTURE_ENABLED=true` y el origen HTTPS exacto. Archivo y hash en [field-apk-reinstall.md](field-apk-reinstall.md). Node: 17 pruebas PASS; Biome PASS; Web build PASS; Compose dev/cloud `config --quiet` PASS; `git diff --check` PASS. Prueba física, envío real y CI remoto: PENDING.

Fecha: 2026-10-16. Rama: codex/poc-gps-weekend. Todo dato usado fue sintético. Ninguna prueba Android física, TLS público, backup cloud ni despliegue remoto se ejecutó.

| Control | Resultado | Evidencia / límite |
| --- | --- | --- |
| npm ci --ignore-scripts | PASS_LOCAL | 110 paquetes desde lockfile del módulo. |
| npm test | PASS_LOCAL | 14 pruebas Node: ocho de API y seis de preflight cloud (IPv4 pública, FQDN, dirección inválida/privada, puertos, placeholders, secretos ausentes, captura activa y claves duplicadas). |
| npm run build | PASS_LOCAL | Vite transformó 45 módulos y produjo Web React/Leaflet. |
| Lint y Node syntax | PASS_LOCAL | Biome check en API, Web y scripts de backup; node --check en app, store, server y scripts de backup. Persisten sugerencias informativas de plantillas, sin errores. |
| PostgreSQL/PostGIS | PASS_LOCAL | Base geops_poc aislada; PostGIS 3.6. Prueba real de inserción, deduplicación, conflicto, orden por captura, revocación y purga: 1/1. Fixtures eliminados; tablas dispositivo/ubicación quedaron 0/0. |
| Docker Compose local | PASS_LOCAL | poc-db y poc-api healthy; poc-web running; migración exit 0. Puerto Web solo 127.0.0.1:3601; PostgreSQL sin puerto host. |
| HTTP local | PASS_LOCAL | Web y ready HTTP 200; inventario e ingesta anónimos HTTP 401. Cabeceras no-store, no-referrer y nosniff verificadas en 401. |
| Compose cloud | PASS_TEMPLATE | config --quiet con IPv4 pública reportada y binds 80/443 sintéticos. Solo Caddy tiene bind host; API y DB permanecen internas. Límites CPU/memoria y rotación de logs configurados. No se inició en cloud. |
| Caddy HTTPS/IP | PASS_TEMPLATE | Imagen Caddy 2.10.2 construida localmente y caddy validate válido para 18.209.159.208 con perfil ACME shortlived. No se solicitó ni emitió certificado; renovación y URL HTTPS siguen sin verificar. |
| Android Kotlin | PASS_CI_BUILD | GitHub Actions ejecutó `:app:testDebugUnitTest` y `:app:assembleDebug` con JDK 17, SDK 36 y Gradle 8.13. Artefacto `geops-weekend-poc-synthetic-debug-apk` generado (4,028,067 bytes comprimidos). No hubo instalación ni prueba en teléfono físico; captura real sigue desactivada por defecto. |
| Dashboard en navegador | PENDING_E2E | HTTP y build verificados; login, QR y mapa no se probaron manualmente en navegador contra la API. |
| Buffer offline físico | PENDING | No se probaron reinicio, pantalla bloqueada, desconexión ni recuperación en teléfono. |
| Backup y restauración local | PASS_LOCAL | pg_dump cifrado AES-256-GCM fuera del repositorio; autenticación del archivo, manifest pg_restore y restauración en una base temporal aleatoria con PostGIS y tabla PoC verificados. Base temporal y archivos de prueba eliminados. |
| Script inventario Ubuntu | PASS_SYNTAX_ONLY | bash -n pasó en contenedor local; no se ejecutó en el servidor. |
| Cloud real | BLOCKED | Acceso SSH desde Codex no confirmado; inventario actual, EC2 Public IPv4 y Elastic IP, firewall, emisión/renovación TLS IP y backup/restauración cloud pendientes. El operador confirmó acceso entrante por 18.209.159.208, sin despliegue GEOPS. |
| Captura real | BLOCKED_APPROVAL | Captura de APK y API desactivada por defecto; autorización expresa, retención y privacidad pendientes. |

Se verificó que infra/.env.local está ignorado y no rastreado. Solo contiene credenciales aleatorias sintéticas generadas para Compose local; no se imprimieron. Dist-web también está ignorado. Las pruebas de API, DB y compilación CI no acreditan comportamiento en un teléfono Android, MDM Free, PoP/attestation de ADR-012 ni producción.

## CI remoto

- Commit de implementación validado: `aa2c3f8deea526ebea5ec6e27e5947125b30ceed`.
- Run: https://github.com/Kmena/Geops/actions/runs/38975408830 — `success` el 2026-10-16; jobs `node`, `docker` y `android` concluyeron `success`.
- Node: instalación desde lockfile, 14 pruebas, lint, sintaxis y build Web. Docker: configuración Compose dev/cloud, Caddy y prueba PostgreSQL/PostGIS aislada. Android: prueba JUnit y build debug con artefacto sintético.
- Los tres runs anteriores fallaron en preparación del SDK Android, sintaxis Gradle obsoleta y compatibilidad AndroidX/SDK. Se corrigieron en la rama antes del run exitoso. No se ejecutaron pruebas físicas ni despliegue cloud.
