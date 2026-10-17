# Diagnóstico de inscripción QR — POC-GPS-001

El operador informó una inscripción QR con HTTP 201 y un dispositivo activo sin posiciones. La verificación del token tras reiniciar y la prueba física de la nueva APK de campo siguen pendientes. La identidad definitiva de SPEC-01 no cambia.

**No actualizar la APK instalada con `adb install -r`:** su firma difiere. El operador autorizó una instalación limpia condicionada a comprobar que no hay cola ni datos locales que conservar. Seguir [field-apk-reinstall.md](field-apk-reinstall.md).

## Compilar e instalar

Compilar la variante debug con el origen HTTPS confirmado, sin `-PpocRealCapture`:

```sh
gradle -p android :app:testDebugUnitTest :app:assembleDebug -PpocApiOrigin=https://18.209.159.208
# Ejecutar adb install -r solo después de comprobar que la firma coincide con la APK instalada.
```

Si `adb install -r` devuelve `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, la APK anterior usa otra firma debug. Antes de desinstalar, comprobar si hay identidad o datos locales que deban conservarse; una desinstalación los elimina. Si no hay datos que preservar, desinstalar manualmente `com.geops.weekendpoc` e instalar esta APK. Si el panel muestra un dispositivo inscrito, revocarlo antes de volver a invitar.
La APK de CI anterior usa `https://gps-poc.example.invalid` por defecto y rechazará el QR del servidor antes de enviar HTTP. Verificar antes de instalar que `BuildConfig.POC_API_ORIGIN` sea `https://18.209.159.208` y `REAL_CAPTURE_ENABLED` sea `false`. La API debe seguir sirviendo HTTPS con un certificado público válido para la IP; no instalar certificados privados ni omitir TLS.

Abrir el panel, generar **una invitación nueva** y escanearla antes de sus diez minutos de vigencia. Una invitación ya consumida o cancelada no se puede reutilizar. Si el servidor ya creó una identidad pero el teléfono no guardó la respuesta, comprobar el inventario del panel y revocar esa identidad antes de generar otro QR. No copiar el contenido del QR a logs, capturas o tickets.

## Evidencia sanitizada

En el teléfono, consultar solo eventos de la etiqueta `GeopsPocEnroll`, por ejemplo con `adb logcat -s GeopsPocEnroll:I`. Los eventos indican QR reconocido, JSON válido o inválido, origen distinto, inicio de HTTP, respuesta con código, error TLS, error de conexión y confirmación. No contienen el QR, la invitación ni el token. En el contenedor API, las trazas de inscripción contienen únicamente `event`, `request_id` y, cuando existe, `status`.

| Mensaje | Interpretación | Acción |
| --- | --- | --- |
| QR inválido | JSON o campos inválidos; HTTP 400/401 cuando el servidor rechaza la invitación | Generar QR nuevo y verificar que provenga del panel PoC. |
| Origen distinto | `api_base` no coincide con el origen incluido en la APK | Compilar con `-PpocApiOrigin=https://18.209.159.208`; no cambiar el QR. |
| HTTP 410 | Invitación expirada | Generar QR nuevo. |
| HTTP 409 | Invitación utilizada, si el código es `invitation_used`; otros 409 se muestran como rechazo HTTP | Revisar inventario y generar nueva invitación cuando corresponda. |
| Conexión | No se recibió respuesta HTTP | Comprobar red y disponibilidad HTTPS sin desactivar TLS. |
| TLS | Falló la negociación o validación de certificado | Revisar certificado para la IP y fecha del teléfono. |
| HTTP distinto | El servidor o proxy respondió, pero no confirmó inscripción | Registrar solo el código y `request_id`; revisar trazas sanitizadas de API. |
| Respuesta inválida / guardado local | HTTP 201 no contiene identidad válida, o el teléfono no pudo persistirla | Revisar inventario y revocar la identidad antes de reintentar. |

La interfaz solo muestra inscripción confirmada después de HTTP 201, validación de `environment_id`, `device_id` y `device_token`, y persistencia local completa. La prueba física sigue pendiente hasta instalar esta compilación y repetir el escaneo.

## Validación local de esta corrección

- `:app:testDebugUnitTest` y `:app:assembleDebug`: PASS; 8 pruebas JUnit, 0 fallos.
- `:app:lintDebug`: PASS; 0 errores y 28 advertencias informativas.
- APK debug local: `android/app/build/outputs/apk/debug/app-debug.apk`, 4,302,280 bytes, SHA-256 `2F25D1F201E4B561C8BD399B35BE9B9CF34FBE13EE109E21B3E1EA29CFE2F445`.
- `BuildConfig` verificado: origen `https://18.209.159.208`, captura real `false`. Manifiesto fusionado: escáner `fullSensor`.
- Contrato API: 16 pruebas Node PASS; Biome PASS con sugerencias informativas; build Web PASS.

Al registrar esa compilación, la orientación y la inscripción seguían **PENDING_PHYSICAL_VALIDATION**. Posteriormente, el operador informó HTTP 201, un identificador local visible y un dispositivo activo en el panel con cero posiciones; esa evidencia confirma el éxito inicial informado, pero no verifica el token tras el reinicio. La nueva corrección de identidad requiere una APK recompilada; el hash anterior no la contiene.

## Identidad tras reiniciar la APK o la API

La APK guarda `base`, `device` y el token cifrado en una única escritura confirmada de `poc-identity`; el token se cifra con Android Keystore. El identificador de ocho caracteres mostrado en el diagnóstico proviene de ese almacenamiento. No demuestra por sí solo que el token siga disponible o que el servidor lo acepte. La versión anterior fijaba «Inscripción pendiente.» al construir la pantalla, incluso cuando había identidad local: era un defecto visual. La pantalla corregida distingue identidad local guardada de identidad confirmada remotamente.

Para comprobar la credencial **sin capturar coordenadas**, instalar la nueva APK con `adb install -r` (sin borrar datos), abrirla y pulsar **Verificar identidad (sin GPS)**. Envía solamente `GET /api/device/status` por HTTPS con el bearer cifrado localmente; no sigue redirecciones, no solicita permisos GPS ni hace una inscripción nueva. Acepta HTTP 200 únicamente si `environment_id` y el `device_id` completo coinciden con lo guardado. HTTP 401 indica credencial no reconocida; HTTP 403 indica acceso denegado; errores TLS, conexión o respuesta inválida se muestran por separado. Ningún resultado borra credenciales. Registrar solo código HTTP y mensaje sanitizado; nunca copiar el token ni el contenido del QR.

Con **Pendientes de identidad actual: 0**, el botón **Sincronizar pendientes** no envía un lote. Ahora muestra «Sin pendientes para esta identidad; no se envió solicitud». Eso tampoco comprueba autenticación. El endpoint de estado sí la comprueba y no crea posiciones.

La identidad del dispositivo reside en `poc_device` de PostgreSQL y se busca por hash del token. Recrear únicamente `poc-api` conserva la identidad si `poc-db` y su volumen `geops_weekend_poc_pgdata` permanecen intactos. Las sesiones administrativas en memoria se pierden al recrear la API y requieren iniciar sesión de nuevo. Si hubo borrado/reemplazo del volumen o cambio de base de datos, la credencial anterior podría recibir HTTP 401; comprobar el estado antes de considerar otra inscripción. No desinstalar ni limpiar datos de la APK para diagnosticarlo.

La prueba API simulada de reinicio y estado pasó localmente. La prueba de credencial del teléfono sigue pendiente: hasta instalar una APK firmada de forma compatible, no se puede afirmar que el token cifrado del teléfono siga siendo descifrable ni que el servidor cloud lo acepte.

## Bloqueo de firma para actualizar sin perder datos — 2026-10-16

El operador confirmó que la APK instalada procede del build local anterior. Se preservó una copia ignorada en `android/build/installed-apk-reference.apk` antes de recompilar. Se verificaron ambas APK con `apksigner verify --print-certs`:

| APK | SHA-256 del archivo | SHA-256 del certificado de firma |
| --- | --- | --- |
| Instalada, copia local | `2F25D1F201E4B561C8BD399B35BE9B9CF34FBE13EE109E21B3E1EA29CFE2F445` | `ef83d7b78dab1177f88cec2ab8667f8d7e3b6fd7c317e0c4c7692506d0ff2953` |
| Diagnóstico recompilado | `A605F8308A220AE9418710F8E9E18E5FC5524A116CE4459EB37BAE43EF9896F9` | `3830d25ce5d9d6202f2d74c82aa7a29d7e352d19577d42840691e63fd6e6e37d` |

La firma **no coincide**. Android rechazará `adb install -r` de esa APK sobre la instalada. La decisión posterior del operador acepta perder la identidad local anterior mediante instalación limpia, tras confirmar cero pendientes y ningún dato que conservar. El workflow de la APK de campo usa captura manual habilitada; su firma debug puede diferir de la del build local, así que se debe seleccionar una sola APK para instalar.

Alternativas seguras, en orden:

1. Buscar la **clave debug original** del entorno que generó la APK instalada, sin incorporarla al repositorio ni compartirla por chat. Si existe, firmar una compilación local con esa clave y verificar el fingerprint antes de `adb install -r`. Para CI, usar un secreto de GitHub con acceso restringido y rotación documentada; nunca imprimir la clave.
2. Si la clave original no existe, mantener la APK y sus datos intactos. Diseñar y aprobar un procedimiento de migración de identidad que preserve o reprovisione de forma controlada los datos necesarios; comprobar primero si la credencial puede verificarse mediante un mecanismo seguro en la app instalada.
3. Esa decisión explícita se recibió el 2026-10-16 para el único teléfono autorizado. Repetir la comprobación de contadores antes de desinstalar y seguir el procedimiento de campo; no inferir que se ha ejecutado.

Validación histórica de la APK diagnóstica: `:app:testDebugUnitTest` (13 pruebas, cero fallos), `:app:lintDebug` y `:app:assembleDebug` pasaron; su `BuildConfig` contenía `POC_API_ORIGIN=https://18.209.159.208` y `REAL_CAPTURE_ENABLED=false`. El build de campo posterior se documenta en [field-apk-reinstall.md](field-apk-reinstall.md); no confundir los dos archivos APK ni sus firmas.
