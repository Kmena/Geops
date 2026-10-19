# W1-C — implementación sintética y estado de gates (2026-10-19)

**Estado: IMPLEMENTACIÓN PARCIAL, W1-C NO COMPLETA.** Rama `codex/spec-02-wave-1`. No se creó APK, no se instaló en teléfonos, no se capturó GPS real, no se consultó el servidor PoC y no se tocó ManageEngine. El trabajo previo sin commit se preservó.

## Código nuevo

- [`apps/android-agent/src/main`](../../apps/android-agent/src/main): núcleo Kotlin JVM con `PolicyEngine`, `TrackingController`, `HealthDiagnosis`, `EncryptedFileAgentStore`, `BatchSync`, parser estricto de snapshot y cliente HTTPS con bearer + bytes PoP `GEOPS-REQ-V1`.
- [`apps/android-agent/src/android`](../../apps/android-agent/src/android): adaptadores Android compilados por separado: `BatteryManager`/`ACTION_BATTERY_CHANGED`, `PowerManager`, `ConnectivityManager`, `LocationManager`, reloj monotónico, carga de claves existentes `AndroidKeyStore` y servicio `location` con notificación visible. El manifiesto es un fragmento para una futura app de producto; no está conectado a UI/activación/ciclo de vida.
- [`apps/android-agent/src/test`](../../apps/android-agent/src/test): 14 ensayos sintéticos ejecutables con reloj, FGS, GPS, batería, red, transportes y ACK falsos.
- [GPS-HEALTH-001](gps-health-change-proposal.md) y [OpenAPI delta](openapi.health.proposed.yaml): propuesta SDD separada; `openapi.design.yaml` de W1-A no cambió. `health_interval_s` de 300 s solo es valor sintético mientras se aprueba el contrato.

## Resultado funcional sintético

El motor valida identidad/instalación, versión no decreciente, vigencia, RTT ≤30 s, ancla por boot, deriva civil ≤5 min, offline ≤12 h y fin exclusivo de instancia UTC. No calcula horario local para autorizar capturas. Un cambio de revisión cierra la sesión anterior con `POLICY_REPLACED` antes de aplicar la nueva; un tombstone impide nuevas capturas. El intento de FGS fallido emite `MISSED_START` y nunca `STARTED`. El evento `STARTED` se persiste tras reporte de notificación visible y registro del proveedor; posiciones requieren además sesión activa y hora de captura posterior al inicio efectivo. Un callback tardío tras cierre no entra en cola.

La salud se muestrea con cadencia separada dentro de ventana aunque no haya coordenada. Guarda `due_at` y `observed_at`, batería/carga/cargador/ahorro/proveedor/red/FGS y etiquetas directas; `NO_COMMUNICATION` y posible apagado por batería son inferencias futuras del servidor. El buffer usa AES-GCM, escritura a temporal y reemplazo, límite de 10 000 eventos/4 MiB, IDs y timestamps estables. Un 200 elimina solo IDs aceptados/duplicados tras validar `batch_id`/`persisted_at`; 202, ACK incompleto, 429 y falla de red conservan datos; 422 aísla IDs inválidos y 409 los pone en cuarentena. Las colas GPS, sesión y salud están separadas. La cola de salud no sale por HTTP sin activar explícitamente el contrato aprobado.

## Evidencia ejecutada

| Gate | Resultado y límite |
| --- | --- |
| Compilación Kotlin | `K2JVMCompiler 2.3.0` compiló núcleo y tests en JRE 8; adaptadores Android compilaron contra `android.jar` local. `Gradle`/AGP y APK aún no ejecutados: no hay JDK 17 de proyecto ni app de producto empaquetada. |
| Unitarias/persistencia/sync | 14/14 pruebas sintéticas PASS: UTC, expiración, downgrade, identidad, RTT, PoP/ECDSA, FGS fallido, cadencias, batería 2%, GPS/red separados, cambio de política, reboot, AES-GCM/tamper, 202/200/422, ACK malformado/backoff. No equivalen a instrumentación Android. |
| Vectores W1-A | `node --test --test-isolation=none specs/spec-02-android-agent-wave-1/contract-vectors.test.mjs`: 15/15 PASS en modelo JS, incluidos V01–V12. El cliente Kotlin cubre subconjuntos pertinentes; V04/V09–V11 pertenecen a backend/admin y su paridad end-to-end sigue abierta. |
| Contratos SPEC-01 | `npm run contracts:check` PASS; tests de bytes PoP 4/4 PASS; pruebas API foundation/MDM 12/12 y MDM OAuth 18/18 PASS. Se usó `--test-isolation=none` donde el runner predeterminado arrojó `spawn EPERM`. |
| Delta de salud | `SwaggerParser.validate` PASS para `openapi.health.proposed.yaml`. Sin migración/endpoint ni aprobación SDD, por lo que la ingesta y última vista no tienen PASS. |
| Seguridad | Revisión local: límites de tamaño, TLS, no redirects, PoP, estado cifrado, rechazo de ACK parcial y cierre por reloj/boot. Revisión independiente, prueba de rollback de archivo, key lifecycle, restauración y carga siguen abiertas. |
| Restricciones Android | Fuente oficial revisada: [inicio FGS desde fondo](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [tipos FGS](https://developer.android.com/develop/background-work/services/fgs/service-types), [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager), [LocationManager](https://developer.android.com/reference/android/location/LocationManager) y [NetworkCapabilities](https://developer.android.com/reference/android/net/NetworkCapabilities). Compilación contra stub Android **no** demuestra comportamiento en Android 12–15/OEM. |

## Gates abiertos y riesgos

1. Falta integrar app Android definitiva: activación de identidad/Keystore, boot ID persistente por reinicio, permisos, UI visible que inicie FGS legalmente, conexión Binder/controlador, callback con tiempo monotónico del `Location`, timer/scheduler y red/WorkManager. El código actual no enciende GEOPS automáticamente tras batería/reinicio. Android puede bloquear inicio desde fondo; se debe registrar `MISSED_START` y requerir acción visible según OS/MDM real. P06/P12 no tienen PASS físico.
2. `GET /v1/device/config` y los endpoints de ingesta de sesiones/posiciones corresponden a T09/E1 y aún no se verificaron con este cliente. El `session_id` canónico y las dependencias fuera de orden son comportamiento esperado del backend, no demostrado aquí. La telemetría necesita aprobación de delta, entidad/migración, ingesta, lectura con permiso, auditoría y retención antes de Web/E1. No hay clasificación efectiva `NO_COMMUNICATION` en servidor.
3. AES-GCM protege confidencialidad/integridad del archivo, pero no impide restaurar una copia cifrada vieja con la misma clave; el contador de versión está dentro del mismo archivo. Tras reinstalación/restauración, debe exigirse revalidación server-side y epoch de instalación. No se probó `fsync` de directorio, apagado abrupto ni alta carga en filesystem Android. Política de purga y cuarentena 7/90 días pendiente; overflow falla explícitamente y detiene trabajo, requiere manejo de incidente en app.
4. El envío puede continuar fuera de ventana solo con identidad vigente; revocación sin red conserva riesgo residual hasta 12 h según ADR-017. El cliente no puede impedir que el usuario apague ubicación ni garantizar FGS en todos los OEM. Privacidad, indicadores y licencias MDM permanecen gates separados de SPEC-00.
5. La revisión de seguridad fue del propio cambio, no una revisión independiente. La paridad de Kotlin con V01–V12 completos, OpenAPI health aprobado, PostgreSQL desechable para E1, restore y matriz física siguen pendientes. Por eso no se declara cierre de W1-C.

## Procedencia Git

Preflight: rama `codex/spec-02-wave-1`, HEAD `d72cdb49d95915f8772ffcb6818698e4439c1a57`. El árbol ya tenía modificaciones y archivos sin seguimiento en API, contratos, SPEC-00, ADR-014–017 y SPEC-02/W1-B; se preservaron. Esta entrega añadió `apps/android-agent/` y los documentos de salud/W1-C. No hubo commit, push, merge ni despliegue.
