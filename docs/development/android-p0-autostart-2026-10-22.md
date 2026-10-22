# GEOPS Android P0 — arranque al comienzo de la jornada

## Artefacto local

- Paquete: `com.geops.mobile`, versión `0.1.7-p0-test`, versionCode `8`, targetSdk `35`.
- APK: `apps/android-app/build/outputs/apk/debug/GeopsAndroid-debug.apk` (artefacto local excluido de Git).
- SHA-256: `919435abecace91709d2547b075ccc16900ac855abd473cf6573e75058e8e83e`.
- Certificado de firma SHA-256: `efadaebd9c4488d2e05f53178ea40de97e9b4af86b275f3451c5cf36cb46e03e`, igual al de la versión de diagnóstico unificada anterior. La clave privada no se exportó.
- Verificación local: pruebas Kotlin/JVM y `syntheticTest` correctas; `assembleDebug` y `lintDebug` correctos (0 errores, 18 advertencias de lint). Validación física pendiente.

## Causa y alcance

La política v2 ya autorizaba la ventana 08:00–17:00, pero tras `OneKeyClean` no quedaba ningún proceso que evaluara el comienzo de la jornada. El trabajo periódico existente solo intentaba subir registros; no activaba GPS. Además, la pantalla técnica evaluaba la política con un almacén de solo lectura mediante una función que intentaba actualizar el reloj persistido, y mostraba «No comprobable».

La corrección separa la evaluación de solo lectura, programa una alarma persistente para el próximo inicio autorizado y reprograma al recibir política, al reiniciar, al cambiar la hora o al recrearse el proceso. El trabajo periódico consulta la política cuando el proceso está inactivo y el seguimiento autónomo continúa habilitado. No solicita ubicación. El receptor vuelve a comprobar autorización, permisos y proveedor antes de intentar iniciar el servicio; el controlador vuelve a comprobar la ventana antes de registrar el listener. Un único `PendingIntent` reemplaza la alarma anterior y el servicio evita un segundo listener.

La alarma exacta requiere el acceso especial `SCHEDULE_EXACT_ALARM`. Si no está concedido, se usa una alarma inexacta y queda registrado `EXACT_ALARM_UNAVAILABLE`. El inicio de un servicio de ubicación desde segundo plano requiere `ACCESS_BACKGROUND_LOCATION`; Android y Xiaomi pueden aun así posponer o impedir el inicio. En ese caso queda un motivo cerrado en el diario cifrado y se reintenta dentro de la ventana. Una terminación forzada de la aplicación por el sistema/administración puede impedir alarmas y trabajos hasta otra oportunidad permitida. La política MDM debe asegurar permiso de ubicación permanente, acceso a alarmas cuando corresponda y exclusión de limpieza/batería según el dispositivo. No se promete puntualidad exacta.

## Validación física pendiente en POCO

Instalar el APK de diagnóstico solo después de comprobar paquete, versión, SHA y firma. Conservar los datos de la instalación si la firma coincide. No usar `am force-stop` como sustituto de una terminación normal del proceso: Android trata force-stop como bloqueo de componentes hasta una apertura explícita.

1. Publicar y recibir una política v2 cuya siguiente ventana comience más tarde. Registrar en la pantalla técnica la política, la autorización actual y la hora del próximo intento; confirmar que no haya captura antes del inicio.
2. Con el proceso vivo, cruzar el comienzo de la ventana. Comprobar un solo servicio, un solo listener, callbacks, capturas cifradas y ACK exactos.
3. Repetir tras cerrar la aplicación desde Recientes o tras el mismo mecanismo `OneKeyClean` observado, con pantalla apagada. Comprobar `WINDOW_WAKE_ATTEMPT`, `DISPATCHED` y `ACTIVE` o un motivo `BLOCKED`. No abrir GEOPS para provocar el arranque.
4. Repetir tras reinicio físico. Verificar que el receptor reconstruye la alarma y que no registra GPS antes de la ventana.
5. Cambiar el horario mientras el servicio está vivo y después con el proceso terminado. Confirmar que la alarma anterior se reemplaza y la siguiente consulta de política del trabajo periódico converge al nuevo horario, sujeto a la ejecución de JobScheduler.
6. Cruzar el final de la ventana y comprobar el retiro del listener y ausencia de capturas fuera de autorización.
7. Repetir un intento bloqueado, por ejemplo sin acceso a alarma exacta o por restricción de segundo plano, y comprobar diagnóstico cerrado y reintento sin listeners duplicados.

Registrar tiempos de política recibida, alarma programada/entregada, inicio de servicio, registro de listener, primer callback, captura aceptada, persistencia en cola y ACK. Las ubicaciones entregadas por Android, las capturas y los ACK son etapas distintas. No incluir coordenadas, tokens ni identificadores sensibles en el informe. `PASS` físico exige evidencia de captura y ACK desde el dispositivo y recepción del servidor durante la ventana, más ausencia de captura fuera de ella; compilación o alarma entregada no bastan.

Referencias Android: [restricciones de inicio de FGS](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [alarmas y acceso especial](https://developer.android.com/develop/background-work/services/alarms), [servicio de tipo location](https://developer.android.com/about/versions/14/changes/fgs-types-required).
