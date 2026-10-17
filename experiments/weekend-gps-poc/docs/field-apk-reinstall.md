# APK de campo y reinscripción limpia — POC-GPS-001

Decisión del operador (2026-10-16): se permite reinstalar y reinscribir **un** teléfono autorizado para la PoC. La firma debug nueva no coincide con la instalada, por lo que no se puede actualizar con `adb install -r`. La instalación limpia elimina la identidad y la cola local anteriores. No hay instalación, captura ni despliegue automático.

APK local de campo: `android/build/geops-poc-field-2770730d8b14235c.apk` (copia ignorada por Git), SHA-256 `2770730D8B14235CA4E7AB58DF0A6987288F5440365A6FFFDC1DC1DC7B6F5CC8`, certificado SHA-256 `a9b6af50e746a886d2f1f08ffebee34ff49a6c063fe67e0a163df262eee9ebac`. `apksigner` verificó la APK; `dexdump` confirmó en la clase `BuildConfig` incluida `POC_API_ORIGIN="https://18.209.159.208"` y `REAL_CAPTURE_ENABLED=true`. El artefacto de CI, cuando se publique, usará otra clave debug salvo que se configure firma compartida; no mezclarlo con esta APK local.

## Antes de borrar la instalación actual

El operador informó «Pendientes totales: 0», «Pendientes de identidad actual: 0», «Capturas guardadas: 0» y que no hay información local que conservar. **Volver a comprobar esos tres valores inmediatamente antes de desinstalar** y detener el seguimiento si estuviera activo. Si alguno es distinto de cero, o hay información que conservar, detener el procedimiento. Registrar solo los contadores y el alias del teléfono; no exportar coordenadas, token ni QR a tickets o Git.

El servidor limita la PoC a un dispositivo activo. Tras confirmar que no hay cola ni datos que conservar, revocar la identidad experimental anterior desde el panel antes de generar otra invitación. La revocación y la inscripción se realizan manualmente; este repositorio no las ejecuta. No modificar la API, PostgreSQL ni otros servicios.

## Instalación y verificación sin GPS

1. Compilar `app-debug.apk` con `-PpocApiOrigin=https://18.209.159.208 -PpocRealCapture=true`. Verificar en `BuildConfig` que el origen es exacto y `REAL_CAPTURE_ENABLED=true`; registrar el SHA-256 del archivo y su certificado de firma. Usar esta APK concreta para toda la sesión; builds debug de otros entornos pueden tener otra firma. El build local de campo monta `android/build/field-signing` (ignorado por Git) como `/root/.android` del SDK para conservar la misma clave debug en futuras compilaciones locales. Proteger esa carpeta y guardarla fuera del repositorio antes de limpiar artefactos; no copiarla a Git ni al chat.
2. Tras completar la comprobación de contadores y la revocación anterior, conectar el teléfono autorizado y ejecutar `adb uninstall com.geops.weekendpoc`; comprobar que devuelve `Success`. Ejecutar `adb install android/build/geops-poc-field-2770730d8b14235c.apk` desde la raíz de la PoC. **No ejecutar estos comandos si los contadores o la necesidad de conservar datos siguen inciertos.**
3. Abrir la APK: debe mostrar inscripción pendiente por tratarse de una instalación limpia. En el panel PoC, generar una invitación nueva de un solo uso; escanearla antes de los 10 minutos. Debe aparecer HTTP 201 y el ID abreviado. No reutilizar el QR anterior.
4. Pulsar **Verificar identidad (sin GPS)**. Exigir HTTP 200 y el mismo dispositivo en el panel. Comprobar que el estado de la API informa captura habilitada. Si aparece 401, 403, error TLS, conexión o identidad distinta, detenerse sin iniciar GPS.

## Prueba física manual

La captura comienza **solo** al pulsar **Iniciar seguimiento** y conceder ubicación precisa y notificaciones. Confirmar la notificación persistente «GEOPS GPS PoC activo». Mantener una prueba corta supervisada; comprobar que aumentan «Capturas guardadas» y, con Internet, «Eventos confirmados». Pulsar **Detener seguimiento** al finalizar y confirmar «Seguimiento: detenido». Registrar tiempos, contadores, HTTP sanitizado, batería y hash de APK. No copiar coordenadas exactas a documentación.

Iniciar el servicio desde la pantalla visible: Android 14+ exige permiso de ubicación de tipo «mientras se usa» al crear un Foreground Service de ubicación ([documentación Android](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)). Si Android rechaza el servicio o el proveedor de ubicación, la APK muestra un error de captura; no interpretar «Seguimiento: activo» sin capturas como prueba de GPS funcional.

El objetivo del request de ubicación es 60 segundos; Android y el proveedor pueden entregar intervalos distintos. La cola Room cifrada debe conservar eventos sin Internet y WorkManager sincronizarlos al recuperar conexión. No afirmar PASS físico hasta observarlo en el teléfono y comprobar las posiciones recibidas en el panel.
