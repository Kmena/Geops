# ADR-016 — Identidad canónica e idempotencia de sesiones GPS

**Fecha:** 2026-10-19. **Estado:** aceptado como contrato de diseño para implementación sintética; vínculo transaccional y cliente Kotlin aún por probar. Complementa [ADR-012](ADR-012-identidad-dispositivo.md) y [ADR-003](ADR-003-ingesta-gps.md).

## Decisión

`session_id` es UUID canónico **generado por el backend**. Para operar offline, el agente genera una vez un UUID `client_session_id` provisional, aleatorio, persistido con sus eventos y posiciones. Este último es un identificador de correlación dentro de `(geops_device_id, installation_id)`; jamás autoriza acceso ni sustituye al `session_id`. `installation_id` es UUID del servidor creado atómicamente al activar una instalación GEOPS; `GET /v1/device/config` lo entrega, pero nunca lo crea. Hay como máximo una instalación activa por dispositivo; la rotación ordinaria de clave la conserva y la reinstalación supervisada retira la anterior y crea otra. El backend crea la sesión efectiva y asigna `session_id` solo al aceptar `STARTED` autenticado por PoP, dentro de una ventana programada y revisión vigente **en el instante declarado de inicio**, sujeto a validación de tiempo. Reserva una asociación única `(device_id, installation_id, client_session_id) → session_id` en la misma transacción que evento STARTED. Un reintento idéntico devuelve el mismo `session_id`; mismo ID con otro contenido da 409. `event_id` del agente sigue siendo estable por evento; los IDs de identidad GEOPS de ADR-012 permanecen del servidor.

El agente encola primero evento STARTED y luego posiciones por orden `occurred_at/event_id`. Cada posición lleva `client_session_id`, `event_id`, `assignment_version` y `captured_at`; tras ACK del STARTED puede incluir `session_id` canónico, pero no lo requiere para reintentos antiguos. El backend resuelve la asociación, no confía en un `session_id` presentado. Si llega posición/STOPPED antes de STARTED, guarda el lote entero en cuarentena acotada (sin proyectar sesión efectiva ni vista ejecutiva) y responde `202 pending_dependency` con IDs pendientes; no emite ACK terminal hasta asociación. Si STARTED nunca llega antes de 7 días, la cuarentena expira con código y auditoría; no inventa inicio. Los lotes válidos responden `200` con IDs aceptados/duplicados y mapa `client_session_id → session_id`; un lote inválido responde `422` sin aceptación parcial. El agente aísla eventos inválidos y reintenta IDs restantes.

`STARTED` se genera solo después de promover el FGS visible y de que el proveedor confirme el registro de actualizaciones, **antes de la primera muestra**. Es evidencia **reportada por el agente**, no prueba independiente de movimiento. `START_ATTEMPT` y `MISSED_START` no crean sesión efectiva. `INTERRUPTED` cierra un tramo de captura; `RESUMED` abre otro dentro de la misma sesión si la política sigue vigente; `STOPPED` cierra con `end_reason`. Una nueva política o asignación cierra con `POLICY_REPLACED` y exige nuevo `client_session_id` para la nueva versión. Revocación observada cierra con `POLICY_REVOKED` o `IDENTITY_REVOKED`; si no llega STOPPED por caída/reinicio, se conserva `UNKNOWN_END` y la última observación, sin fabricar `stopped_at`.

| Estado anterior | Evento | Estado posterior | Regla |
| --- | --- | --- | --- |
| Sin efectiva | `START_ATTEMPT`/`MISSED_START` | Sin efectiva | Diagnóstico; no requiere `capture_anchor_id` si se perdió tras reboot, ni crea inicio. |
| Sin efectiva | `STARTED` | `OPEN` | Exige ancla vigente, instancia programada y ausencia de otra efectiva abierta; se crea ID canónico. |
| `OPEN` | `INTERRUPTED` | `INTERRUPTED` | Cierra tramo observado; ninguna posición se valida en la interrupción. |
| `INTERRUPTED` | `RESUMED` | `OPEN` | Exige ventana y autorización todavía vigentes. |
| `OPEN`/`INTERRUPTED` | `STOP_REQUESTED` | Sin cambio | Diagnóstico; no inventa fin. |
| `OPEN`/`INTERRUPTED` | `STOPPED` | `STOPPED` | Fija fin reportado si el orden temporal es coherente. |
| `OPEN`/`INTERRUPTED` | Timeout/reboot sin `STOPPED` | `UNKNOWN_END` | Proyección de incertidumbre; `stopped_at` queda nulo. Un `STOPPED` tardío coherente puede resolverla. |

Una segunda `STARTED` distinta mientras exista otra efectiva abierta da 409; para una nueva ventana después de una pérdida de proceso, primero se registra `UNKNOWN_END` de la anterior sin fabricar tiempo de fin. Un evento tardío nunca retrocede una sesión ya cerrada ni valida posiciones en un tramo interrumpido. `capture_anchor_id` y `anchor_elapsed_realtime_ms` son obligatorios en eventos que abren, cambian o cierran una sesión; en `START_ATTEMPT`/`MISSED_START` pueden faltar y entonces el backend los conserva solo como diagnóstico no verificado, sin usarlos para demostrar horario.

`STOP_REQUESTED` y `STOPPED` pueden registrarse o llegar **después** del fin de ventana, TTL offline o tombstone de política: el backend los acepta como evidencia terminal de una sesión ya vinculada si la identidad actual sigue activa, la ancla corresponde a esa sesión y el orden monotónico es coherente. Nunca autorizan posiciones nuevas fuera de ventana ni crean una sesión. Si la identidad fue revocada, el gate de autenticación mantiene el rechazo y el fin queda `UNKNOWN_END` hasta resolución operativa.

El servidor acepta eventos de sesión solo si la identidad actual puede autenticarse; una identidad revocada no envía backlog. Los eventos locales se conservan cifrados hasta resolución operativa o purga aprobada. Una revocación posterior a una captura no reescribe historia; la ingesta atrasada se evalúa contra autorización en el tiempo de captura y estado actual del dispositivo, conforme a [ADR-017](ADR-017-politicas-gps-temporales-offline.md).

## Invariantes

Una sola sesión efectiva abierta por dispositivo. `UNIQUE(device_id,installation_id,client_session_id)` y unicidad de `(device_id,event_id)` con digest. STARTED duplicado idéntico es idempotente; STARTED distinto para un provisional ya vinculado es conflicto. STOPPED duplicado idéntico devuelve ACK previo; STOPPED tras cierre incompatible es 409. La reconciliación no transforma pausas GPS en hechos.
