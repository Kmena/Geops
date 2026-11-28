# SPEC-05 — Contrato API Wave 3

Todos los endpoints son administrativos y usan la sesión web existente. La identidad técnica PoP de la APK no puede llamarlos. El acceso por dispositivo exige `mdm.diagnostics.view`, `mdm.policies.view` y grants vigentes en `gps_data_tenant_access` y `gps_health_tenant_access`; la vista previa y solicitud requieren además `mdm.permissions.remediate`; el historial requiere `mdm.audit.view`. Ninguna migración concede permisos automáticamente. Los POST exigen Origin permitido y CSRF.

| Ruta | Respuesta y límites |
| --- | --- |
| `GET /v1/admin/mdm/capabilities` | Matriz de capacidades documentadas, `tenant_evidence=UNKNOWN`, `write_enabled=false`; requiere `mdm.policies.view`. No representa scopes concedidos. |
| `GET /v1/admin/mdm/devices/:id/configuration` | GEOPS/tenant/agente/instalación, vínculo MDM, lectura por sección, deseado conocido, perfiles asignados, aplicación reportada, permisos Android efectivos, app GEOPS y findings. Un perfil `SCHEDULED` es `PENDING`; la ausencia de datos es `UNKNOWN`. |
| `POST /v1/admin/mdm/remediations/preview` | `{device_id,profile_id}`; verifica vínculo real, lectura de perfiles, detalle Android publicado y versión. Si es apto, devuelve digest y `impact_device_count=1` para **asociación individual**; `write_enabled=false` y `CONSOLE_ACTION_REQUIRED`. Un perfil compartido no se modifica ni se publica. |
| `POST /v1/admin/mdm/remediations/requests` | `{device_id,profile_id,preview_digest,idempotency_key,reason}`. Relee la vista previa, exige el mismo digest, almacena `AWAITING_APPROVAL` con vencimiento a cinco minutos. Retry igual devuelve `duplicate=true`; misma clave con otro digest devuelve 409. No envía nada a ManageEngine. |
| `GET /v1/admin/mdm/devices/:id/remediations` | Hasta 50 solicitudes del equipo/tenant autorizado, con estado y timestamps; no incluye secretos ni payloads MDM. |
| `POST /v1/admin/mdm/remediations/requests/:id/submit` | Valida admin y acceso al equipo, audita rechazo y devuelve 503 `mdm_write_disabled`. Nunca genera `APPLIED` ni `EFFECTIVE_VERIFIED`. |

`mdm_remediation_request` enumera `REQUESTED`, `VALIDATED`, `AWAITING_APPROVAL`, `SUBMITTED`, `PENDING_APPLICATION`, `APPLIED`, `EFFECTIVE_VERIFIED`, `PARTIALLY_APPLIED`, `FAILED`, `TIMED_OUT`, `CANCELLED` y `SUPERSEDED` para evolución futura. En Wave 3 solo se crea `AWAITING_APPROVAL`; los demás estados no se simulan. `mdm_remediation_event` es inmutable. La propuesta de envío posterior exige revalidar perfil/versión, propietario, impacto, autorización específica, resultado MDM y telemetría efectiva Android. Un HTTP exitoso del proveedor nunca equivale a `EFFECTIVE_VERIFIED`.

`ManageEngineProfileWriter` implementa el POST documentado de asociación individual y lo deniega salvo coincidencia exacta de cliente, ID MDM, perfil, referencia de autorización y vencimiento. Se probó con `fetch` simulado; **no se inyecta en `main.ts` ni en `submit`** hasta demostrar tenant/scopes/alcance y completar seguimiento de aplicación. Por eso no hay vía operativa de escritura en esta entrega.

El backend no ofrece una acción de conceder `ACCESS_BACKGROUND_LOCATION` ni de modificar batería: su endpoint y capacidad real del tenant son `UNKNOWN`. Para ajustes solo visibles en consola, el contrato devuelve instrucciones de investigación y `CONSOLE_ACTION_REQUIRED`; no automatiza la UI. No se implementaron aún pantallas completas de APK o portal.
