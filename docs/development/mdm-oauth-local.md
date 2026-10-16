# Diagnóstico OAuth local de ManageEngine MDM Plus MSP Cloud

**Uso:** desarrollo local exclusivamente. Esta herramienta verifica autenticación y lecturas; no administra perfiles, políticas ni dispositivos. SPEC-00 sigue BLOCKED pese a las lecturas exitosas en Trial: faltan Free y los dos teléfonos del piloto.

## Configuración

1. En Zoho API Console, registrar un cliente **Server-based Applications** `geops` en la cuenta vinculada al tenant MSP. Las credenciales actuales se guardan solo en `apps/api/.env.local`; usar `apps/api/.env.example` como plantilla sin valores reales. No copiar códigos ni tokens a Git, comandos compartidos, capturas o incidencias.
2. Registrar exactamente `http://localhost:3500/api/integrations/mdm/oauth/callback` como redirect URI. No cambiar el URI sin comprobar antes la configuración del cliente.
3. Fijar `MDM_REGION` a la región real del tenant. La consola confirmada para este piloto es `mdm.manageengine.com`, por lo que aquí se usa `com`. La herramienta deriva `accounts.zoho.com` y `mdm.manageengine.com` de esa región. No se infiere la región de idioma o ubicación personal.
4. `MDM_CUSTOMER_ID` es opcional y solo acepta el **ID numérico** conocido por evidencia. No usar `DEFAULT_CUSTOMER` como valor. En el Trial actual se confirmó el ID desde Customer Details y se guarda como string solo en `apps/api/.env.local`; no publicarlo en documentación ni convertirlo a `Number` de JavaScript.
5. Antes de autenticar, verificar `git check-ignore -v -- apps/api/.env.local` y `git ls-files -- apps/api/.env.local`. Si se sospecha filtración del Client Secret, rotarlo en Zoho y revocar tokens antes de continuar. Una revisión local de Git no prueba que Zoho haya rotado el secreto.

## Ejecutar

Desde `apps/api/`, ejecutar `npm test` y `npm run mdm:dev`. Abrir **solo** `http://localhost:3500/` en el equipo de desarrollo. El servidor escucha en `127.0.0.1:3500`, exige Host local, no habilita CORS ni registra URL de callback, código o cuerpo de respuestas. Devuelve resultados sanitizados; los tokens se conservan únicamente en memoria y se pierden al detener el proceso. Antes de detenerlo, usar **Revocar y desconectar** para intentar revocar refresh tokens; si la revocación falla, hacerlo en Zoho.

1. **Autorizar lectura de inventario** solicita `MDMOnDemand.MDMInventory.READ` con Authorization Code, `state` aleatorio, PKCE S256 y consentimiento. El código llega necesariamente en la query del callback OAuth, se consume en Node.js y se redirige de inmediato sin registrarlo. El backend lo intercambia por POST; Client Secret y refresh token no viajan en URL ni llegan a la página.
2. **Autorizar búsqueda de DEFAULT_CUSTOMER** solicita por separado `MDMOnDemand.MDMAdmin.READ`, scope mínimo documentado para `GET /customers` en la [API MSP de clientes](https://www.manageengine.com/mobile-device-management-msp/api/customers/). La prueba previa sin `X-CUSTOMER` respondió HTTP 302. El ID se obtuvo por Customer Details; consultar clientes por API con ese ID sería una validación posterior separada. El inventario no necesita el scope de administración.
3. **Buscar cliente** es un diagnóstico opcional de `GET https://mdm.manageengine.com/customers`; sin `X-CUSTOMER` devolvió HTTP 302 en este Trial. Si algún tenant devuelve una lista, se exige coincidencia exacta y única de `DEFAULT_CUSTOMER` antes de guardar el ID solo en memoria. La respuesta al navegador nunca expone la lista ni el ID.
4. **Listar dispositivos** consulta `GET https://mdm.manageengine.com/api/v1/mdm/devices?limit=1&offset=0` con `X-CUSTOMER` numérico conservado como string desde la consola. Muestra HTTP, cantidad, metadatos de paginación disponibles y nombres de campos, nunca datos de equipos. Un listado vacío con HTTP 200 y estructura válida acredita autenticación/lectura, pero no valida vinculación de dos teléfonos.
5. **Revocar y desconectar** usa POST de [revocación OAuth Zoho](https://www.zoho.com/developer/oauth/revoke-oauth-token.html) y limpia memoria. La respuesta distingue revocación remota fallida de limpieza local.

La [API MSP de perfiles](https://www.manageengine.com/mobile-device-management-msp/api/profiles/) documenta `MDMOnDemand.MDMDeviceMgmt.READ`; ese scope **no se solicita** en este diagnóstico. Si inventario no sirve para un criterio posterior, abrir una prueba separada con autorización específica. No solicitar scopes de escritura.

## Evidencia y límites

Registrar solo fecha/hora, edición Trial/Free, región, scopes, rutas, HTTP y esquema resumido en [M01–M10](../../specs/spec-00-technical-feasibility/mdm-free-api-validation.md). Los tests de `npm test` usan valores ficticios y respuestas simuladas: no acreditan acceso al tenant. La edición Free requiere repetir pruebas tras la transición del Trial. Los endpoints de diagnóstico son locales y se deben eliminar o aislar fuera del build de producción.

Para rotar credenciales comprometidas, regenerar Client Secret en Zoho, revocar refresh tokens, actualizar `.env.local` o el gestor de secretos del despliegue y revisar el historial de Git y el acceso al tenant. No copiar el secreto anterior a informes ni reescribir historial sin decisión explícita.
