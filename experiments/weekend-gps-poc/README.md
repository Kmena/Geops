# POC-GPS-001 — experimento aislado de fin de semana

**Estado:** en desarrollo; sin APK compilada, sin despliegue cloud y sin prueba física aprobada. Este módulo no modifica la autenticación, época de seguridad, cuarentena ni base de Wave 0A. SPEC-00 sigue BLOCKED y Wave 0A sigue IN_PROGRESS.

## Arquitectura

APK Kotlin (inicio manual, Fused Location Provider, servicio visible) → Room con payload cifrado en Android Keystore → WorkManager con red y backoff → API Fastify experimental → PostgreSQL/PostGIS exclusivo → dashboard React + Leaflet. No hay MDM, empleados, clientes, rutas comerciales ni GPS corporativo definitivo.

El servidor crea invitaciones aleatorias de 256 bits con vigencia de 10 minutos; el QR contiene URL HTTPS, ID de entorno e invitación, sin clave administrativa. La inscripción consume el secreto una sola vez y devuelve un bearer individual revocable. Es una **identidad experimental**; no reemplaza ADR-012 (PoP, attestation y verificación MDM). Solo se permite un dispositivo activo. Los tokens se guardan cifrados mediante Android Keystore. El dashboard requiere sesión administrativa con cookie HttpOnly/SameSite y CSRF+Origin para mutaciones.

La API rechaza ingesta por defecto. La APK compilada por defecto tampoco inicia captura. Solo después de la aprobación explícita del operador se habilitan ambos gates, se compila una APK identificada y se realiza la prueba física. La frecuencia de 60 segundos es un objetivo, no una garantía de Android. Se solicita permiso de ubicación mientras la actividad es visible y se mantiene una notificación durante el servicio. [Restricciones oficiales de foreground services](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) y [tipo location](https://developer.android.com/about/versions/14/changes/fgs-types-required).

## Desarrollo sintético

Requiere Node 24, npm y Docker Linux accesible. En este directorio:

1. Ejecutar npm ci --ignore-scripts, npm test y npm run build.
2. Generar contraseña de administración de al menos 16 caracteres con node api/hash-password.mjs. El resultado es salt:hash; no registrar la contraseña ni el hash en Git.
3. Crear infra/.env.local ignorado con POC_DB_PASSWORD aleatoria, POC_ADMIN_PASSWORD_HASH y POC_RETENTION_HOURS=72. No copiar OAuth ni secretos de otros proyectos.
4. Comprobar que 3601 está libre y que Compose no reutilizará redes ni volúmenes ajenos. Ejecutar docker compose --env-file infra/.env.local -f infra/compose.dev.yaml config --quiet (no imprimir config completo) y luego up -d --build.
5. La web local queda en http://127.0.0.1:3601. Ingesta permanece apagada salvo que se establezca POC_CAPTURE_ENABLED=true **solo para datos generados**. Android exige HTTPS y no se inscribe contra HTTP local.
6. Parar con docker compose --env-file infra/.env.local -f infra/compose.dev.yaml down sin -v para conservar la base.

El build Android requiere SDK API 36, JDK 17, Android Studio/Gradle 8.13 y dependencias Maven de Google. Abrir android/ en Android Studio; la variante por defecto bloquea GPS físico. El proyecto no incluye wrapper ni APK firmada. Compilar con -PpocApiOrigin=https://DOMINIO_VERIFICADO y -PpocRealCapture=true **únicamente después** de la aprobación de la prueba. El dominio queda fijado dentro de la APK; una invitación QR de otro origen se rechaza. Usar firma de debug solo para el teléfono autorizado; registrar hash SHA-256 de la APK fuera de Git.

## Endpoints

| Método y ruta | Actor | Uso |
| --- | --- | --- |
| POST /api/admin/login, GET /api/admin/me, POST /api/admin/logout | Admin | Sesión experimental |
| POST /api/admin/invitations | Admin | Invitación de un uso |
| GET /api/admin/devices | Admin | Inventario |
| POST /api/admin/devices/:deviceId/revoke | Admin | Revocación |
| GET /api/admin/devices/:deviceId/latest | Admin | Última ubicación |
| GET /api/admin/devices/:deviceId/history?from&to | Admin | Historial UTC |
| GET /api/admin/devices/:deviceId/metrics?from&to | Admin | Capturas, intervalos y precisión |
| GET /api/admin/devices/:deviceId/sync-status | Admin | Comunicación reciente/desconocida |
| POST /api/device/enroll | Invitación | Consume QR |
| GET /api/device/status | Dispositivo | Identidad y gate |
| POST /api/device/locations/batches | Dispositivo | ACK tras transacción |

El lote acepta 1–50 eventos y como máximo 64 KiB. El servidor asigna identidad desde el token, no del cuerpo. La clave de idempotencia es (device_id,event_id); contenido distinto con el mismo ID devuelve 409 y revierte todo el lote. Las lecturas de recorrido se limitan a 5000 puntos y al rango de retención. El cliente conserva eventos hasta confirmar IDs aceptados o duplicados. Cuando no hay Internet, Room persiste y WorkManager reintenta con backoff. La ausencia de un fix de ubicación no se reemplaza con la última posición.

## Gates

- [Evidencia local](docs/evidence.md): controles ejecutados y límites.
- [Despliegue cloud](docs/deployment.md): el operador confirmó acceso entrante por 18.209.159.208. La plantilla Caddy usa un certificado público IP de corta duración y publica solo 80/443; EC2 Public IPv4, Elastic IP y TLS real siguen pendientes. Incluye preflight de solo lectura.
- [Aprobación y privacidad](docs/approval.md): identificar teléfono autorizado, persona operadora, fecha límite de borrado, aviso y acceso al mapa.
- [Prueba física](docs/field-checklist.md): todos los resultados siguen PENDING hasta ejecución.
- No publicar, desplegar, inscribir ni capturar ubicaciones reales sin aprobación explícita. No equiparar esta identidad bearer con la identidad definitiva ADR-012.
