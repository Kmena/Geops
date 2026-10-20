# Contratos HTTP y OpenAPI — propuesta 0A

**Enmienda sintética SPEC-02 (2026-10-19):** `GET` y `POST /v1/admin/devices` ahora exigen `gps.installation.manage` y el inventario de esta ruta se limita a bindings fake del tenant `synthetic`. La sesión administrativa sola no permite registrar ni enumerar dispositivos. La enmienda preserva cookie, Origin y CSRF de SPEC-01; se documenta también en el OpenAPI distribuido.

El archivo [openapi.yaml](openapi.yaml) define OpenAPI 3.1 para health, autenticación admin, aprovisionamiento/identidad, inventario y estado MDM. Se versiona el prefijo /v1; health usa /health. Todas las respuestas son JSON UTF-8 y cada solicitud tiene X-Request-Id generado/normalizado por servidor. Para identidad, [contrato v1 de SPEC-00](../spec-00-technical-feasibility/identity-api-contract.md) prevalece si hay discrepancia; antes de codificar se deben generar/validar esquemas contra él.

## Autenticación y errores

- Admin: cookie de sesión HttpOnly Secure SameSite=Lax. Mutaciones requieren X-CSRF-Token y Origin permitido; login además comprueba Origin y rate limit. No hay registro público. Bootstrap y recuperación operativa son comandos locales, fuera de HTTP hasta aprobar canal de recuperación.
- Device: invitation_secret solo en claim inicial; luego sesión bearer opaca y firma PoP según [SPEC-00](../spec-00-technical-feasibility/api-contracts.md). Ningún token MDM llega al dispositivo.
- API administrativa: error {error:{code,message,request_id}}. Endpoints /v1/device y activación/revocación mantienen el error de identidad {code,correlation_id} ya fijado por SPEC-00; middleware lo mapea sin revelar detalles. 400 esquema, 401 auth, 403 permiso/scope, 404 recurso, 409 conflicto/replay, 410 expirado, 422 semántica, 429 límite, 503 dependencia.
- Listas: cursor opaco y limit 1–100 (default 25), {items,next_cursor,source}. No inferir total si proveedor no lo entrega. Un array vacío autenticado es éxito.
- Configuración MDM y estado ocultan client secret, refresh/access token y Customer ID completo de la respuesta web; muestran provider, region, edition_evidence=TRIAL|FREE_UNVERIFIED, connected, last_checked_at, last_http_status y sanitized_error_code. El customerId completo solo se maneja en backend.

## Superficie prevista

| Método/ruta | Actor | Respuesta/nota |
| --- | --- | --- |
| GET /health/live | público | 200 proceso vivo; sin detalles internos. |
| GET /health/ready | interno/operador | 200 DB+migraciones; 503 si falla; restringir en proxy. |
| POST /v1/admin/auth/sessions | público con Origin | Login; cookie y csrf_token; 401 genérico. |
| GET /v1/admin/auth/me | admin | Perfil mínimo y CSRF renovable. |
| DELETE /v1/admin/auth/sessions/current | admin+CSRF | 204, revoca sesión. |
| GET /v1/admin/devices | admin | Inventario GEOPS paginado; fuente GEOPS/MDM visible. |
| POST /v1/admin/devices | admin+CSRF | Crea DRAFT sintético o registro preprovisionado; no inscribe MDM. |
| POST /v1/admin/devices/{device_id}/invitations | admin+CSRF | Contrato SPEC-00; 201. |
| POST /v1/device/enrollment/claims | invitación | Contrato SPEC-00; 201. |
| POST /v1/device/enrollment/claims/{claim_id}/proof | invitación reservada | Contrato SPEC-00; 200. |
| POST /v1/admin/devices/{device_id}/synthetic-evidence | admin+CSRF | Registra referencia ficticia ligada a claim/binding fake; nunca acredita un teléfono real. |
| POST /v1/admin/devices/{device_id}/activate | admin+CSRF | En 0A solo activa identidad sintética con evidencia fake explícita; activación real falla cerrada. |
| POST /v1/device/sessions/challenge | dispositivo | Challenge de un uso; 200. |
| POST /v1/device/sessions | dispositivo | Token PoP 15 min; 201. |
| POST /v1/device/keys/rotate/challenge | sesión+PoP | 200. |
| POST /v1/device/keys/rotate | sesión+PoP | 200; ambas firmas. |
| POST /v1/admin/devices/{device_id}/revoke | admin+CSRF | 200 idempotente. |
| GET /v1/admin/mdm/status | admin | Estado sanitizado; nunca token. |
| GET /v1/admin/mdm/devices | admin | Solo lectura fake en 0A; cliente real queda deshabilitado hasta validación externa. |

Los endpoints GPS de [SPEC-00](../spec-00-technical-feasibility/api-contracts.md) son candidatos futuros y no figuran como operativos en 0A. El diagnóstico OAuth actual bajo /api/integrations/mdm/oauth es herramienta local, no superficie contractual del producto. Se mantiene en un proceso dev-only separado; no se carga desde la API Wave 0A ni se usa durante sus pruebas.

## Reglas de contrato MDM

MdmProvider recibe customerId string sin convertirlo a número; ManageEngineReadOnly usa X-CUSTOMER, Authorization documentado por SPEC-00, host/región allowlist, redirect manual/error y timeout. Solo GET de inventario; las consultas reales precisan consentimiento y credenciales protegidas. El inventario fake se etiqueta en cada respuesta y nunca confirma existencia del Customer ID ni edición Free. La API normaliza 401, 403, 429, timeout y 3xx con códigos estables sin eco de URL sensible. Los scopes reales se toman del registro SPEC-00 y no se amplían por conjetura.
