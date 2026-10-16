# Contratos técnicos candidatos

**Estado: DESIGN_PROPOSAL para ingesta y límites; identidad de dispositivo aceptada en [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md).** No hay API ni clientes implementados. Referencias: [PRD RF-02, RF-04–RF-07, RF-14](../prd/GEOPS-PRD-v1.1.md), [ADR-003](../architecture/adr/ADR-003-ingesta-gps.md), [architecture.md](architecture.md). Antes de implementar se versionarán esquemas en `packages/api-contracts/`.

## Identidad y aprovisionamiento

El administrador emite una invitación aleatoria individual de 256 bits, válida 10 minutos y de un solo uso, vinculada a `device_id` GEOPS y registro MDM esperado. El servidor guarda su HMAC y la entrega presencial supervisada o por managed configuration individual **solo si se valida en Free**. El agente genera una clave P-256 no exportable en Android Keystore; prueba posesión con challenge. Activar requiere comparación presencial de código y verificación independiente del registro MDM. La sesión opaca de 15 minutos queda vinculada a la clave y cada llamada se firma. MDM/OAuth y GEOPS usan credenciales separadas. Los estados, amenazas y recuperación están en [device-provisioning.md](device-provisioning.md); los payloads v1 listos para esquemas en [identity-api-contract.md](identity-api-contract.md) y la decisión en [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md).

## Endpoints de identidad (contrato de diseño)

| Endpoint | Actor y precondición | Resultado y regla |
| --- | --- | --- |
| `POST /v1/admin/devices/{device_id}/invitations` | Administrador autenticado; vínculo MDM esperado comprobado. | Crea invitación de 256 bits/10 min; devuelve secreto **solo una vez** por canal seguro. Guarda HMAC, estado y auditoría. La creación cancela invitaciones anteriores no consumidas. |
| `POST /v1/device/enrollment/claims` | Agente con invitación vigente, clave pública P-256 y nonce. | Reserva CLAIMED atómicamente y devuelve `claim_id`, challenge y expiración. Rechaza secreto ya reclamado/consumido, MDM esperado distinto o dispositivo retirado. |
| `POST /v1/device/enrollment/claims/{claim_id}/proof` | Agente firma challenge, invitación, IDs, clave pública y nonce. | Valida posesión y attestation si se exige; pasa a PENDING_CONFIRMATION. **No** emite sesión todavía. |
| `POST /v1/admin/devices/{device_id}/activate` | Administrador compara código en equipo físico y consola, valida vínculo MDM. | Consume invitación y activa clave/dispositivo en transacción; registra operador, método y evidencia. |
| `POST /v1/device/sessions/challenge` y `POST /v1/device/sessions` | Clave activa prueba posesión con challenge de un uso. | Token opaco aleatorio, 15 min, ligado a `device_id/key_id`; el servidor guarda hash. Renovación repite challenge, sin refresh token portátil. |
| `POST /v1/device/keys/rotate` | Sesión activa; firmas de clave antigua y nueva sobre challenge. | Activa nueva clave, revoca antigua y sesiones asociadas atómicamente. Sin clave antigua requiere reprovisión administrada. |
| `POST /v1/admin/devices/{device_id}/revoke` | Administrador autenticado. | Revoca acceso y sesiones inmediatamente; un reintento no reactiva identidad. |

Los nombres y campos de identidad v1 están fijados en [identity-api-contract.md](identity-api-contract.md); se materializarán como esquemas JSON versionados en `packages/api-contracts/` antes de controladores. Los límites de ingesta restantes siguen candidatos. Las operaciones de invitación/activación deben ser transaccionales y auditadas; no devolver secretos en GET ni registrar cuerpos sensibles. `409` expresa claim concurrente/consumido o estado incompatible, `410` expiración/cancelación, `401/403` autenticación/autorización, `429` límite de intentos. La selección de modo manual frente a API MDM queda explícita en auditoría.

## Autenticación de las llamadas del agente

Headers: `Authorization: Bearer <sesión-opaca>`, `X-GEOPS-Key-Id`, `X-GEOPS-Timestamp`, `X-GEOPS-Nonce`, `X-GEOPS-Signature`. En v1, `key-id` es UUID; timestamp son segundos Unix UTC decimales; nonce son 16 bytes aleatorios base64url sin padding; firma es DER ECDSA P-256/SHA-256 en base64url sin padding. Todos los endpoints de dispositivo v1 rechazan query string; la ruta se firma como path absoluto que recibe la API, sin fragmento. El cuerpo firmado son los bytes UTF-8 exactos enviados; para GET sin cuerpo se usa SHA-256 de cadena vacía.

La entrada de firma es UTF-8, campos separados por LF (0x0A), sin LF final, en este orden:

```text
GEOPS-REQ-V1
<METHOD ASCII MAYÚSCULAS>
<PATH ABSOLUTO>
<base64url(SHA-256(body bytes))>
<base64url(SHA-256(token UTF-8))>
<timestamp decimal>
<nonce>
<key_id UUID minúscula>
```

El servidor verifica token ligado a `key_id/device_id`, firma, dispositivo ACTIVE y clave vigente. Inserta `(key_id, nonce)` en cache atómica de 10 minutos **antes de ejecutar** la operación; rechaza duplicados. Rechaza hora fuera de ±5 minutos. La expiración del token es 15 minutos y la revocación se consulta en cada llamada. El challenge de sesión es aleatorio de 32 bytes, de un uso y TTL 2 minutos; la prueba firma `GEOPS-SESSION-V1\n<challenge_id>\n<challenge base64url>\n<key_id>\n<geops_device_id>` con la misma clave. El servidor devuelve su hora para corregir deriva sin relajar controles. TLS es obligatorio. Reintentar un lote requiere firma/nonce nuevos pero conserva IDs de eventos. [device-provisioning.md](device-provisioning.md)

**Invariantes de respuesta:** `401` para sesión/firma/challenge inválidos, `403` para dispositivo revocado o vínculo de ID incompatible, `409` para nonce o claim reutilizado, `410` para invitación expirada/cancelada. El cuerpo de error contiene código estable y `correlation_id`, nunca secretos. El cliente no envía GPS hasta ACTIVE.

## POST /v1/device/locations/batches

Headers: autenticación firmada anterior y `Content-Type: application/json`. La sesión bearer sola no autoriza. El `device_id` del cuerpo debe coincidir con la identidad autenticada. `schema_version=1`. Valores **candidatos**, no criterios de aceptación aprobados: máximo 100 eventos y 256 KiB por solicitud; el servidor anunciará límites finales. `batch_id` UUID se conserva en reintentos, pero la deduplicación real es por `(device_id,event_id)`.

```json
{
  "schema_version": 1,
  "batch_id": "9a26316d-8e6c-4d98-b8ac-340c679a6e12",
  "device_id": "cf19d8db-823e-4ce8-b259-f2938a6b3208",
  "events": [
    {
      "event_id": "b157a767-af6f-4e24-a7a4-62804c4c7b2d",
      "captured_at": "2026-10-16T14:01:00Z",
      "latitude": 9.9281,
      "longitude": -84.0907,
      "accuracy_m": 18.4,
      "schedule_version": 3,
      "source": "fused"
    }
  ]
}
```

Las coordenadas son WGS84, longitud/latitud se construyen en ese orden para PostGIS. `accuracy_m` es precisión horizontal reportada y no prueba exactitud. IDs son UUID generados una vez en el teléfono y persistidos antes del envío. `captured_at` es UTC de captura, `received_at` lo fija el servidor; se guardan ambos. Metadatos opcionales como `boot_session_id` y tiempo monotónico podrán ayudar a diagnosticar cambios de reloj, sin sustituir `captured_at`.

**Validación:** lote no vacío, IDs únicos dentro del lote, formato/tipos, latitud [-90,90], longitud [-180,180], precisión finita positiva, tamaño, autenticación/estado del dispositivo y versión de esquema. Un evento fuera del horario efectivo, con reloj incoherente o con timestamp fuera de retención se marca para rechazo/cuarentena según política aún por aprobar. No se confía ciegamente en la hora del teléfono.

**Atomicidad:** se valida el lote completo antes de escribir. En una transacción se insertan eventos nuevos y una tarea outbox; el acuse sale solo tras COMMIT. Un lote con evento inválido recibe 422 y **no inserta ningún evento**; la respuesta identifica `event_id` problemáticos para que el agente los aísle y reintente los válidos. Si `event_id` ya existe con hash equivalente, se reporta duplicado sin volver a procesarlo. Si existe con contenido diferente, 409 y ningún cambio.

```json
{
  "batch_id": "9a26316d-8e6c-4d98-b8ac-340c679a6e12",
  "persisted_at": "2026-10-16T14:05:12Z",
  "accepted_event_ids": ["b157a767-af6f-4e24-a7a4-62804c4c7b2d"],
  "duplicate_event_ids": [],
  "processing": "pending"
}
```

`200 OK` confirma persistencia, incluso si todos eran duplicados; **no** confirma visita verificada. Se puede usar 201 para inserción nueva solo si se fija y prueba esa semántica antes del cliente. El teléfono marca ACK y elimina de la cola únicamente IDs incluidos en `accepted_event_ids` o `duplicate_event_ids`, después de guardar el acuse localmente.

| HTTP | Significado | Cliente |
| --- | --- | --- |
| 400 | JSON/esquema ilegible | Cuarentena y diagnóstico; no bucle infinito |
| 401 | Sesión ausente/expirada o firma inválida | Renovar sesión si la clave sigue activa; si falla, suspender envío y solicitar reprovisión |
| 409 | Nonce de autenticación repetido | Reintentar con nonce/firma nuevos, mismos IDs de eventos |
| 403 | Dispositivo revocado o ID no coincide | Suspender envío y alertar |
| 409 | Mismo ID con contenido diferente | Cuarentena e investigación |
| 413 | Lote demasiado grande | Dividir lote sin cambiar IDs |
| 422 | Evento inválido (IDs/razones) | Aislar inválidos y reintentar resto |
| 429 | Límite temporal | Respetar `Retry-After` más jitter |
| 5xx / timeout | Resultado incierto | Reintentar mismos IDs con backoff; servidor deduplica |

El servidor define cuotas por dispositivo y límite agregado. Candidato inicial: 6 solicitudes/minuto por dispositivo en operación normal, con carril de recuperación controlado para backlog; la cifra se ajustará con mediciones. Reintentos exponenciales con jitter y tope, preservando eventos. No se garantiza recepción en orden ni respuesta antes del worker.

## Heartbeat, configuración y administración

- `POST /v1/device/heartbeats`: `event_id`, `device_id`, `sent_at`, versión de app, estado de ubicación/red/buffer sin coordenadas. Solo durante jornada salvo autorización expresa. ACK idempotente; muestra comunicación, no demuestra GPS ni causa de una ausencia.
- `GET /v1/device/config`: horario/versiones, zona IANA, excepciones y límites firmados o protegidos por canal autenticado; cache local versionada. La respuesta deberá definir `effective_from` y vigencia para cambios sin red.
- API administrativa: invitación, confirmación y revocación de dispositivos según tabla anterior; horarios y rutas versionados, lectura de historia/alertas con paginación y auditoría. Los demás endpoints se fijarán en la wave correspondiente.
- Adaptador MDM: interfaz interna de inventario/estado y verificación de vínculo, sin prometer endpoint usable por edición Free. La API MSP documenta OAuth y GET /api/v1/mdm/devices; la lectura con lista vacía pasó en Trial, mientras la edición Free y el vínculo con dos teléfonos siguen [BLOCKED](mdm-free-api-validation.md). Nunca se envían tokens MDM al teléfono. [research R03](research.md)

## Compatibilidad y evolución

Cambios incompatibles usan nueva versión del contrato; el servidor acepta una ventana de versiones soportadas durante actualizaciones MDM. Se registran versión del agente, de contrato y de configuración para diagnóstico. Los ejemplos son normativos solo después de revisión y prueba de contratos; hoy expresan un diseño verificable.
