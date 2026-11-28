# W6-R1 — Descubrimiento ManageEngine de solo lectura

**Resultado: BLOCKED en tenant real.** El adaptador de la rama candidata está construido para ManageEngine Mobile Device Manager Plus MSP Cloud, región y cliente acotados, OAuth solo en backend y `X-CUSTOMER`. Eso identifica la **implementación prevista**, no el producto/edición/licencia/tenant contratado. El Compose visible de staging tiene `MDM_ENABLED=false` para API y Web; el controlador remoto no expone el valor efectivo ni la existencia de grant OAuth. No se disponía de sesión administrativa, credencial de lectura o ID MDM real. No se llamó a la API ManageEngine ni se leyó un perfil o equipo operativo. `mdm_write_disabled` continúa.

| Capacidad | Código/guía disponible | Tenant real |
| --- | --- | --- |
| Producto, modalidad, edición, licencia, versión, región, tenant/cliente MSP | Adaptador presupone MSP Cloud con host regional `mdm.manageengine.{region}`; la [guía MSP](https://www.manageengine.com/mobile-device-management-msp/help/api/cloud/api-index.html) documenta esa variante | **UNKNOWN**; confirmar en consola/licencia. |
| Autenticación READ | OAuth backend con región, cliente y scopes; no imprimir secretos | **BLOCKED**, sin grant verificado. |
| Lista/detalle de dispositivos | [GET devices](https://www.manageengine.com/mobile-device-management-msp/help/api/cloud/devices-get-device-list.html), `MDMOnDemand.MDMInventory.READ` documentado | **NOT_RUN**; usar ID MDM real y cliente correcto. |
| Último contacto / resumen | [GET summary](https://www.manageengine.com/mobile-device-management-msp/help/api/cloud/devices-get-device-summary.html) documentado | **NOT_RUN**. |
| Apps instaladas / versión reportada | [GET apps](https://www.manageengine.com/mobile-device-management/help/api/cloud/get-device-app-list.html) documentado | **NOT_RUN**; no confundir versión reportada con certificado de firma. |
| Perfiles asignados / estado | [GET profiles](https://www.manageengine.com/mobile-device-management-msp/help/api/cloud/devices-get-profiles-from-device.html) documentado | **NOT_RUN**; asignado no implica aplicado ni permiso Android efectivo. |
| Permisos individuales, ubicación en segundo plano, batería, Managed Configurations | Consola puede ofrecer opciones; endpoint/API/licencia de lectura por instalación no verificados | **UNKNOWN**. La APK es la fuente de permisos efectivos. |
| Modificación de permisos, asociación de perfil, distribución APK | Fuera del alcance W6-R1 | **NOT_RUN**; no habilitar escritura ni distribuir. |

La [matriz de capacidades](MANAGEENGINE-CAPABILITY-MATRIX.md) contiene las distinciones por operación. Los endpoints de documentación pública son una hipótesis condicionada a la edición/versión/scopes reales; un 403 o 404 del tenant no se interpreta automáticamente como falta de soporte. El identificador `fake-*` comunicado previamente es un marcador sintético y no se usó en consulta.

Para desbloquear: el operador con acceso de **lectura** a la consola debe aportar evidencia sanitizada de producto/edición/licencia/versión, Cloud u On-Premises, región/URL, cliente/tenant, scopes READ, registro real del Moto G06 (ID MDM, nombre, modelo, Android, enrolamiento, modo, último contacto), aplicación GEOPS instalada, perfiles y configuración administrada. No enviar contraseñas, refresh tokens, secretos OAuth, IMEI ni coordenadas en el chat. Las instrucciones exactas y un único bloque de host están en [acciones del operador](WAVE6-R1-OPERATOR-ACTIONS.md).
