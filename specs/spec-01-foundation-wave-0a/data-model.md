# Modelo de datos inicial

## Convenciones

PostgreSQL 18/PostGIS 3.6 en base geops independiente. UUID canónicos generados por servidor, timestamptz UTC, claves foráneas explícitas, nombres snake_case, versiones bigint para compare-and-swap. No se almacenan secretos de invitación, sesiones o tokens en claro. Toda migración numerada es transaccional cuando Postgres lo permita, con checksum y registro schema_migrations; el despliegue ejecuta un job único y falla si el esquema es incompatible.

## Tablas de 0A

| Tabla | Campos principales | Restricciones/índices |
| --- | --- | --- |
| admin_user | id, email_normalized, password_hash, state, created_at, updated_at, version | UNIQUE email_normalized; state ACTIVE/LOCKED/REVOKED; sin rol jerárquico. |
| admin_session | id, admin_id, token_hash, csrf_hash, issued_at, idle_expires_at, absolute_expires_at, revoked_at | FK admin; UNIQUE token_hash; índice expiración y admin_id/state. |
| admin_recovery | id, admin_id, code_hash, expires_at, consumed_at, issued_by, audit_ref | Solo una solicitud activa por admin; sin guardar código claro. |
| geops_device | id, status, display_label, created_at, updated_at, version | Estado DRAFT/INVITED/PENDING_CONFIRMATION/ACTIVE/SUSPENDED/REVOKED/RETIRED; sin usar UDID como identidad. |
| mdm_binding | id, geops_device_id, provider, customer_id, mdm_device_id, state, verified_at, verification_method, evidence_ref, version | FK device; UNIQUE parcial (provider,customer_id,mdm_device_id) WHERE state=ACTIVE; UNIQUE parcial por device activo. customer_id TEXT opaco. |
| device_invitation | id, geops_device_id, secret_hmac, status, delivery_mode, issued_by, issued_at, expires_at, consumed_at, version | FK device/admin; CHECK TTL máximo 10 min; UNIQUE parcial por device si ISSUED/CLAIMED; índice expiración. |
| enrollment_claim | id, invitation_id, geops_device_id, mdm_device_id, public_key_spki_der, client_nonce_hash, challenge_id, status, pairing_code_hash, expires_at, version | FK; una claim activa por invitación; challenge 2 min; no guardar pairing_code claro. |
| device_key | id, geops_device_id, public_key_spki_der, public_key_fingerprint, status, created_at, revoked_at, version | UNIQUE parcial por device WHERE status=ACTIVE; P-256 validada. |
| device_session | id, geops_device_id, key_id, token_hash, issued_at, expires_at, revoked_at | FK; token 15 min, índice expiración y device/key. |
| device_challenge | id, geops_device_id, key_id nullable, purpose, challenge_hash, expires_at, consumed_at | Propósito ENROLL/SESSION/ROTATE, 32 bytes; índice expiración. |
| device_request_nonce | key_id, nonce_hash, observed_at, expires_at | PK (key_id,nonce_hash); retener durante ventana anti-replay; limpieza por lotes. |
| mdm_integration | id, provider, region, customer_id, status, encrypted_refresh_token, token_key_version, scopes, updated_at | UNIQUE (provider,region,customer_id); cifrado con clave fuera de DB; no access token persistente salvo justificación. |
| audit_event | id, occurred_at, actor_type, actor_id, device_id nullable, action, outcome, correlation_id, previous_state, next_state, metadata_redacted | Índices (occurred_at), (device_id,occurred_at), (actor_id,occurred_at); append-only por aplicación. |
| schema_migrations | version, checksum, applied_at | Version única; fallo de checksum bloquea readiness. |

Las relaciones y nombres finales de campos se congelan con la primera migración y contratos, pero estas invariantes son obligatorias. HMAC de invitación usa clave de servidor separada del cifrado MDM y rotación versionada. No registrar en audit_event códigos, tokens, claves privadas, coordenadas ni cuerpos HTTP.

## Geoespacial y retención

La migración inicial habilita CREATE EXTENSION postgis y comprueba versión. No crea todavía position_event ni ejecuta purga de datos GPS: la ingesta llega en Wave 1/2. La migración futura define geography(Point,4326), índice GiST y particiones por captured_at (mes o semana según volumen medido), con received_at del servidor e idempotencia por event_id. Para RF-14, borrado automático de posiciones al cumplir 90 días desde captured_at, con política explícita para eventos tardíos, backups y retención legal aprobada. Una prueba de particiones/purga con datos sintéticos será puerta de la wave de ingesta; no afirmar cumplimiento antes.

## Backup/restore

Backup lógico diario cifrado fuera del host de DB, retención y llave administradas por operación; restore aislado periódico y verificación de checksums/esquema. En 0A se ensaya backup+restore con datos ficticios y revocaciones. Objetivos RPO/RTO y tratamiento de datos reales dependen de revisión E4 y operación; no se asigna garantía sin prueba.
