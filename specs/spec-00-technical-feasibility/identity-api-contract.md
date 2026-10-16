# Contrato v1 de identidad del agente

**Estado: READY_FOR_IMPLEMENTATION_DESIGN; sin implementación ni validación real.** Este contrato concreta [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md) y [device-provisioning.md](device-provisioning.md). Los nombres de campos y valores aquí son la base de los esquemas versionados que se incorporarán a `packages/api-contracts/` antes de escribir controladores. La revisión de seguridad y pruebas A01–A06 siguen pendientes; SPEC-00 permanece BLOCKED.

## Representaciones y reglas comunes

Todos los IDs GEOPS, claim, invitación, clave y challenge son UUID minúscula canónica; tiempos de respuesta son RFC 3339 UTC. Material binario se codifica base64url sin padding. Las claves públicas P-256 se envían como DER SubjectPublicKeyInfo. Firmas ECDSA SHA-256 se envían DER. El servidor asigna IDs y no acepta uno propuesto por el agente excepto nonce. Cada transición sensible registra correlation_id, actor, dispositivo, estado anterior/nuevo y resultado, sin secretos ni cuerpos. Las respuestas de error usan {code, correlation_id}; 400 formato, 401 prueba inválida, 403 dispositivo/rol, 409 estado o replay, 410 expiración, 429 límite. Todas las operaciones usan HTTPS y límite de tamaño; las de invitación/claim tienen rate limit por administrador, dispositivo e IP.

En los ejemplos, valores entre ángulos son marcadores ficticios, no credenciales. El token de invitación se muestra una sola vez y jamás se devuelve en lectura de estado.

## Inscripción

| Operación | Solicitud mínima | Respuesta mínima / efectos |
| --- | --- | --- |
| POST /v1/admin/devices/{device_id}/invitations | {mdm_binding_id, delivery_mode: "supervised_qr" o "managed_configuration"}; sesión de administrador | {invitation_id, geops_device_id, invitation_secret, expires_at}; 201. Cancela invitación anterior no consumida, crea ISSUED con HMAC del secreto. |
| POST /v1/device/enrollment/claims | {invitation_id, invitation_secret, geops_device_id, mdm_device_id, public_key_spki, client_nonce}; sin sesión | {claim_id, challenge_id, challenge, expires_at}; 201. Compara HMAC en tiempo constante y reserva CLAIMED mediante compare-and-swap transaccional. Challenge de 32 bytes y TTL 2 min. |
| POST /v1/device/enrollment/claims/{claim_id}/proof | {challenge_id, signature, attestation_chain?}; sin sesión | {status: "PENDING_CONFIRMATION", pairing_code, expires_at}; 200. Challenge se consume una vez; prueba incorrecta cancela claim. |
| POST /v1/admin/devices/{device_id}/activate | {claim_id, pairing_code, mdm_verification_method, evidence_ref}; sesión de administrador | {status: "ACTIVE", key_id, mdm_binding_id}; 200. Comprueba código y vínculo, consume invitación, activa clave/dispositivo y audita en una transacción. |

La prueba de claim firma estos bytes UTF-8 con LF entre campos y sin LF final:

```text
GEOPS-ENROLL-V1
<claim_id>
<challenge_id>
<challenge base64url>
<geops_device_id>
<mdm_device_id>
<base64url(SHA-256(public_key_spki DER))>
<client_nonce base64url>
```

El `pairing_code` tiene ocho dígitos decimales y deriva de los primeros 32 bits de SHA-256 de los bytes de challenge seguidos del DER de clave pública, módulo 100000000, con ceros a la izquierda. Es comparación visual, no factor criptográfico. La consola solo permite activar tras marcar la verificación del equipo físico y del registro MDM. Se intenta attestation durante la creación de clave: si se recibe una cadena inválida, se rechaza; si no puede obtenerse cadena por falta de soporte, se registra excepción explícita del administrador de seguridad antes de activar. No se infiere inscripción MDM de attestation.

## Sesión y solicitudes ordinarias

| Operación | Solicitud mínima | Respuesta mínima / efectos |
| --- | --- | --- |
| POST /v1/device/sessions/challenge | {geops_device_id, key_id}; sin sesión | {challenge_id, challenge, server_time, expires_at}; 200. Challenge 32 bytes, 2 min, un uso. Rate limit. |
| POST /v1/device/sessions | {geops_device_id, key_id, challenge_id, signature}; sin sesión | {access_token, expires_at, key_id}; 201. Verifica firma y ACTIVE; token aleatorio 256 bits, 15 min, hash en servidor. La renovación repite ambos pasos. |
| GET /v1/device/config, POST /v1/device/heartbeats y POST /v1/device/locations/batches | Sesión bearer + headers de firma PoP del [contrato de ingesta](api-contracts.md) | Solo se ejecutan tras validar sesión, firma, nonce, estado y ámbito. |
| POST /v1/device/keys/rotate/challenge | Sesión activa firmada | {challenge_id, challenge, expires_at}; 200. Challenge de un uso, 2 min. |
| POST /v1/device/keys/rotate | {challenge_id, new_public_key_spki, old_signature, new_signature} con sesión firmada | {new_key_id, status: "ACTIVE"}; 200. Ambas firmas cubren GEOPS-ROTATE-V1, challenge_id, challenge, device_id, old_key_id y hash DER de clave nueva, con LF y sin LF final; revoca clave/sesiones viejas atómicamente. |
| POST /v1/admin/devices/{device_id}/revoke | {reason}; sesión de administrador | {status: "REVOKED"}; 200. Revoca claves, sesiones e invitaciones inmediatamente. Idempotente si ya revocado. |

El PoP de cada solicitud ordinaria está definido byte a byte en [api-contracts.md](api-contracts.md). La renovación no requiere token previo válido: basta prueba de la clave aún activa. El token vive solo en memoria; tras reinicio o durante offline se guardan eventos y se obtiene nueva sesión antes de sincronizar. Cualquier cambio de estado SUSPENDED/REVOKED se consulta en cada llamada.

## Concurrencia y recuperación

La base impone una sola invitación ISSUED/CLAIMED por dispositivo, una sola clave ACTIVE por dispositivo salvo ventana de rotación expresamente aprobada, y un vínculo MDM activo único por tenant/mdm_device_id. Claim e invitación se actualizan con condición de estado y versión; una sola transacción gana. El servidor nunca activa automáticamente al primer reclamante. Cancelación/expiración invalidan challenge, claim y código. Reinstalación o pérdida de clave exige revocación y nueva invitación; no hay endpoint de recuperación por UDID o correo. La política completa está en [device-provisioning.md](device-provisioning.md).
