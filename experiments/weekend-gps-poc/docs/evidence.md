# Evidencia de validación local — POC-GPS-001

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
| Android Kotlin | BLOCKED_BUILD | Hay fuentes Kotlin, manifiesto, Room, WorkManager, Fused Location y prueba JUnit de ACK. No se compiló ni ejecutó: host tiene JRE 8, no JDK 17, SDK Android, Gradle ni wrapper. Workflow futuro preparado, sin ejecución remota. |
| Dashboard en navegador | PENDING_E2E | HTTP y build verificados; login, QR y mapa no se probaron manualmente en navegador contra la API. |
| Buffer offline físico | PENDING | No se probaron reinicio, pantalla bloqueada, desconexión ni recuperación en teléfono. |
| Backup y restauración local | PASS_LOCAL | pg_dump cifrado AES-256-GCM fuera del repositorio; autenticación del archivo, manifest pg_restore y restauración en una base temporal aleatoria con PostGIS y tabla PoC verificados. Base temporal y archivos de prueba eliminados. |
| Script inventario Ubuntu | PASS_SYNTAX_ONLY | bash -n pasó en contenedor local; no se ejecutó en el servidor. |
| Cloud real | BLOCKED | Acceso SSH desde Codex no confirmado; inventario actual, EC2 Public IPv4 y Elastic IP, firewall, emisión/renovación TLS IP y backup/restauración cloud pendientes. El operador confirmó acceso entrante por 18.209.159.208, sin despliegue GEOPS. |
| Captura real | BLOCKED_APPROVAL | APK y API desactivadas por defecto; autorización expresa, retención y privacidad pendientes. |

Se verificó que infra/.env.local está ignorado y no rastreado. Solo contiene credenciales aleatorias sintéticas generadas para Compose local; no se imprimieron. Dist-web también está ignorado. Las pruebas de API y DB no acreditan Android, MDM Free, PoP/attestation de ADR-012 ni producción.
