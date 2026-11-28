# SPEC-05 — Wave 6, primera ejecución W6-A y W6-B solo lectura

Fecha: 2026-11-28. Rama aislada `codex/mdm-diagnostics-wave0`. Alcance autorizado: laboratorio aislado y observación de solo lectura. No se instaló APK, no se cambió ningún dispositivo, política ManageEngine, staging ni producción. No se modificó el motor GPS.

## Estados heredados y gate

La aprobación del usuario registra `WAVE0_PASS`, `WAVE1_TECHNICAL_PASS`, `WAVE2_TECHNICAL_PASS`, `WAVE3_TECHNICAL_PARTIAL`, `WAVE4_TECHNICAL_PASS`, `WAVE5_TECHNICAL_PASS` y `WEB_RUNTIME_UI_VALIDATION_PASS`. Permanecen `MANAGEENGINE_REAL_VALIDATION=BLOCKED`, `APK_INSTALLED_COMPATIBILITY=BLOCKED`, `PHYSICAL_DEVICE_VALIDATION=NOT_RUN`, `GPS_BACKGROUND_ROOT_CAUSE=UNCONFIRMED` y `PRODUCTION_READY=NO`.

| Gate de esta ejecución | Estado | Evidencia |
| --- | --- | --- |
| WAVE6_LAB_ENVIRONMENT | PASS técnico local | PostGIS 18-3.6 descartable, migraciones 0001–0042, API con GPS v2, diagnóstico y workspace MDM, Vite/Chrome; health live/ready y suites descritas abajo. Proveedor MDM simulado. |
| MANAGEENGINE_TENANT_IDENTIFIED | BLOCKED | No se proporcionó URL/tenant real, producto/edición/licencia/versión, región, API/scopes ni acceso de lectura. |
| MANAGEENGINE_REAL_DEVICE_READ / POLICY_READ / PERMISSION_READ | BLOCKED | No hay tenant verificado ni ID MDM real del Moto G06. El `fake-*` comunicado antes es solo un marcador sintético. |
| MANAGEENGINE_REAL_PERMISSION_WRITE | NOT_RUN | Escritura deshabilitada (`mdm_write_disabled`); fuera del alcance de esta ejecución. |
| MOTO_G06_IDENTIFIED / APK_INSTALLED_COMPATIBILITY | BLOCKED | No hay consulta directa del teléfono ni registro MDM verificado. La APK externa de referencia no prueba la instalación actual. |
| APK_CONTROLLED_UPDATE / APK_RUNTIME_UI_VALIDATION | NOT_RUN | Gate de identidad, firma y backend pendiente; no hay autorización de instalación. |
| GPS_BACKGROUND_REPRODUCTION / ROOT_CAUSE_CONFIRMED / FIX_IMPLEMENTED | NOT_RUN / BLOCKED / NOT_RUN | Falta diagnóstico y reproducción física; no inferir causa desde la ausencia de datos. |
| GPS_CAPTURE_BACKGROUND / TRANSMISSION_BACKGROUND / SCREEN_OFF / TASK_REMOVED / REBOOT_RECOVERY / OFFLINE_RECOVERY / ADMIN_LOGOUT_CONTINUITY / OUTSIDE_ROUTE / 24H / BATTERY_CONSUMPTION | NOT_RUN | Requieren equipo real y ventanas de observación. |
| GPS_V2_REGRESSION | PASS técnico local | 68 aserciones de integración GPS mixta, incluidas cuatro nuevas de diagnóstico/workspace en la misma identidad técnica. |
| CORPORATE_REGRESSION / BYOD_REGRESSION | NOT_RUN en Wave 6 | Builds y suites de Wave 5 aprobados; esta ejecución no cambia Android ni genera APK. |
| PRODUCTION_READY | NO | Staging observado es incompatible y faltan tenant, firma/versión instalada y validación física. |

## Inventario de versiones y contratos

| Componente | Worktree / laboratorio | Instalación externa observada | Compatibilidad |
| --- | --- | --- | --- |
| Código | HEAD `b597c9f52f3f53da5e9d9be0fce43351f9eb4561`, cambios Waves 1–5 sin commit en rama aislada | Digest/commit de imágenes no expuesto | No equiparar HEAD con despliegue. |
| API | Fuente Waves 1–5; Node 24; misma instancia de prueba registra auth, PoP, GPS v2/v3, diagnóstico y workspace MDM | `GET /v1/admin/auth/me` → 401 (ruta existe); `GET /v1/device/diagnostics/self` y `/v1/admin/mdm/workspace/summary` → 404 (rutas ausentes); versión exacta desconocida | **BLOCKED** para diagnóstico Wave 4/5. No se probó escritura GPS v2 externa porque la inspección está limitada a lectura. |
| Web | Vite local Wave 5, 20 checks Chrome | `https://geops-staging.duckdns.org/` sirve `/assets/index-BXjeErrG.js`, SHA-256 `4ECEEAC1C76A294627F33600CB98F0C3979F4D19B356B0BF58829378824DBA72`; bundle sin marcador `mdm/workspace/summary` ni título “Diagnósticos”; digest de imagen desconocido | Wave 5 no está demostrado en staging; bundle observado carece de ruta API Wave 5. |
| Base de datos | PostGIS 18-3.6; 42 migraciones aplicadas en base descartable; última `0042_mdm_policy_workflow.sql` | Ledger y versión PostGIS de staging no accesibles sin host/DB de lectura | No se puede aprobar upgrade operativo. |
| GPS | `GET /v1/device/config`, `POST /v2/device/gps/batches`, `POST /v3/device/gps/batches`, ACK por IDs e idempotencia | `GET /v1/admin/gps-policies` → 401, ruta administrativa existe. La ruta POST v2 no se invocó por límite de solo lectura. | Contrato local PASS; versión instalada v2 no verificada. |
| Diagnóstico | PoP `POST /v1/device/diagnostics/snapshots` (201/200 duplicado), `GET /v1/device/diagnostics/self`; lectura/historial admin | `GET /v1/device/diagnostics/self` → 404 | Incompatible con la candidata Wave 4 en staging observado. |
| MDM | ManageEngine mediante adaptador, lectura de perfiles/inventario y comparación; escritura cerrada | `GET /v1/admin/mdm/capabilities` → 404; tenant real desconocido | Solo mock local; capacidades reales BLOCKED. |
| APK Corporate candidata | `com.geops.corporate`, versionCode `4`, versionName `1.0.3-spec05-wave4`, minSdk 26, targetSdk 35, debug, certificado SHA-256 `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8`; APK SHA-256 `426F31CD209A8B0E725FFF24A619FCB8EE32EC7D5794EC12F4B1A8602D36C200` | Paquete, versión, firma y datos instalados en Moto G06 desconocidos | **BLOCKED**; no instalar. |

El `GET /health` de staging devolvió `200 ok` de Nginx. `GET /health/ready` devolvió `200` con HTML del portal por fallback SPA, por lo que **no** valida readiness de API ni DB. La API autenticada responde con JSON en `/v1`, pero no expone una versión exacta pública. Un `GET` a `/v2/device/gps/batches` devolvió 404; esa observación no prueba ausencia de una ruta POST. La comprobación externa fue solo lectura, sin credenciales ni efectos de escritura.

## Evidencia técnica local

1. `pwsh -NoProfile -File scripts/run-spec05-wave3-integration.ps1`: diagnósticos 24 aserciones; políticas/MDM RBAC, aislamiento y write gate; upgrade 0035→0042 y recuperación/checksum; GPS mixto **68 aserciones**. En la misma base y sesión PoP sintéticas, el GPS v2 aceptó sesión+posición y devolvió ACK, luego el dispositivo envió un snapshot SPEC-05 que la lectura admin y la línea temporal Wave 5 proyectaron. La prueba usa ownership BYOD sintético para el contrato GPS y no demuestra ejecución Android Corporate física.
2. `pwsh -NoProfile -File scripts/run-spec05-wave5-browser-e2e.ps1`: API, web y PostGIS descartable en loopback, `/health/live` y `/health/ready` (este último comprueba ledger y PostGIS), Chrome **20 checks** con proveedor ManageEngine simulado. La fixture registra GPS v2/v3, diagnóstico, auth y workspace MDM en una misma instancia. Las sondas locales sin credencial y con JSON válido devolvieron 401 en GPS v2, diagnóstico, políticas GPS y workspace, confirmando rutas montadas. Capturas de portal: `output/playwright/spec05-wave5-{dashboard,device-detail,mobile,complete}.png`.
3. Hash APK verificado con SHA-256 de Windows y `sha256sum`; `aapt dump badging` y `apksigner verify --print-certs` confirmaron metadatos y certificado. No se generó APK nueva.

La migración local `0041_device_diagnostics.sql` tiene SHA-256 `078A74A6151B4AACA2DD937206636A7A230D0B89D22BB1520DF00C7E8DCB0B22`; `0042_mdm_policy_workflow.sql` tiene `D97A207432645007F97AEFD2E57811BD2A418229B68D4DA6745FE14C64581C1A`. Los scripts destruyen solo sus bases/containers sintéticos propios. Las capturas web no son capturas de Android.

Riesgo menor detectado en la sonda local: un `POST /v2/device/gps/batches` vacío y sin `Content-Type` devolvió `500 internal_error`; la misma ruta con JSON `{}` sin credencial devolvió el `401` esperado. La ingesta PoP válida y el ACK pasaron. Registrar la respuesta malformada para endurecimiento del borde HTTP en una tarea autorizada; no atribuirle el fallo de GPS de segundo plano del Moto G06.

## Información y acciones precisas del operador

1. **Staging/host, solo lectura:** proporcionar digest OCI o SHA de imagen API y web actualmente activos, `GEOPS_STAGE_IMAGE_TAG`, configuración efectiva del proxy, salida de health real de API dentro de su red, `SELECT version,checksum,applied_at FROM geops_schema_migrations ORDER BY version`, `SELECT PostGIS_Version()`, estado de gate/mantenimiento y último respaldo verificado. Omitir contraseñas, tokens y secretos. Si el host no es un laboratorio separado, identificar uno antes de cualquier plan de despliegue.
2. **ManageEngine, solo lectura:** nombre exacto de producto, edición/licencia, versión, Cloud u On-Premises, URL/región/tenant y cliente MSP si aplica, catálogo/API/scopes disponibles para la cuenta de lectura, ID MDM real del Moto G06, estado/modo de enrolamiento, último contacto, perfil asignado, aplicaciones y configuración administrada. Una captura o export sanitizado de la consola sirve; no compartir OAuth secret en este informe. Distinguir perfil asignado de permiso efectivo Android.
3. **Moto G06, lectura supervisada:** registrar modelo/serial con custodia local, Android/SDK, ID GEOPS e `installation_id` (sin token), paquete instalado, versionCode/versionName, certificado SHA-256, tipo debug/release, estado de enrolamiento y Managed Configurations. Con ADB autorizado: `adb devices -l`, `adb shell dumpsys package com.geops.corporate` (filtrar versión), `adb shell pm path com.geops.corporate`; extraer la APK instalada a almacenamiento protegido y validar certificado con `apksigner verify --print-certs`. La firma de un archivo de referencia o de la consola no sustituye la de la instalación efectiva. Exportar reporte técnico sanitizado de la APK si existe, con hora UTC, última captura/ACK y longitud de cola; protegerlo como dato sensible.

No se requiere entregar una credencial de escritura. `mdm_write_disabled` permanece activo. La aprobación de instalación **aún no procede**: falta confirmar identidad del teléfono, compatibilidad de firma y versión, backend compatible y preservación de estado.

## Plan de actualización individual y recuperación

1. Mantener el Moto G06 sin cambio. Comparar paquete instalado con `com.geops.corporate`, certificado con `539cc2…3374be8` completo arriba y versionCode instalado **menor que 4**. Si no coincide, detener; no desinstalar, no reenrolar, no borrar datos y no intentar downgrade.
2. Preparar un entorno de laboratorio o staging **aislado** con API y portal Waves 1–5 y esquema 0042. Antes de desplegar, inventariar imágenes/digests, ledger SQL y conteos GPS/diagnóstico; crear respaldo `pg_dump -Fc`, checksum SHA-256 y ensayo de restauración en DB aislada. Verificar el gate de mantenimiento, expansión 0035→0042, health real, login, PoP, diagnóstico, GPS v2/ACK, timeline, RBAC y `mdm_write_disabled`. Conservar imágenes previas y evidencia de restore. La sustitución de imagen anterior no revierte 0041/0042; ante error de migración se requiere recuperación supervisada hacia adelante o restauración validada del respaldo, con la app detenida/gate cerrado.
3. Guardar antes del cambio, bajo custodia, identidad técnica/instalación, vínculo real, datos cifrados, tamaño de cola GPS, última captura y ACK, permisos, configuración administrada y reporte sanitizado. Preparar acceso a logs y ventana con responsable del dispositivo. No extraer ni publicar secretos.
4. Tras aprobación **explícita y específica** de un solo dispositivo, subir la APK debug candidata a ManageEngine del tenant de laboratorio verificado, comprobar hash/versionCode/firma y asignar únicamente al ID MDM real del Moto G06. Mantener perfiles/Managed Configurations, seguimiento y notificaciones Android. Confirmar que no hay otros destinatarios.
5. Verificar actualización in situ, identidad, datos y cola conservados, login/logout, diagnóstico, GPS y ACK antes de escenarios de reproducción. Ante fallo, parar distribución y conservar evidencias. Android puede rechazar downgrade; la recuperación es restaurar servicio/backend compatible y resolver la app con un paquete firmado con el **mismo certificado** y versionCode mayor, sujeto a revisión, sin prometer reinstalación de versión previa. No borrar datos como respuesta automática.

La secuencia de validación física, ventanas de 10/30/60 minutos y 24 horas permanece en la especificación de Wave 6 y en [procedimiento Moto G06](WAVE4-MOTO-G06-UPDATE.md). El primer ensayo autorizado solo preparó laboratorio y lecturas disponibles. Próximo gate: recibir evidencias anteriores, recalcular matriz de compatibilidad y presentar una solicitud concreta de despliegue de laboratorio y, después, de instalación individual. No iniciar Wave 7.
