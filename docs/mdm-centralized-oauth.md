# Identidad OAuth centralizada de ManageEngine

GEOPS usa una sola aplicación **Server-based** registrada en Zoho API Console. Su
`Client ID` y `Client Secret` identifican a GEOPS; el consentimiento OAuth y el
cliente MSP elegido identifican una conexión distinta. Los administradores de
GEOPS Web solo usan **Conectar ManageEngine**. La desconexión revoca el grant y no
borra la identidad de aplicación.

## Registro y provisión inicial

1. El responsable de la instalación comprueba si la aplicación GEOPS ya existe
   en Zoho API Console. Reutiliza esa aplicación y registra exactamente la URI
   HTTPS que devuelve `GET /v1/admin/mdm/oauth/config` para el entorno. El
   registro se realiza una sola vez; Zoho entrega las credenciales del cliente
   al registrar la aplicación, antes de cualquier consentimiento OAuth.
   La auditoría local encontró archivos protegidos `mdm_client_id` y
   `mdm_client_secret` en el worktree histórico de integración; no se leyeron
   sus valores ni se ha confirmado que el callback de Staging esté registrado.
   Esos archivos son candidatos para reutilización, no prueba de provisión en
   Staging.
2. Tras desplegar esta versión, en una terminal protegida del host de la API,
   ejecuta el comando existente del contenedor con la nueva operación local:
   `docker compose exec geops-api sh /geops-stage-entrypoint.sh provision-oauth-client <correo-del-operador>`.
   El operador debe estar activo y tener `mdm.oauth.configure`. El comando
   reutiliza automáticamente el cliente montado, si existe. Si no existe,
   solicita Client ID y Client Secret sin eco en la terminal. No se pasan por
   argumentos, variables de navegador ni logs.
3. El comando guarda las credenciales con AES-256-GCM en
   `mdm_oauth_client_config`, usando una clave derivada de la clave MDM externa
   a PostgreSQL. Una segunda ejecución confirma que ya está provisionado y no
   reemplaza el registro. La configuración persiste al reiniciar la API y al
   cambiar de imagen, siempre que se conserve la base y la clave MDM.
4. El responsable comprueba que el estado administrativo indique
   `oauth_configured: true`. Si no hay aplicación registrada, debe registrarla
   por el mecanismo oficial de Zoho antes de este paso. No se genera un Client
   Secret mediante el login de un administrador.

El endpoint `PUT /v1/admin/mdm/oauth/config` ya no existe. El endpoint `GET`
devuelve solo estado, región y callback; nunca revela credenciales. La UI no
ofrece formularios técnicos. Sin cliente provisionado muestra **Servicio
ManageEngine sin configurar** y no inicia OAuth.

## Conexión diaria

**Conectar ManageEngine** inicia el flujo existente con sesión administrativa,
CSRF, `state`, PKCE y callback de un solo uso. El backend canjea el código y
guarda el grant cifrado. Si hay un único cliente MSP autorizado, lo selecciona;
si hay varios, exige una elección validada contra la lista descubierta en
ManageEngine. El navegador no recibe Client Secret, refresh token ni access
token. `customerId` y edición no se precargan para conectar.

La rotación de la identidad de aplicación requiere un procedimiento de
operador supervisado; la operación inicial no sobrescribe una identidad ya
persistida. Para una rotación, se debe desconectar primero cualquier grant y
verificar la clave de cifrado y el nuevo registro Zoho antes de usar un
procedimiento de reemplazo autorizado.

Referencia del proveedor:
[Registro de aplicaciones OAuth de Zoho](https://www.zoho.com/developer/oauth/register-app.html).
