# Aprovisionamiento seguro de dispositivos GEOPS

**Estado: DECISIÓN DE ARQUITECTURA ACEPTADA, IMPLEMENTACIÓN Y PILOTO PENDIENTES.** [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md) fija el protocolo. Ninguna prueba de seguridad o entrega MDM se ha ejecutado. Identidad GEOPS, identidad MDM y asignación a empleado son objetos separados.

## Invariantes

- Cada teléfono activo tiene un único `geops_device_id` (UUID), una clave privada propia creada dentro de Android Keystore y un vínculo MDM administrado. Nunca se comparte clave entre teléfonos ni se empaqueta en APK.
- La clave privada no sale del teléfono. El servidor conserva clave pública, identificador de clave, estado y auditoría; el token de sesión se guarda solo como hash. La app no recibe token OAuth de ManageEngine.
- El `mdm_device_id`, UDID, serial y cualquier valor de managed configuration son **atributos declarativos**, no pruebas de posesión ni secretos. Suplantar uno no debe activar una identidad.
- Inscribir, activar, rotar, revocar y reasignar son operaciones auditadas por administradores. Una invitación no habilita ingesta hasta que exista aprobación presencial/verificación independiente.
- La revocación GEOPS se verifica en **cada solicitud**, incluso con sesión aún vigente. No depende de sincronización o retiro MDM.

## Estados y objetos

| Objeto | Estado / dato mínimo |
| --- | --- |
| Dispositivo GEOPS | DRAFT → INVITED → PENDING_CONFIRMATION → ACTIVE → SUSPENDED/REVOKED/RETIRED. Solo ACTIVE puede obtener sesión o enviar datos. |
| Vínculo MDM | tenant/región, `mdm_device_id`, modo Fully Managed confirmado, instante y método de verificación, última comprobación, estado. Un mismo registro MDM no puede vincularse a dos identidades GEOPS activas. |
| Invitación | ID, `geops_device_id`, MDM esperado, HMAC del secreto con clave del servidor, `issued_at/expires_at/claimed_at/consumed_at`, estado ISSUED/CLAIMED/CONSUMED/CANCELLED/EXPIRED y emisor. |
| Clave | `key_id`, `geops_device_id`, algoritmo P-256 ECDSA SHA-256, clave pública, estado PENDING/ACTIVE/REVOKED, versión, alta/baja y evidencia de attestation si existe. |
| Sesión | Token aleatorio de 256 bits, hash, `key_id`, dispositivo, emisión/expiración (15 min), revocación. Es inutilizable sin firma de la clave vinculada. |
| Asignación | Empleado y vigencia; cambiar empleado no cambia histórico ni hereda credenciales. |

## Flujo de inscripción

1. Un administrador autenticado registra el dispositivo lógico y selecciona el registro **gestionado Fully Managed** en la consola MDM. Si la API Free está disponible, el backend consulta el registro con credenciales de integración; si no, el administrador documenta verificación manual de consola y dos rasgos físicos del teléfono. La modalidad manual se marca MANUAL_PENDING_REVIEW y no se presenta como prueba API.
2. GEOPS emite un secreto aleatorio de 256 bits, codificado para QR o managed configuration, válido **10 minutos**, destinado a ese `geops_device_id` y `mdm_device_id`. Se almacena solo HMAC, se muestra una sola vez al operador, se entrega por canal presencial supervisado o por configuración MDM dirigida a un único equipo **si se valida M08**. La configuración se retira tras inscripción. Nunca se envía por correo común ni se conserva en logs/backup.
3. El agente genera client_nonce aleatorio antes del par P-256; si solicita attestation, deriva el reto previo a keygen según identity-api-contract.md. Crea el par en Android Keystore con propósito de firma, clave no exportable y alias asociado a la instalación. Envía secreto de invitación, clave pública, identificador MDM recibido (si existe), versión de app y nonce de cliente por TLS. El backend comprueba vigencia, estado, destino y unicidad; reserva la invitación **atómicamente** como CLAIMED, registra la clave PENDING y devuelve un challenge aleatorio de un solo uso. Reclamaciones concurrentes o repetidas se rechazan. Una reclamación maliciosa solo causa cancelación/reemisión, nunca activación automática.
4. El agente firma los bytes exactos GEOPS-ENROLL-V1 fijados en identity-api-contract.md; claim_id vincula transaccionalmente la invitación, el dispositivo, la clave y el nonce. El backend valida firma y challenge. Si el equipo soporta [Android key attestation](https://developer.android.com/privacy-and-security/security-key-attestation), se usa antes de generar la clave el reto de attestation derivado de la invitación y client_nonce definido en identity-api-contract.md; se verifica cadena, raíz, revocación, security level, challenge, vínculo a clave pública y, cuando se exponga, identidad de app. La falta de soporte se registra; no se afirma hardware backing sin verificarlo.
5. GEOPS muestra un código corto de emparejamiento derivado del challenge y huella de clave. El administrador compara ese código **en la pantalla física del teléfono** con la consola GEOPS y confirma que corresponde al equipo seleccionado en MDM. El backend refresca/valida el vínculo MDM si la API funciona; en modo manual exige registro de comprobación presencial. Solo entonces consume la invitación y activa la clave y el dispositivo en una transacción. Si vence la invitación antes de confirmar, se cancela y se emite otra. No basta con informar un UDID coincidente.
6. El agente elimina el material de invitación y solicita una sesión con challenge firmado. El backend emite token opaco de 15 minutos ligado a `key_id`; el agente lo conserva solo en memoria y lo renueva tras reinicio. Registra método de vinculación, operador, tiempo y huella, sin secreto ni identificadores sensibles en el log general.

**Riesgo residual:** un atacante con control físico del teléfono durante la confirmación, privilegios del sistema o una consola MDM comprometida puede superar controles operativos. La validación de attestation eleva la garantía de origen de clave, pero no prueba por sí sola inscripción MDM. El modo manual tiene menor garantía; su aceptación para producción requiere decisión de seguridad tras piloto.

## Autenticación y ciclo de vida

- Toda llamada del agente usa TLS, `Authorization: Bearer <sesión>`, `X-GEOPS-Key-Id`, `X-GEOPS-Timestamp`, `X-GEOPS-Nonce` y `X-GEOPS-Signature`. Se firma la representación canónica versionada de método, path absoluto sin query (las rutas /v1/device rechazan query string), SHA-256 del cuerpo exacto, hash del token, timestamp y nonce, conforme al contrato byte a byte de api-contracts.md. El servidor verifica firma P-256, sesión ligada a clave, estado ACTIVE, ámbito, reloj ±5 minutos y nonce no visto durante 10 minutos. El nonce debe registrarse atómicamente para impedir carreras. Un reintento funcional genera firma/nonce nuevos, pero conserva `event_id` y `batch_id`.
- La sesión se renueva antes de expirar mediante challenge de servidor firmado por la clave activa; no existe refresh token portátil. Si está offline, la app conserva eventos cifrados y renueva al volver la red. Errores de reloj usan hora de servidor del challenge, sin desactivar prevención de replay.
- Rotación ordinaria: la clave vieja activa firma solicitud con clave pública nueva; la nueva firma challenge de posesión y, si se solicita attestation, se genera con reto de rotación previo según identity-api-contract.md. El servidor activa la nueva y revoca la vieja transaccionalmente; cualquier solapamiento excepcional tiene vencimiento corto y alcance explícito. Sin clave vieja, no hay autorrotación: administrador revoca y repite inscripción física.
- Pérdida o sospecha de compromiso: administrador suspende/revoca inmediatamente en GEOPS, invalida sesiones y luego solicita bloqueo/borrado en MDM. Llamadas posteriores reciben rechazo, incluso si MDM está desconectado. Eventos aún solo locales pueden perderse; registrar brecha de cobertura y no inventarlos.
- Reinstalación o borrado de datos destruye la clave de la instalación; una copia de app/backup no restaura identidad. Excluir clave, token, invitación y base GPS del backup aplicable. Tras reinstalar, revocar identidad anterior y generar invitación nueva con verificación MDM/presencial.
- Reasignación: cerrar asignación de empleado con vigencia, revocar clave/sesiones, aplicar borrado/reinscripción según política MDM, comprobar estado y emitir nueva invitación. Mantener atribución histórica por vigencia. Si un mismo hardware se reinscribe con nuevo MDM ID, registrar nuevo vínculo y relación de reemplazo, nunca reusar credencial anterior.

## Amenazas y mitigaciones

| Amenaza | Control | Evidencia pendiente |
| --- | --- | --- |
| Invitación filtrada o capturada antes del equipo legítimo | TTL 10 min, un solo CLAIM atómico, MDM esperado, canal dirigido, confirmación física fuera de banda, cancelación/reemisión. | Dos reclamaciones simultáneas; atacante no logra ACTIVE. |
| Reutilización de QR/configuración o respuesta firmada | Estados consumidos, challenge/nonce únicos, expiración, replay cache atómica. | Segundo claim y replay rechazados. |
| Suplantación por UDID o copia de APK | UDID no autoriza; clave Keystore, PoP por llamada, verificación física y attestation cuando exista. | Dispositivo impostor no obtiene sesión. |
| Robo de bearer o de base servidor | Token corto ligado a clave, hash de token, claves públicas en servidor, rate limit y revocación por llamada. | Token sin firma no autoriza. |
| Teléfono perdido, root o MDM retirado | Suspensión GEOPS inmediata, control MDM, auditoría y observación de estado; root sigue riesgo residual. | Rechazo tras suspensión y simulación de retiro. |
| Reinstalación, backup o reasignación | No restaurar clave, reprovisión presencial y separación de historial. | No se recupera acceso con backup o clave antigua. |
| MITM, reloj y denegación por claims | TLS, firma de contenido, challenge de servidor, ventana temporal, límites por IP/invitación y alerta. | Alteración/replay/reloj fuera de ventana rechazados. |

## Criterios de aceptación para el piloto

A01. Dos teléfonos muestran claves públicas y `key_id` diferentes; ninguna clave privada sale del Keystore. Registrar si cada uno ofrece attestation verificada o excepción explícita.

A02. Invitación expiró/consumida/cancelada, segundo claim, claim concurrente, MDM ID ajeno y confirmación física ausente no activan dispositivo. El secreto no aparece en logs, backup ni Git.

A03. Token robado sin firma, firma con otra clave, cuerpo alterado, nonce repetido, timestamp inválido y dispositivo revocado se rechazan. Revocación tiene efecto en la **siguiente petición**.

A04. Renovación online, rotación ordinaria y revocación pasan; la vieja clave/token dejan de funcionar. Offline conserva datos sin necesitar sesión activa y sincroniza tras nueva sesión.

A05. Pérdida, reinstalación y reasignación requieren nueva invitación/aprobación; no se reatribuyen eventos históricos. Verificar limpieza de configuración MDM y backup.

A06. Vínculo GEOPS↔MDM es inequívoco en A/B, con método y fecha de verificación. La vía API y la vía manual se distinguen en auditoría; la vía API solo se acepta como probada tras [M01–M09](mdm-free-api-validation.md).

Estos son criterios a ejecutar, **no PASS**. Las pruebas de app, MDM y teléfonos forman parte de [pilot-test-plan.md](pilot-test-plan.md).
