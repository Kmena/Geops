# SPEC-05 — Contrato ejecutable de diagnóstico v1 (Wave 2)

## Envío de dispositivo

`POST /v1/device/diagnostics/snapshots` usa el bearer de sesión y la prueba PoP existentes sobre la ruta y bytes exactos. Límite 16 KiB, esquema `1`. La APK suministra `installation_id`, `boot_id`, `sequence>0`, `observed_at` UTC, `app_version`, fabricante/modelo/Android, cuatro permisos, siete señales de ejecución, estado GPS, tiempos de callback/captura/ACK, posiciones pendientes, configuración GPS y hasta cinco errores de código cerrado. No se aceptan campos desconocidos, texto libre de error, coordenadas, tokens ni `device_id` o tenant declarados por el cliente. El servidor deriva dispositivo y tenant de la sesión, instalación activa y vínculo MDM/GEOPS; deniega intercambio de instalación. Fuente por grupo: Android o GPS v2 local.

Respuesta `201`: `{snapshot_id,accepted_at,duplicate:false}`. Reintento idéntico `(installation_id,boot_id,sequence)` con el mismo digest: `200` y `duplicate:true`. El mismo identificador con contenido distinto devuelve `409 diagnostic_sequence_conflict`. Otros resultados: `401` PoP/sesión, `403` instalación, `422` esquema o tiempo fuera de 30 días/5 minutos futuros, `429` más de 30 snapshots por instalación en 15 minutos (con `Retry-After: 900`), `413` cuerpo excesivo. La secuencia se conserva al reintentar desde la cola cifrada. No se modifica `/v2/device/gps/batches`, ACK ni posiciones.

`GET /v1/device/diagnostics/self` exige PoP y devuelve el último snapshot de la instalación propia con hallazgos, sin capacidades administrativas ni política ManageEngine. La caducidad se calcula al leer: 15 minutos iniciales, pendiente de calibración física.

## Lectura administrativa

Sesión web existente, permiso `mdm.diagnostics.view`, usuario ACTIVE y grants no revocados de `gps_data_tenant_access` y `gps_health_tenant_access` para el tenant del equipo. Identificadores válidos de otros tenants devuelven `403`. Se auditan lecturas por dispositivo e historial. Ningún permiso se concede automáticamente en la migración.

| Ruta GET | Respuesta |
| --- | --- |
| `/v1/admin/mdm/devices/:id/diagnostics` | Último snapshot según `observed_at`, secuencia y recepción; fuentes, hallazgos y `applied_manageengine: UNKNOWN` |
| `/v1/admin/mdm/devices/:id/diagnostics/history?limit=1..100` | Historial ordenado; por defecto 25 |
| `/v1/admin/mdm/devices/:id/diagnostics/permissions` | Permisos efectivos y hallazgos relacionados |
| `/v1/admin/mdm/devices/:id/diagnostics/findings` | Hallazgos activos reevaluados por frescura |
| `/v1/admin/mdm/devices/:id/diagnostics/capture-transmission` | Callback/captura/ACK/cola/auth y hallazgos asociados |
| `/v1/admin/mdm/diagnostics/summary` | Denominador, problemas, caducados, permisos/captura/transmisión y contadores locales del proceso |
| `/v1/admin/mdm/diagnostics/problems` y `/stale` | Hasta 500 dispositivos visibles, con bandera `truncated`; no representa un total global si se trunca |

Hallazgos `CONFIRMED`, `POSSIBLE`, `INSUFFICIENT_EVIDENCE`, `OFFLINE` o `STALE`. Una ausencia o snapshot viejo nunca produce `GPS_SERVICE_NOT_RUNNING`. `DEVICE_OFFLINE` exige además que no haya recepción reciente de diagnóstico, salud, sesión o posición GPS; con comunicación GPS reciente solo se marca `DIAGNOSTIC_STALE`. `CONFIGURATION_INCOMPATIBLE` compara la modalidad local con `gps_device_ownership` del servidor. La regla `APP_VERSION_OUTDATED` está implementada para un mínimo explícito, pero no se emite en la API hasta definir una versión mínima autorizada: no se infiere del build más nuevo. Los contadores de recepción/rechazo/duplicado/error son locales al proceso y se reinician al reiniciar; los conteos de dispositivos son consultas a la base. Los endpoints MDM de perfil/remediación, solicitud remota y exportación administrativa del SDD permanecen para Waves posteriores.

## Persistencia y recuperación

`0041_device_diagnostics.sql` añade `device_diagnostic_snapshot` inmutable con índice de último por tenant/equipo y unicidad por instalación/boot/secuencia. Conserva payload y findings normalizados bajo validación estricta; no cambia GPS v2 ni políticas MDM. Migrar solo una copia/base descartable en pruebas. Para recuperación de despliegue futuro: copia verificada, detener ingestión, restaurar copia y binario coherente; no aplicar `DROP` a snapshots ni reutilizar secuencias. La política de retención definitiva sigue pendiente de aprobación.
