# SPEC-05 — Informe de cierre técnico de Wave 2 y preparación R1

Fecha: 2026-11-27. Rama: `codex/mdm-diagnostics-wave0`. Decisiones vigentes: ManageEngine único, sin AMAPI, sin cambios GPS v2, sin despliegue ni distribución. Este informe histórico fue aprobado por el usuario como `WAVE2_TECHNICAL_PASS` y `APK_STATIC_UPDATE_COMPATIBILITY_PASS`; Wave 3 se documenta [por separado](WAVE3-CLOSEOUT.md). Wave 1 mantiene `WAVE1_TECHNICAL_PASS`, validación física pendiente, causa GPS no confirmada y `PRODUCTION_READY=NO`.

## Implementación

- Contrato Android v1 estrictamente tipado: `apps/api/src/device-diagnostics-contract.ts`; fuente, timestamps y campos permitidos, sin coordenadas, secretos ni texto libre. `device_id` y tenant se derivan del PoP y vínculo activo, no del payload.
- Persistencia aditiva 0041: snapshots inmutables, digest, clave única instalación/boot/secuencia, orden por observación/secuencia/recepción, índices y recuperación de mantenimiento extendida al esquema 41. No altera eventos ni ACK GPS v2.
- Servicio, reglas y rutas: ingestión con cuota y bloqueo por instalación; retry idéntico idempotente, conflicto de digest 409; sesión administrativa con `mdm.diagnostics.view` y doble grant de tenant. Consultas último, historial, permisos, findings, captura/transmisión, problemas, desactualizados y summary. Comparación aplicada ManageEngine permanece `UNKNOWN`.
- Android: colector Wave 1 emite snapshot v1; cola AES-GCM de hasta 16 reportes en `noBackupFilesDir`, secuencia persistida, envío PoP desde el JobScheduler con red, cambios relevantes y refresco a 15 minutos, reintento de cola tras pérdida de ACK. La pantalla no necesita estar abierta. No se cambió el motor GPS ni la notificación FGS.
- El motor distingue permiso, ubicación, batería, servicio observado/UNKNOWN, captura, ACK, cola, auth, comunicación y diagnóstico viejo. Compara modalidad local con ownership del servidor. La regla de versión mínima funciona con baseline explícito; el backend todavía no tiene baseline aprobado y no emite `APP_VERSION_OUTDATED` automáticamente.
- Propuesta de sesiones APK para Wave 4 y matriz preliminar ManageEngine documentadas. No se creó login paralelo ni escritura MDM.

## Verificaciones separadas

| Estado solicitado | Resultado | Evidencia / límite |
| --- | --- | --- |
| WAVE1_TECHNICAL_PASS | PASS | Aprobación del usuario; [cierre Wave 1](WAVE1-CLOSEOUT.md) |
| WAVE1_PHYSICAL_VALIDATION_PENDING | NOT_RUN | Sin Moto G06 conectado ni captura de ejecución |
| MDM_PROVIDER_MANAGEENGINE_CONFIRMED | PASS | DEC-MDM-001; [SDD](SDD.md) |
| APK_UPDATE_COMPATIBILITY | PARTIAL | APK de referencia v1 y candidata v3: mismo `com.geops.corporate`, certificado y cinco Managed Configurations; no se verificó APK instalada en Moto G06 |
| APK_RELEASE_SIGNATURE_VALIDATION | NOT_RUN | Candidata debug; no se aportó certificado/keystore release oficial |
| ANDROID_DIAGNOSTIC_TELEMETRY_PASS | PARTIAL | Compilación Corporate/Personal y contrato; falta envío en Android real y backend Staging compatible |
| DIAGNOSTIC_PERSISTENCE_PASS | PASS sintético | Migración 0041, ingestión, inmutabilidad, reintentos y recuperación en PostGIS descartable |
| DIAGNOSTIC_RULE_ENGINE_PASS | PARTIAL | 5 pruebas unitarias y hallazgos integrados; falta baseline de versión y calibración física de TTL |
| DIAGNOSTIC_API_CONTRACTS_PASS | PASS sintético | 24 aserciones de integración: payload estricto, endpoints y errores |
| DEVICE_AUTHENTICATION_PASS | PASS sintético | PoP real firmado en integración; anónimo 401, intercambio de instalación 403 |
| RBAC_SECURITY_PASS | PASS sintético | Capacidad ausente 403; permiso no se autoconcede; auditoría administrativa |
| MULTITENANT_ISOLATION_PASS | PASS sintético | Dos tenants en fixture; lectura del ajeno 403, lista limitada al grant |
| OFFLINE_DIAGNOSTIC_RECOVERY_PASS | PARTIAL | Cola cifrada, job y retry compilados; no se ejecutó prueba Android sin red/en recuperación |
| GPS_V2_REGRESSION_PASS | PASS sintético | `gps-mixed` 64 aserciones y `syntheticTest` 61 casos; no equivale a ensayo físico |
| CORPORATE_REGRESSION_PASS | PARTIAL | APK Corporate build/lint y firma; falta instalación y ejecución física |
| BYOD_REGRESSION_PASS | PARTIAL | APK Personal build/lint y suite compartida; falta ejecución física |
| APK_ADMIN_AUTH_DESIGN_READY | PASS diseño | [Propuesta Wave 4](WAVE2-ADMIN-AUTH-PROPOSAL.md), sin implementación |
| MANAGEENGINE_CAPABILITY_DISCOVERY | PARTIAL | [Matriz pública/código](MANAGEENGINE-CAPABILITY-MATRIX.md); edición, licencia, API/scopes del tenant pendientes |
| PHYSICAL_DEVICE_VALIDATION | NOT_RUN | [Protocolo R1](WAVE1-R1-LAB-PROTOCOL.md) preparado |
| GPS_BACKGROUND_ROOT_CAUSE | NOT_RUN | No hay evidencia nueva del Moto G06 |
| GPS_24H_VALIDATION | NOT_RUN | Requiere prueba física autorizada |
| PRODUCTION_READY | BLOCKED (NO) | Firma release, backend desplegado, tenant real y validación física pendientes |

Pruebas adicionales: suite unitaria API existente `20+48+2+7` casos PASS; regresión MDM inventario e inscripción administrada PASS en bases separadas; upgrade 0035→0041 y recuperación de mantenimiento 0035→0041 PASS; typecheck de API/Web/contratos, build API y lint de repositorio PASS. Android `assembleCorporateDebug assemblePersonalDebug lintCorporateDebug lintPersonalDebug` PASS; lint Android: Corporate 0 errores/46 advertencias/2 sugerencias, Personal 0 errores/47 advertencias/2 sugerencias. Las advertencias no se convierten en PASS físico.

## APK y compatibilidad

Corporate candidata: `apps/android-app/build/outputs/apk/corporate/debug/GeopsAndroid-corporate-debug.apk`, 4,315,106 bytes, SHA-256 `9b601b2107b165ae989443fabf9072ce585e11bf51939a88468679ef4d714409`. Personal de regresión: `apps/android-app/build/outputs/apk/personal/debug/GeopsAndroid-personal-debug.apk`, 4,315,263 bytes, SHA-256 `b3f9860e4e2aa4024befe159c91c4ea60e74c9ec7feb1b46e000282e8cbd384f`. Ambas versionCode 3, versionName `1.0.2-spec05-wave2`, minSdk 26. Corporate firma v2 válida, certificado SHA-256 `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8`, igual al APK de referencia proporcionado por el usuario, no necesariamente al instalado.

El registro MDM aportado tiene prefijo `fake-`: no sirve para dirigir distribución ManageEngine. Seguir la [puerta de actualización individual y matriz de diez escenarios](WAVE1-R1-LAB-PROTOCOL.md). Ningún APK se instaló o distribuyó. El backend Staging existente no se actualizó; puede responder 404 al nuevo endpoint y la cola Android conservará snapshots hasta disponer de un backend compatible.

## Riesgos y punto de parada

Faltan evidencia de APK realmente instalada, tenant ManageEngine real/licencia/scopes, firma release, validación de cola Android bajo Doze/OEM, calibración de umbrales y aprobación de retención. Los conteos de flota se limitan a 500 con `truncated`; los contadores de proceso se reinician al reiniciar la API. No se atribuirá offline físico solo por snapshot viejo. **Detenerse para revisión antes de Wave 3.**
