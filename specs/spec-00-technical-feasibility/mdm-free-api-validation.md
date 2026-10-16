# Validación reproducible de ManageEngine MDM Plus MSP

**Estado de SPEC-00: BLOCKED.** Corte: 2026-10-16. El usuario confirmó **MSP Cloud Trial** en `mdm.manageengine.com`, el cliente `DEFAULT_CUSTOMER`, su ID numérico por la respuesta de red de Customer Details y **0 dispositivos inscritos**. El ID se guarda como string solo en `apps/api/.env.local`, ignorado por Git; no se publica en esta especificación. La edición Free y el piloto Android siguen sin validar.

## Contratos documentados y evidencia actual

| Capacidad | Fuente y contrato | Evidencia del Trial / límite |
| --- | --- | --- |
| OAuth e inventario | [OAuth MSP](https://www.manageengine.com/mobile-device-management-msp/api/oauth/): `MDMOnDemand.MDMInventory.READ`, header `Authorization: Zoho-oauthtoken {access_token}`. | Consentimiento e intercambio de código HTTP 200. El token nunca se mostró ni se persistió. |
| Cliente MSP | [Clientes MSP](https://www.manageengine.com/mobile-device-management-msp/api/customers/): `GET /customers`, `MDMOnDemand.MDMAdmin.READ`, campos `customer_id` y `customer_name`. | GET autenticado **sin** `X-CUSTOMER` respondió HTTP 302, sin seguir redirección. El ID se obtuvo de Customer Details en la consola, no de esa API; el nombre no quedó verificado por API. |
| Dispositivos | [Dispositivos MSP](https://www.manageengine.com/mobile-device-management-msp/api/devices/): `GET /api/v1/mdm/devices`, scope de inventario y `X-CUSTOMER` numérico. | GET con ID como **string** en `X-CUSTOMER`, `limit=1`, `offset=0` y `offset=1`: HTTP 200, `devices: []` en ambos. No hubo redirecciones. La respuesta sanitizada no mostró `metadata.total_record_count`; no se valida paginación con registros. |
| Perfiles | [Perfiles MSP](https://www.manageengine.com/mobile-device-management-msp/api/profiles/): listado requiere `MDMOnDemand.MDMDeviceMgmt.READ`. | Scope no solicitado; no se consultaron ni modificaron perfiles. |
| Edición Free | La [página comercial Free](https://www.manageengine.com/mobile-device-management/free-mobile-device-management-software.html) no demuestra permisos API del tenant de GEOPS. | Repetir OAuth e inventario después de la transición real a Free. |
| Canal Android | Fully Managed y managed configuration requieren prueba con hardware. | Dos teléfonos y entrega individual pendientes; la lectura vacía no acredita estas capacidades. |

## Procedimiento reproducible

1. Registrar fuera de Git la edición, región, cupo, fecha de transición, nombre de cliente y procedencia del ID numérico. Confirmar que `apps/api/.env.local` está ignorado y no rastreado; verificar vigencia/rotación del Client Secret en Zoho sin copiarlo a informes.
2. Ejecutar `npm test` y `npm run mdm:dev` desde `apps/api/`. Abrir `http://localhost:3500/`; consultar la [guía local](../../docs/development/mdm-oauth-local.md). Los tests con fakes no son evidencia del proveedor.
3. Autorizar solo `MDMOnDemand.MDMInventory.READ`. La herramienta intercambia el código en Node.js con `state` y PKCE, y mantiene tokens solo en memoria.
4. Consultar `GET https://mdm.manageengine.com/api/v1/mdm/devices?limit=1&offset=0` con `Authorization: Zoho-oauthtoken` y `X-CUSTOMER` como string. Registrar solo HTTP, tipo de `devices`, conteo, presencia de campos de paginación y errores sanitizados. Repetir con `offset=1`; con cero equipos esto comprueba aceptación de parámetros, pero no continuidad real.
5. Para M04/M05, inscribir dos teléfonos corporativos de prueba y usar únicamente los `device_id` devueltos por M03. No inventar registros. Distinguir 401, 403 y 429 y respetar `Retry-After`.
6. Revocar y desconectar antes de detener el proceso. Registrar si la renovación posterior se rechaza. Repetir M02–M08 tras la transición a Free; ningún PASS de Trial se traslada.

## Matriz M01–M10

| ID | Acción y criterio | Resultado al 2026-10-16 |
| --- | --- | --- |
| M01 | Confirmar en consola edición, región, cupo y fecha de transición. | **PENDING**: usuario confirmó MSP Cloud Trial, región `.com`, cliente y 0 equipos; faltan cupo y fecha documentados. |
| M02 | Autorizar `MDMOnDemand.MDMInventory.READ` e intercambiar código en backend. | **PASS en Trial**: POST Zoho `/oauth/v2/token` HTTP 200; no acredita Free. |
| M03 | GET MSP `/api/v1/mdm/devices` con `X-CUSTOMER` numérico, HTTP 200 y arreglo `devices`. | **PASS en Trial para acceso y estructura**: `limit=1&offset=0`, HTTP 200, `devices: []`; ID enviado como string. La identificación de A/B sigue pendiente de inscripción. |
| M04 | GET detalle de A/B usando `device_id` reales de M03. | **PENDING**: 0 equipos inscritos. |
| M05 | Comprobar continuación de páginas con al menos dos registros reales. | **PENDING**: `offset=0` y `offset=1` respondieron HTTP 200 con arreglo vacío; sin registros no se prueba continuidad. |
| M06 | Verificar 401 sin token y 403 con scope insuficiente. | **PENDING**: GET sin token respondió HTTP 401; falta prueba real de scope insuficiente. |
| M07 | Tras M08, retirar un equipo de prueba y observar estado/latencia por lectura. | **PENDING**: no hay equipos inscritos; no se modificaron dispositivos. |
| M08 | Entregar managed configuration individual a A/B y verificar aislamiento. | **PENDING**: prueba física fuera del diagnóstico OAuth. |
| M09 | Repetir M02–M08 con edición **Free efectiva**. | **PENDING**: tenant sigue Trial. |
| M10 | Revocar refresh token y comprobar rechazo de renovación posterior. | **PASS en Trial**: en la sesión actual, dos revocaciones HTTP 200 y dos renovaciones rechazadas; el HTTP exacto del rechazo no se guardó. |

**Prueba MSP C01:** `GET /customers` sin `X-CUSTOMER` con `MDMOnDemand.MDMAdmin.READ` obtuvo HTTP 302, sin seguir redirección: **FAIL para descubrir el ID por esa ruta**. El bloqueo del ID se resolvió mediante evidencia de Customer Details en la consola aportada por el usuario. El vínculo nombre↔ID aún no fue corroborado por la API de clientes. Esto no invalida M03: la API de dispositivos aceptó el ID y devolvió HTTP 200.

**Estados:** PASS exige ejecución real y criterio cumplido; FAIL exige ejecución real e incumplimiento; PENDING indica prueba incompleta/no ejecutada; BLOCKED indica impedimento externo establecido. La respuesta vacía es éxito de autenticación y lectura, no evidencia de dos teléfonos, paginación efectiva ni licencia Free. Se conservaron únicamente resultados sanitizados. Tests simulados: **18/18**, sin valor probatorio sobre ManageEngine.

## Cierre y Wave 0A

SPEC-00 conserva **BLOCKED** por M09 en Free, M04–M08 en dos teléfonos y los criterios de aprovisionamiento físico. La [puerta de Wave 0A](wave-0a-readiness.md) permite trabajo fundacional independiente si se cumplen sus criterios propios; no cambia el estado de SPEC-00. El diagnóstico no creó, modificó, publicó ni asignó perfiles o dispositivos.
