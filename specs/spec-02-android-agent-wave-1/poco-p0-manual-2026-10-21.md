# POCO — preparación de prueba manual P0

**Estado:** preparado, no ejecutado. No hay PASS físico ni despliegue de la API.
Esta APK permite observar la corrección de subida P0; no implementa todavía
ADR-020 ni las Waves A–D de ubicación autónoma. Por ello los tramos de
pantalla apagada, nueva jornada offline y arranque automático de Wave E deben
esperar a una APK posterior.

## Artefacto identificable

- APK: `apps/android-app/build/outputs/apk/debug/GeopsAndroid-debug.apk` en el
  worktree aislado `codex/geops-spec02-mdm-integration`.
- Variante `debug`; `applicationId=com.geops.mobile`; `versionCode=7`,
  `versionName=0.1.6-test`; `minSdk=26`, `targetSdk=35`, `compileSdk=36`.
- SHA-256 APK:
  `18BA39B4AB71741F2079DC79514615C8F82994C62DC707BE87A9433C7F76F136`.
- `apksigner verify`: PASS, APK Signature Scheme v2, un firmante Android Debug;
  certificado SHA-256
  `6a618508b80b01de9ea3847f804687031f010d81e84ac67996dfcaeba668bb8f`.
- El APK anterior en `Geops-integration/.../debug` tiene certificado SHA-256
  `2a4d4b22514b83c7367cba3195bd1ac5c72b2a10aa68f8be45841d004ce7dd12`.
  **Las firmas son distintas; no se puede afirmar que esta APK actualice la
  instalada en el POCO.** No desinstalar la aplicación existente para hacer
  sitio: el almacenamiento cifrado y los registros pendientes podrían perderse.
- Permisos declarados: INTERNET, ACCESS_NETWORK_STATE,
  RECEIVE_BOOT_COMPLETED, ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION,
  FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION, POST_NOTIFICATIONS y CAMERA.
  No declara ACCESS_BACKGROUND_LOCATION. El manifiesto no registra receptor
  de boot para reanudar el agente.

## Condiciones previas a la prueba

1. Resolver el método de instalación sin borrar la APK/cola existente: obtener
   el certificado de la APK realmente instalada y la misma clave de firma para
   un upgrade, o usar un entorno de prueba aislado que no destruya datos del
   agente actual. No asumir que el APK del repositorio sea el instalado.
2. Preparar una API de prueba alcanzable desde el POCO con **el mismo SHA fuente**
   que el APK, contrato `/v2/device/gps/batches` y migración 0020. Registrar
   URL, SHA/digest de imagen y checksum de migración. No usar producción ni
   cambiar Staging sin autorización separada.
3. Registrar Android/MIUI/HyperOS, modelo exacto, versión de Play Services,
   política MDM, estado de batería/Doze, hora/zona, permisos concedidos y
   versión/firma del APK realmente instalado.
4. Usar una política de prueba laboral expresamente autorizada. Registrar
   inicio, fin, versión y vigencia. Ninguna prueba habilita captura fuera de
   esa ventana.

## Secuencia P0

1. Tomar evidencia inicial del diagnóstico local: última lectura recibida,
   última captura guardada, último ACK, pendientes y estado de servicio. Guardar
   hora local y UTC; ocultar coordenadas, tokens y claves en capturas compartidas.
2. Con una sesión A pendiente de STARTED, producir una sesión B autorizada y
   al menos una posición válida. Confirmar que el envío de B no se detiene por
   A. Guardar IDs pseudónimos y recuentos de cola antes/después.
3. Comprobar en la base de prueba un solo STARTED canónico y una sola posición
   por `event_id`, mismo `client_session_id`, misma instalación y tenant.
   Comparar con `accepted_event_ids ∪ duplicate_event_ids` del ACK exacto.
4. Repetir con dos sesiones acumuladas sin red y recuperar conectividad.
   Medir tiempo hasta vaciar la cola; verificar que cada sesión mantiene orden
   temporal y que ninguna posición ya persistida desaparece.
5. Simular pérdida de respuesta **solo en la API de prueba** tras confirmar el
   COMMIT; reintentar mismo `batch_id` y comparar `persisted_at` y recuentos.
   El ACK repetido debe provenir del recibo, sin duplicar sesión ni posición.
6. Durante una sincronización lenta o fallida, observar que nuevas capturas
   válidas siguen entrando a la cola. Separar la evidencia de captura de la de
   ACK; no usar “GPS activo” como indicador de éxito.
7. Al terminar la ventana, verificar cero capturas nuevas fuera de autorización.

**Umbral P0:** cero pérdidas de registros ya persistidos, cero duplicados
lógicos, ACK exacto, ninguna sesión ajena bloquea la subida y captura
independiente del envío. Un resultado sin acceso a IDs/recuentos de servidor
es `NOT_VERIFIED`, no PASS. Los objetivos de 27/30 minutos, máximo 180 segundos,
30 minutos online/offline, reinicio y nueva jornada offline pertenecen a Wave E
y se ensayarán solo después de implementar A–D.

## Evidencia para devolver

- SHA-256 del APK **instalado**, firma y código de versión.
- SHA API, digest de imagen y 20 checksums de migración de la base de prueba.
- Horario autorizado, Android/OEM/MDM/permisos, estado de red y batería.
- Línea de tiempo UTC de callback, captura persistida, intento de envío y ACK.
- Pendientes inicial/final, aceptados, duplicados, rechazados, mayor intervalo,
  tiempo de drenaje y errores por sesión.
- Capturas del diagnóstico antes, durante y después; extractos de servidor
  anonimizados por ID y sin coordenadas personales.

Si la firma del APK instalada no coincide, la prueba queda `BLOCKED` hasta
obtener un camino de instalación que preserve los datos actuales. No se debe
resolver el bloqueo desinstalando la aplicación con registros pendientes.
