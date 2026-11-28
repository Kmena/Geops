# SPEC-05 — Arquitectura de autenticación APK Corporate (Wave 4)

Estado: decisión implementada para laboratorio, 2026-11-27. La auditoría encontró `AdminAuthService`, usuarios `admin_user`, sesiones `admin_session`, permisos `admin_permission`, grants GPS por tenant y rutas con Origin/CSRF. Se reutilizan sin una migración de credenciales ni un segundo sistema de usuarios. El flujo de canje por navegador planteado en Wave 2 queda sustituido por login HTTPS directo a la autoridad GEOPS existente; no hay cambio incompatible en la autenticación web. La sesión móvil queda en memoria de proceso, por lo que un reinicio exige nuevo login.

| Identidad | Autoridad y almacenamiento | Uso | Dependencia |
| --- | --- | --- | --- |
| Dispositivo/instalación | Android Keystore, estado cifrado y sesión PoP | Config GPS v2, posiciones y diagnóstico propio | Independiente de login administrativo |
| Agente asignado | `agent_device_link` en backend | Atribución de trabajo | Nunca se deriva del login de esta pantalla |
| Empleado interactivo | No hay autoridad de login de empleado en la APK actual | Diagnóstico local disponible tras activación | No habilita administración |
| Administrador interactivo | `admin_user`, contraseña Argon2id y `admin_session` existentes | Lecturas y solicitudes RBAC | Cookie/CSRF solo en memoria, no en preferencias ni archivos |
| Permisos | `admin_permission`, `gps_data_tenant_access` y `gps_health_tenant_access` | Alcance por ruta y dispositivo | Revalidación backend en cada consulta/acción |

## Protocolo

1. `POST /v1/admin/auth/sessions` por HTTPS al origen fijo de Staging, con credenciales GEOPS existentes. La APK no guarda contraseña; limpia el campo y el arreglo de caracteres tras la petición. El JSON y el valor temporal de red viven solo durante la llamada.
2. La APK extrae únicamente la cookie `__Host-geops_stage_admin` y el CSRF, sin CookieManager ni WebView. Los mantiene en memoria volátil de proceso; no hay backup de la aplicación. `GET /v1/admin/auth/me` y `GET /v1/admin/auth/permissions` verifican sesión/permiso. La cookie no se muestra ni se registra.
3. Las lecturas MDM usan `/v1/admin/mdm/*` de Wave 2/3. El backend comprueba usuario ACTIVE, capacidad y grants de tenant. Un ID ManageEngine no concede acceso. La APK solo consulta el ID GEOPS activado localmente; la API valida su alcance.
4. Vista previa y solicitud usan Origin y `X-CSRF-Token`. `AdminAuthService.assertRecentLogin` exige emisión de sesión en los últimos cinco minutos. Reautenticarse crea una sesión nueva con contraseña del mismo usuario y revoca la anterior; una cuenta distinta es rechazada.
5. `DELETE /v1/admin/auth/sessions/current` cierra la sesión. La APK borra primero la credencial en memoria incluso sin red. En ese caso la revocación remota puede esperar al vencimiento de 30 min por inactividad; el token perdido no persiste en disco.
6. El backend aplica 30 min de inactividad y 8 h absolutos; un 401 limpia la sesión local. Revocación, permisos retirados y cambio de grants se validan de nuevo. Ninguna de estas acciones llama a `AgentRuntime`, detiene el servicio GPS, elimina Keystore, cambia el agente asignado ni modifica el enrolamiento.

Las credenciales ManageEngine solo existen en backend. El gate `mdm_write_disabled` permanece después de login y reautenticación. No se implementa login de empleados nuevo ni intercambio de sesión con otra aplicación. La autenticación Corporate no se presenta en BYOD.

## Matriz RBAC de pantalla

| Función | Sin sesión | `mdm.diagnostics.view` + tenant | `mdm.policies.view` + diagnóstico | `mdm.audit.view` | `mdm.permissions.remediate` + login reciente |
| --- | --- | --- | --- | --- | --- |
| Diagnóstico local, permisos Android y exportación local | Sí | Sí | Sí | Sí | Sí |
| Último diagnóstico/backend | No | Sí | Sí | Sí | Sí |
| Configuración y capacidades ManageEngine | No | No | Sí | Sí con políticas | Sí con políticas |
| Historial de solicitudes | No | No | No | Sí con tenant | Solo con `mdm.audit.view` |
| Vista previa y solicitud de asociación de perfil | No | No | No | No | Sí; backend conserva bloqueo de escritura real |

La UI puede ocultar acciones según permisos, pero la autorización efectiva está en el backend. El usuario no administra otro dispositivo por cambiar la URL o el ID en la APK.
