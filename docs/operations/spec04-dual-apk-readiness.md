# SPEC-04 V1 — Corporate y Personal

## Estado de entrega

Fuente: `apps/android-app` y motor compartido `apps/android-agent` en `b32-promotion`.
Destino compilado: `https://geops-staging.duckdns.org`. No se ha modificado producción ni activado dispositivos.
Comprobación HTTP de solo lectura del 2 de noviembre de 2026: `/health/live` y `/health/ready` devolvieron 200; `/v2/device/config` sin credenciales devolvió 401. Esto confirma disponibilidad y cierre de acceso, no una respuesta GPS autenticada para cada variante.

## Evidencia de compilación y pruebas locales

- `assembleCorporateRelease assemblePersonalRelease`: **BUILD SUCCESSFUL**; salidas release sin firmar, no entregadas para instalación.
- `assembleCorporateDebug assemblePersonalDebug`: **BUILD SUCCESSFUL** con la clave debug estándar aislada. `apksigner verify --verbose --print-certs` confirmó una firma v2 válida y un firmante en cada APK.
- `aapt dump badging`: `com.geops.corporate` y `com.geops.personal`, ambos con `versionCode=1` y `versionName=1.0.0-spec04-test`. Managed Configurations aparece solo en Corporate; el permiso CAMERA solo en Personal.
- Certificado debug de ambas APK: SHA-256 `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8`, `CN=Android Debug`. Los APK locales anteriores v3/v4 usan `com.geops.mobile` y certificado `bf7eea177e6ec560b1178753f0b52f9e2b3468abe004b25ef81ef578ff78b3f1`. No se copiaron claves Android Keystore ni estado del POCO.
- `apps/android-agent` `syntheticTest`: **BUILD SUCCESSFUL**, incluidos rechazo de propiedad intercambiada, bloqueo de modo continuo BYOD, revocación v2 inmediata, estado cifrado, GPS v2 y recuperación. No se realizó prueba física.

| Propiedad | Corporate | Personal |
| --- | --- | --- |
| Flavor / paquete | `corporate` / `com.geops.corporate` | `personal` / `com.geops.personal` |
| Nombre | GEOPS Corporate | GEOPS Personal |
| Versión | `versionCode=1`, `versionName=1.0.0-spec04-test` | Igual |
| Inscripción | Managed Configurations con invitación MDM de un uso | QR supervisado, confirmación administrativa y activación visible |
| Política aceptada | SPEC-04 v2, `CORPORATE_MANAGED`, `CONTINUOUS`, intervalo de 60 s | SPEC-04 v2, `PERSONAL_BYOD`, `WORK_WINDOW` |
| GPS | Ventanas continuas 24/7 autorizadas; sin vínculo a rutas | Ventanas de jornada; el motor pausa el listener al salir |
| Controles | Sin botones ordinarios de inicio/detención ni campos manuales | Inicio visible, permisos, horario/estado, sincronización, conectividad y detención fuera de jornada |
| Manifest | Managed Configurations, boot/recovery y FGS de ubicación; sin cámara | Sin Managed Configurations; cámara para QR y boot/recovery solo con política local válida |
| Motor | GPS, almacenamiento cifrado, subida v2, sesión, políticas y diagnósticos compartidos | Igual |

El backend SPEC-04 de staging (migraciones 0034/0035) decide la propiedad y vigencia, verifica inventario MDM para `CORPORATE_MANAGED` y solo entrega política continua a ese tipo. La APK además comprueba el modo de la respuesta y de la copia local antes de iniciar o recuperar GPS. La identidad del servidor se basa en dispositivo, clave PoP e instalación, no únicamente en nombre de paquete. No hay atestación criptográfica de la identidad del paquete; esa protección adicional requeriría una ampliación explícita del contrato de inscripción.

## Firma y artefactos de prueba

Por decisión del usuario, V1 se entrega con `assembleCorporateDebug assemblePersonalDebug`, firma **debug estándar de Android** y uso exclusivo en pruebas físicas autorizadas. La clave debug se conserva en `apps/android-app/.spec04-debug/` (ignorado por Git), aislada de la APK POCO, para reproducir la firma durante estas pruebas. Verificar ambas APK con `apksigner verify --verbose --print-certs`, copiar como `GeopsCorporate-v1.apk` y `GeopsPersonal-v1.apk` y registrar SHA-256, certificado, commit y entorno en el manifiesto de entrega. No distribuirlas automáticamente por MDM.

`assembleCorporateRelease assemblePersonalRelease` produce dos APK **sin firmar** mientras falten las cuatro variables `GEOPS_ANDROID_RELEASE_*`. La clave local `geops-test.jks` está explícitamente excluida para la candidata enterprise en `specs/spec-03-clients-geofences-routes/android-enterprise-mdm-readiness.md`; no se utilizará. Al superar pruebas físicas, preparar generación y custodia de claves release aprobadas y configuración protegida local o CI/CD. Nunca usar las APK debug para producción.

## Instalación y actualización

1. Registrar dispositivos nuevos en el tenant correcto. Para Corporate, vincular y verificar ManageEngine, emitir invitación `managed_configuration` de un uso, registrar autorización individual y asignar política continua de 60 s. Configurar las cinco restricciones de inscripción y conceder permisos de ubicación precisa, ubicación en segundo plano y notificaciones según Android. El MDM debe lanzar la Activity al instalar cuando la plataforma lo permita. Mantener los indicadores obligatorios de Android. `admin_diagnostics_enabled=true` permite mostrar el diagnóstico técnico; la ocultación del icono, si se requiere, queda a cargo de la política del launcher MDM compatible.
2. Para Personal, crear un registro BYOD nuevo, emitir invitación `supervised_qr`, confirmar presencialmente el código y activar la instalación. El vínculo `fake`/`mdm_device_id` que exige el contrato QR legado es un identificador sintético interno, no una inscripción MDM real. Registrar `PERSONAL_BYOD`, consentimiento/aviso de privacidad, vigencia y política de jornada. El usuario escanea el QR, concede permisos y pulsa inicio. No asignar una política continua.
3. Comprobar en `/v2/device/config` la propiedad, `tracking_mode`, versión de autorización y política antes de una prueba de ubicación. Toda prueba debe usar un dispositivo y tenant autorizados.
4. Los paquetes nuevos **no son actualizaciones in situ** de `com.geops.mobile` v9. La v9 y su almacén Android Keystore quedan aislados. No copiar estado, claves, tokens ni identificadores de instalación. Retirar la instalación anterior bajo un procedimiento administrado, después de verificar la cola pendiente y conservar la evidencia. Instalar y activar cada variante como alta nueva. Una actualización futura de cada variante exige mismo paquete, certificado y `versionCode` mayor.

## Pruebas controladas pendientes

| Prueba física | Resultado que se debe observar |
| --- | --- |
| Corporate: MDM ausente, cambiado o revocado; autorización individual ausente | Sin captura ni recuperación; diagnóstico administrativo del bloqueo |
| Corporate: política continua, sin ruta, pantalla apagada, sin red, reinicio y cierre OEM | Solicitud de 60 s, puntos cifrados, reintento/ACK y recuperación solo dentro de autorización; medir huecos reales |
| Corporate: permisos o FGS bloqueados | Sin captura; indicadores/notificaciones obligatorios visibles cuando Android lo exija |
| Personal: antes, durante y después de jornada; sin ruta y fuera de ruta | Cero puntos fuera de jornada; dentro de jornada los puntos no dependen de rutas; listener detenido al salir |
| Personal: detención fuera de jornada, permisos denegados, sin red y reinicio | Control visible, cola cifrada, sincronización posterior, sin inicio fuera de autorización |
| Compartidas: cambio de tenant, propiedad, revocación, asignación, reloj y credenciales | Rechazo seguro y sin mezcla de posiciones o políticas |

Registrar modelo/Android/OEM, hora local y UTC, versión, certificado, permisos, estado MDM, conectividad, eventos de sesión, anclas GPS v2, contadores de captura/ACK y huecos medidos. Una compilación o prueba sintética no acredita continuidad 24/7 ni entrega de una posición cada minuto.
