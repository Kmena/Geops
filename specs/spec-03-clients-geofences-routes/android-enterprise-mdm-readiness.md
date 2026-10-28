# GEOPS Android Enterprise Fully Managed: auditoría y preparación local

Estado: `LOCAL_TECHNICAL_PARTIAL`, `PENDING_PHYSICAL_VALIDATION`, sin instalación, publicación ni cambios en staging.

## Brechas y decisiones

| Control | Estado local | Límite |
|---|---|---|
| Instalación silenciosa | APK única y configuración administrada declarada | Android no inicia la actividad por el hecho de instalar; verificar en el tenant la opción ManageEngine Self Service **Launch app after installation** para `com.geops.mobile`. |
| Primera apertura | La actividad lee `RestrictionsManager`, atiende cambios mientras está visible y rechaza configuración pendiente, incompleta, vencida o de otro equipo; tras el alta detiene GPS si cambia la identidad administrada | El disparo inicial por ManageEngine y el orden instalación/configuración/arranque requieren ensayo Fully Managed. |
| Alta | Invitación de 24 h y un uso, ligada en API al vínculo MDM Android vigente; firma del desafío con clave Android Keystore y activación automática | El secreto de la configuración reside también en el proveedor MDM hasta su consumo; restringir acceso administrativo y asignarlo a **un equipo**. No hay atestación física del dispositivo. |
| Inicio GPS sin empleado | Tras el alta, la actividad visible inicia el servicio si MDM ya concedió ubicación precisa, ubicación permanente y notificaciones | Si falta un permiso, GEOPS no simula captura: muestra diagnóstico. Validar que la versión de ManageEngine y Android permita preconcederlo. |
| Reinicio y actualización | `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED` y redelivery del servicio recuperan solo dentro de política válida | Android/OEM puede bloquear el inicio. Force-stop no genera una recuperación garantizada. Tras reinicio se exige validación de política con el servidor. |
| Sin red | Cola cifrada, ACK GPS v2 e intención local preexistentes | La autorización offline sigue limitada a 12 horas. Al vencer, la captura se detiene hasta obtener configuración autenticada. |
| Ícono launcher | Se conserva en release | ManageEngine documenta lanzamiento por nombre de paquete tras instalación. Quitar `MAIN/LAUNCHER` antes de verificar ese mecanismo podría impedir el primer arranque y el diagnóstico. La notificación del servicio de ubicación permanece visible. |
| Firma release | Gradle acepta exclusivamente un keystore y credenciales externas; sin ellos genera APK **sin firmar** | Falta clave release autorizada y cotejo de certificado con la APK ya instalada. No hay artefacto publicable firmado. |

## Permisos y Android 14–16

GEOPS declara `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` y `POST_NOTIFICATIONS`. El servicio usa tipo `location` y una notificación persistente. La actividad comprueba permisos antes del inicio administrado. En Android 14+ no basta conceder ubicación mientras se usa la app para iniciar desde background: se necesita `ACCESS_BACKGROUND_LOCATION` y una excepción aplicable al inicio del servicio. GEOPS **no es** el Device Policy Controller; ese papel pertenece al agente MDM. En Android 15 las restricciones de `BOOT_COMPLETED` afectan varios tipos de servicio; `location` no figura en esa lista, pero se mantienen los requisitos de ubicación y las restricciones del fabricante. En Android 16 los jobs de background iniciados desde un foreground service consumen cuota. Las optimizaciones de batería y el encendido de ubicación son políticas/dispositivos que deben verificarse físicamente, no permisos que GEOPS pueda otorgarse a sí misma.

En ManageEngine, revisar **App Permissions** del APK Enterprise para ubicación precisa, ubicación en segundo plano y notificaciones; registrar el resultado efectivo en Android Settings y con `adb` en el laboratorio autorizado. Si la consola no ofrece alguno o el OEM lo revoca, clasificar el escenario como `PENDING_PHYSICAL_VALIDATION` y no prometer captura sin intervención.

## Recuperación solicitada desde backend: contrato propuesto

No se añadió un canal remoto de ejecución. El contrato futuro, separado del protocolo GPS v2, debe usar una solicitud autenticada por administrador, tenant, equipo, instalación, motivo, caducidad e idempotency key. Estados:

1. `REQUESTED`: solicitud persistida; **no** significa que el teléfono la recibió.
2. `DELIVERED`: la instalación autenticada hace polling y confirma el ID usando PoP mientras la app está ejecutándose o visible. El backend registra hora e instalación.
3. `RECOVERED`: la instalación informa inicio del listener y el backend observa después un evento GPS/heartbeat válido bajo la política vigente. Un ACK de transporte por sí solo no basta.
4. `FAILED`: rechazo explícito del cliente o vencimiento; guardar motivo (`permission_missing`, `policy_expired`, `delivery_timeout`, `android_start_denied`, etc.). Reintentos conservan la misma identidad y no duplican trabajo.

El polling no despierta una app detenida. Como canal de arranque, solo se considera la opción documentada de ManageEngine **Launch app after installation**, o una acción MDM futura cuya disponibilidad se pruebe en este tenant. No se presupone API remota de ManageEngine para arrancar apps. No se atribuirá `DELIVERED` a una orden enviada a la consola ni `RECOVERED` a una apertura sin muestra. Este mecanismo queda `DESIGNED_NOT_IMPLEMENTED` hasta validar el canal físico y autorizar su integración.

## Build release y actualización

Gradle exige las cuatro variables `GEOPS_ANDROID_RELEASE_KEYSTORE`, `GEOPS_ANDROID_RELEASE_STORE_PASSWORD`, `GEOPS_ANDROID_RELEASE_KEY_ALIAS` y `GEOPS_ANDROID_RELEASE_KEY_PASSWORD` juntas. El keystore debe estar fuera del repositorio; no generar una clave nueva ni usar una de laboratorio. Ejecutar `gradle assembleRelease --no-daemon` en un entorno controlado con esos valores inyectados por el operador. Sin ellos el resultado es `apps/android-app/build/outputs/apk/release/GeopsAndroid-release-unsigned.apk` y **no se debe subir**. Verificar el APK firmado con `apksigner verify --verbose --print-certs`, cotejar el SHA-256 del certificado con la instalación actual y registrar SHA-256 del APK y `versionCode`. El candidato usa `versionCode=9`; antes de publicar, verificar que sea mayor que el instalado y que la firma sea la misma. Mantener `applicationId=com.geops.mobile`.

Si no existe una identidad release aprobada, el operador debe decidir primero si hay una APK instalada cuya firma deba conservarse. Para una identidad nueva, obtener autorización explícita antes de generarla; crearla en un almacén corporativo protegido o estación de firma controlada, custodiar alias y contraseñas en un gestor de secretos, guardar respaldo cifrado con acceso limitado y registrar el SHA-256 del certificado público por un canal independiente. El proceso de firma debe recibir el keystore mediante montaje de solo lectura y las cuatro variables mediante inyección protegida, sin archivos `.env` en Git ni contraseñas en argumentos o logs. Una APK con certificado distinto no actualiza una instalación existente conservando su identidad y cola cifrada.

## Procedimiento para ManageEngine (pendiente de validación física)

1. Confirmar que el equipo aparece como **Android Enterprise Fully Managed / Device Owner** y que el agente Self Service de ManageEngine está instalado en esa modalidad. Registrar versión de Android, fabricante, versión MDM y titularidad.
2. Obtener de GEOPS la invitación `managed_configuration` para el equipo ya vinculado a su registro MDM. Mantener el secreto fuera de tickets, capturas, logs y documentación. La invitación dura 24 horas y solo funciona una vez.
3. En la consola, ir a **Device Management → App Repository → Add App → Android Enterprise App**, subir la APK release firmada. Verificar package `com.geops.mobile`, versión, firma y presencia de la pestaña **Configurations**. Si el flujo del tenant exige Managed Google Play, aprobar allí la misma aplicación antes de distribuirla.
4. En **Configurations**, asignar individualmente a ese equipo `geops_device_id`, `mdm_device_id`, `invitation_id`, `invitation_secret` y `expires_at`. No aplicar una invitación de un equipo a un grupo. Tras consumirla, retirar `invitation_secret`, `invitation_id` y `expires_at` de la configuración si el tenant lo permite, conservando los dos IDs de identidad: un cambio o ausencia de esos IDs detiene GPS local al abrir GEOPS. En **Permissions**, configurar los permisos de ubicación y notificaciones que el producto permita; verificar el resultado real en el dispositivo.
5. Distribuir la app a ese dispositivo. En **Device Management → App Repository → Self Service app → Custom Launch App Configuration**, probar **Launch app after installation** con `com.geops.mobile`. Confirmar en el teléfono que ManageEngine abre la actividad luego de instalar y aplicar la configuración. No asumir orden ni éxito sin evidencia.
6. Observar en GEOPS el consumo de la invitación, la instalación activa y una política GPS v2 `mdm_continuous`. En el dispositivo confirmar notificación de ubicación, listener, captura, cola offline y ACK exacto. Repetir con reinicio, muerte de proceso, actualización de APK, pérdida de red menor y mayor de 12 h, batería y permisos revocados. Registrar fallos como tales.
7. Para actualizar, cargar una APK con el mismo certificado y `versionCode` mayor en el repositorio y distribuirla primero a un equipo piloto. Verificar `MY_PACKAGE_REPLACED`, continuidad de la cola cifrada y las muestras/ACK. No desinstalar para actualizar: la desinstalación perdería la clave local e impediría reutilizar la invitación consumida.

No se ha ejecutado este procedimiento en ManageEngine ni en un dispositivo real. No modifica el protocolo GPS v2, el límite offline, la cola, ACK ni la política local.

## Validación local de esta ejecución (28/10/2026)

| Verificación | Resultado |
|---|---|
| API `npm test -w @geops/api` | PASS: 67 pruebas (20 + 38 + 2 + 7). |
| Política MDM continua | PASS: 2 pruebas unitarias dirigidas. |
| Integración de inventario MDM | PASS: PostGIS descartable, 32 migraciones. |
| Integración de alta administrada | PASS: segunda base PostGIS descartable, 32 migraciones. |
| API typecheck y build | PASS. |
| Agente Android `syntheticTest` con JDK 17 | PASS: 55 casos. |
| `assembleRelease assembleDebug` con SDK 36 | PASS. APK release **sin firmar** SHA-256 `a02067dbe6090b547bf4666ac8846a877c219620d48c3210b760490bf91d4330`; APK debug SHA-256 `07650b429bff8f8356105f81cf46900730f67c520adb977de03e4b6978f72434`. |
| Android SDK `aapt` y `apksigner` | PASS de metadatos: `com.geops.mobile`, `versionCode=9`, target 35, restricciones administradas y receivers de boot/actualización; `apksigner` confirma que release no tiene firma (`exit=1`). |
| `git diff --check` y XML | PASS. |

El apagado del equipo dañó dos índices Gradle locales; se preservaron con sufijo `.corrupt-20261028` y se regeneraron. La primera repetición de `syntheticTest` usó una imagen JDK 21 y falló por toolchain requerido JDK 17; se repitió con `gradle:8.14-jdk17` y pasó. Ninguno de esos fallos implica un defecto de código. El PostGIS descartable se detuvo. No se probó Android en emulador ni teléfono, ManageEngine real, distribución, permisos efectivos, batería, force-stop o recuperación remota.

## Validación para commit y publicación de rama (28/10/2026)

Se revisaron los 26 archivos cambiados respecto a `e685289`. Todos corresponden al alta MDM administrada, GPS continuo, resiliencia Android, migración 0032, pruebas o documentación de este flujo. El escaneo de patrones de claves privadas, PAT y claves AWS dio cero coincidencias; tampoco hay APK, keystore, certificado privado ni archivo `.env` entre los 26 archivos. Los artefactos `build/` permanecen ignorados por Git. El código conserva GPS v2, la cola cifrada, ACK y autorización offline de 12 horas.

| Verificación ejecutada de nuevo | Resultado |
|---|---|
| API `npm run test --workspace @geops/api` | PASS: 67 pruebas (20 + 38 + 2 + 7). |
| `mdm-continuous.unit.test.mjs` | PASS: 2 pruebas. |
| MDM inventario y alta administrada | PASS: dos bases PostGIS descartables, 32 migraciones cada una. |
| GPS policy/config/events | PASS: 48, 24 y 69 aserciones respectivamente, cada suite en su base descartable con 32 migraciones. |
| Alta existente `device:enrollment:integration` | PASS tras corrección de 0032 en otra base descartable con 32 migraciones. La primera corrida detectó que la nueva restricción impedía acortar una invitación para marcarla vencida; se preservó el comportamiento histórico y se repitió con éxito. |
| Build y typecheck de contratos, API y Web | PASS. |
| Lint dirigido a 10 archivos API | Sin errores; 11 advertencias `noNonNullAssertion` en líneas preexistentes fuera de este diff. |
| Agente Android `syntheticTest` en JDK 17 | PASS: 55 casos. |
| Android `assembleRelease assembleDebug` con SDK 36 | PASS; lint vital release incluido. |
| `aapt` y `apksigner` sobre release v9 | `com.geops.mobile`, `versionCode=9`, `versionName=0.1.8-enterprise-candidate`. `apksigner` devuelve `DOES NOT VERIFY` porque el APK está sin firmar, como se esperaba. |

APK release **sin firmar**: `apps/android-app/build/outputs/apk/release/GeopsAndroid-release-unsigned.apk`, SHA-256 `a02067dbe6090b547bf4666ac8846a877c219620d48c3210b760490bf91d4330`. No es publicable ni instalable como actualización. Las cuatro variables `GEOPS_ANDROID_RELEASE_*` están ausentes. La única clave Android identificada en ubicaciones conocidas es `geops-test.jks`, una identidad de prueba que no se utilizará. `RELEASE_SIGNING = BLOCKED_PENDING_APPROVED_KEY`; certificado release y hash de APK firmada pendientes.

Las pruebas físicas de ManageEngine Fully Managed, primer lanzamiento automático, permisos efectivos, continuidad 24/7, batería, reinicio y actualización siguen `PENDING_PHYSICAL_VALIDATION`. No se modificó staging ni se instaló la APK.

Fuentes oficiales: [Android Managed Configurations](https://developer.android.com/work/managed-configurations), [restricciones de FGS en background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [cambios FGS Android 14–16](https://developer.android.com/develop/background-work/services/fgs/changes), [ManageEngine App Permissions and Configurations](https://www.manageengine.com/mobile-device-management/help/android_for_work/mdm_app_configurations_and_permissions.html), [ManageEngine Custom Launch App](https://www.manageengine.com/ca/mobile-device-management/help/profile_management/android/memdm_app_config_manual.html), [ManageEngine Android Enterprise App Repository](https://www.manageengine.com/mobile-device-management-msp/help/app_management/mdm_creating_app_repository.html).
