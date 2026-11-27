# Prueba corporativa GEOPS con ManageEngine

Esta guía aplica únicamente al tenant sintético de GEOPS Staging y a un Android corporativo ya
inscrito en ManageEngine y asociado en **Integración MDM**. La APK `com.geops.corporate` de esta
prueba usa firma Android Debug; no es un artefacto de producción.

## Preparar GEOPS antes de instalar

1. Sincronizar el inventario MDM y confirmar que el equipo está `managed`, Android y asociado al
   registro GEOPS correcto. La verificación debe ser reciente; GEOPS exige una observación MDM de
   menos de una hora al autorizar y emitir la invitación.
2. En **Inventario → Inscripción de prueba**, seleccionar el registro y completar **Preparar
   seguimiento corporativo** con fecha de fin, fecha real del aviso de privacidad, base de
   autorización, referencia de evidencia y motivo. El administrador confirma el aviso antes de
   guardar. Esta aprobación crea una política continua de 60 segundos, pero un borrador no puede
   capturar GPS.
3. Pulsar **Generar invitación corporativa MDM**. Los cinco campos de `managed_configuration` se
   muestran solo en esa sesión y caducan en 24 horas. No generar un QR supervisado para la APK
   Corporate. Si la configuración se pierde o vence, revocar la invitación y crear otra.

## Configurar ManageEngine

1. En **Device Management → App Repository**, añadir `com.geops.corporate` como **Android
   Enterprise App** y cargar la APK de prueba solo en el entorno y equipo autorizados. Consultar
   [el procedimiento oficial de aplicaciones empresariales](https://www.manageengine.com/mobile-device-management-msp/help/app_management/android_app_management.html).
2. En **Configurations** de la aplicación, establecer los cinco valores exactos copiados de GEOPS:
   `geops_device_id`, `mdm_device_id`, `invitation_id`, `invitation_secret` y `expires_at`. Mantener
   esa configuración limitada al equipo de prueba; no reutilizar el secreto en otros dispositivos.
   Consultar [configuraciones y permisos](https://www.manageengine.com/mobile-device-management-msp/help/android_for_work/mdm_app_configurations_and_permissions.html).
3. Configurar permisos de ubicación precisa, ubicación en segundo plano y notificaciones. Si
   Android o la edición MDM exige intervención en el teléfono, completarla antes de esperar GPS.
4. Distribuir la app únicamente al dispositivo seleccionado. Para iniciar sin que el usuario abra
   el icono, comprobar si el tenant ofrece **Launch app after installation** en la configuración
   de la aplicación MDM Self Service y añadir `com.geops.corporate`. Esa opción está
   [documentada por ManageEngine](https://www.manageengine.com/mobile-device-management/help/profile_management/android/memdm_app_config_manual.html), pero debe verificarse en la edición MSP Cloud concreta. Si no aparece, abrir GEOPS Corporate una vez en el teléfono después de aplicar la configuración.

Android no entrega `ACTION_PACKAGE_ADDED` a la propia aplicación recién instalada. Por eso la
instalación silenciosa por sí sola no ejecuta código GEOPS; hace falta que ManageEngine lance la
app o que se abra una vez. Véase la [referencia oficial de Android](https://developer.android.com/reference/android/content/Intent#ACTION_PACKAGE_ADDED).

## Resultado esperado

Al abrirse, la APK lee Managed Configurations, reclama la invitación y demuestra su clave de
Android Keystore. GEOPS vuelve a verificar el vínculo MDM, activa la identidad y materializa la
política previamente autorizada. La APK solo inicia el servicio de ubicación si Android ha
concedido los permisos requeridos y `/v2/device/config` entrega una política corporativa activa.
Android mantiene visibles los indicadores de ubicación que correspondan.

Verificar en GEOPS que el registro pasó a `ACTIVE`, que la autorización corporativa continúa
vigente y que llegan eventos GPS. Un estado `ACTIVE` aislado no demuestra que ya se estén
recibiendo posiciones.
