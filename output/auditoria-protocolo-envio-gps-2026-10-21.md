# GEOPS — Auditoría del protocolo de envío GPS

**Fecha:** 2026-10-21. **Alcance:** lectura del código Android, API, SQL y pruebas existentes; sin cambios de implementación, migraciones, contratos o despliegue. Se examinó el contrato de la rama de integración `codex/geops-integration` en `90ab9e9f10f6377e739e8bb64da9aef378c59fe2`; la rama de trabajo abierta `codex/spec-02-wave-1` en `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf` aún no contiene todos los componentes de subida (por ejemplo `PendingUpload.kt` y `PendingUploadJobService.kt`), por lo que la auditoría del flujo implementado se basa en la rama de integración. Los documentos de propuesta sin integrar no se toman como comportamiento implementado.

## Dictamen

**Sí: GEOPS puede recibir y confirmar posiciones de un dispositivo autenticado sin que Android espere primero el ACK de `STARTED`.** La forma de menor cambio que conserva la sesión canónica y la integridad referencial es transmitir el `STARTED` local y las primeras posiciones de *esa misma sesión* en un solo lote, y persistirlos en una sola transacción. Las posiciones posteriores pueden enviarse por `client_session_id` aunque Android no haya recibido previamente el mapa `client_session_id → session_id`; el servidor resuelve ese mapa. El ACK de persistencia del lote sigue siendo obligatorio antes de borrar registros locales. La autenticación del dispositivo es un protocolo distinto y permanece obligatoria.

El mensaje observado corresponde a una compuerta del cliente: `BatchSync.once(LOCATION)` busca **cualquier** `STARTED` no confirmado en toda la cola y devuelve `WAITING_SESSION`, sin comparar `client_session_id` ([BatchSync.kt:39–47](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)); la interfaz traduce ese diagnóstico al texto mostrado ([AgentRuntime.kt:341–342](../../Geops-integration/apps/android-app/src/main/kotlin/com/geops/mobile/AgentRuntime.kt)). No significa que la captura espere al servidor: las posiciones ya se almacenan localmente. Sí significa que un inicio antiguo puede detener la *subida* de sesiones posteriores.

## Protocolo vigente reconstruido

```mermaid
sequenceDiagram
    participant F as GPS/FGS Android
    participant Q as Cola cifrada Android
    participant U as Job de subida
    participant A as API autenticación
    participant G as API GPS
    participant D as PostgreSQL
    F->>A: challenge + firma para bearer del dispositivo
    A-->>F: bearer temporal
    F->>G: GET /v1/device/config + bearer/PoP
    G-->>F: política, ancla y ventana vigente
    F->>Q: STARTED(client_session_id, event_id) tras registrar listener
    F->>Q: POSITION(event_id, client_session_id, ancla, versión)
    Note over F,Q: Captura y persistencia sin ACK de STARTED
    U->>A: challenge + firma para bearer si falta/caduca
    A-->>U: bearer temporal
    U->>G: POST /v1/device/gps-session-events/batches + bearer/PoP
    G->>D: validar identidad, política, horario; crear sesión canónica y recibo
    D-->>G: COMMIT
    G-->>U: 200 ACK + session_mappings
    U->>Q: borrar STARTED solo si ACK exacto
    Note over U,Q: Cualquier STARTED pendiente bloquea todas las POSITION
    U->>G: POST /v1/device/locations/batches + bearer/PoP
    G->>D: resolver client_session_id, validar e insertar posiciones y recibo
    D-->>G: COMMIT
    G-->>U: 200 ACK de IDs aceptados/duplicados
    U->>Q: borrar solo IDs del lote exactamente confirmado
    Note over G,D: Si no existe sesión, 202 y cuarentena; no hay ACK terminal
```

1. **Origen de `STARTED`.** Tras registrar el servicio visible y el listener, Android genera `client_session_id` UUID, crea `LocalSession` y añade `STARTED` a la cola cifrada ([TrackingController.kt:84–110](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/TrackingController.kt)); el evento contiene `event_id`, ventana programada, versión, ancla, `boot_id` y tiempo monotónico ([TrackingController.kt:282–292](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/TrackingController.kt)). Los diagnósticos `START_ATTEMPT`/`MISSED_START` no crean sesión efectiva.
2. **Captura.** El callback exige política/instancia local válida, sesión local `RUNNING`, listener activo, hora dentro de ventana, fijación válida e intervalo; crea un UUID por ubicación y la escribe en la cola antes de notificar subida ([TrackingController.kt:130–179](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/TrackingController.kt)). No consulta el ACK de `STARTED`.
3. **Persistencia y ejecución de la cola.** `EncryptedFileAgentStore` usa AES-GCM y escritura con sincronización/renombre, con límites de 10 000 registros y 4 MB ([AgentStore.kt:99–139](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/AgentStore.kt)). El trabajo de subida requiere red, no usa el proveedor de ubicación y puede ejecutarse fuera de horario; hay barrido periódico de 15 minutos ([PendingUploadJobService.kt:27–83](../../Geops-integration/apps/android-app/src/main/kotlin/com/geops/mobile/PendingUploadJobService.kt), [PendingUploadJobService.kt:98–122](../../Geops-integration/apps/android-app/src/main/kotlin/com/geops/mobile/PendingUploadJobService.kt)). Espera inicialmente `syncIntervalS`, procesa hasta 12 lotes por ejecución y prioriza `SESSION`, luego `LOCATION` ([PendingUpload.kt:14–49](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/PendingUpload.kt)). Los lotes v1 admiten hasta 100 eventos, 128 KiB de sesiones o 256 KiB de posiciones ([BatchSync.kt:48–74](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)).
4. **Autenticación, separada de GPS.** Si falta bearer, `RefreshingSessionProvider` solicita challenge y firma la apertura de una sesión de *autenticación del dispositivo* mediante dos POST; este token vive en memoria del proveedor ([EnrollmentClient.kt:174–205](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/EnrollmentClient.kt)). Cada llamada GPS envía bearer y PoP que firma método, ruta, hash del cuerpo, hash del token, tiempo y nonce. El backend comprueba token vigente, clave/dispositivo activos, firma y nonce único ([session.ts:133–207](../../Geops-integration/apps/api/src/device-identity/session.ts)). Por tanto, en arranque frío actual pueden existir **dos intercambios de autenticación además de los dos POST GPS**; el cambio propuesto reduce los POST GPS iniciales a uno, pero no elimina la autenticación.
5. **Contratos de red v1.** Hay rutas separadas `POST /v1/device/gps-session-events/batches` y `POST /v1/device/locations/batches`; ambas verifican PoP antes del parseo e ingesta ([gps-event-routes.ts:26–71](../../Geops-integration/apps/api/src/gps-event-routes.ts)). El cuerpo contiene `schema_version:1`, `batch_id`, `device_id`, `installation_id`, `events`; una posición exige `client_session_id` y acepta `session_id` opcional ([gps-event-contracts.ts:5–55](../../Geops-integration/apps/api/src/gps-event-contracts.ts), [gps-event-contracts.ts:219–239](../../Geops-integration/apps/api/src/gps-event-contracts.ts)). `200` trae `batch_id`, `persisted_at`, IDs aceptados/duplicados y mapa de sesiones. `202` es dependencia pendiente, no confirmación de persistencia final.
6. **Validación y transacción.** La API comprueba dispositivo activo, una vinculación GEOPS activa e instalación de la misma organización ([gps-event-service.ts:107–130](../../Geops-integration/apps/api/src/gps-event-service.ts)); ancla emitida para dispositivo, instalación, versión y vínculo correctos; `boot_id`, reloj monotónico y vencimiento offline ([gps-event-service.ts:133–184](../../Geops-integration/apps/api/src/gps-event-service.ts)); y versión/horario/política históricos para cada ubicación ([gps-event-service.ts:192–210](../../Geops-integration/apps/api/src/gps-event-service.ts), [gps-event-service.ts:717–770](../../Geops-integration/apps/api/src/gps-event-service.ts)). No se observa una llamada de red a MDM en este flujo: `mdm_binding` es una relación propia en base de datos. El servidor crea `session_id` al procesar `STARTED` ([gps-event-service.ts:541–603](../../Geops-integration/apps/api/src/gps-event-service.ts)); busca la sesión por `(device_id, installation_id, client_session_id)` ([gps-event-service.ts:212–228](../../Geops-integration/apps/api/src/gps-event-service.ts)). Evento, proyección, recibo y auditoría se confirman juntos antes del `200` ([gps-event-service.ts:314–495](../../Geops-integration/apps/api/src/gps-event-service.ts)).
7. **Confirmación e idempotencia.** El Android solo borra el lote si el ACK incluye el `batch_id`, `persisted_at` parseable y exactamente todos los IDs enviados una vez entre aceptados/duplicados ([BatchSync.kt:87–118](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)). `batch_id` se deriva de tipo y secuencia de `event_id` ([BatchSync.kt:169–177](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)). El servidor conserva recibos por `(device_id, kind, batch_id)` y digests por `(device_id,event_id)`; mismo contenido se trata como duplicado, contenido distinto como conflicto ([gps-event-service.ts:368–384](../../Geops-integration/apps/api/src/gps-event-service.ts), [gps-event-service.ts:717–731](../../Geops-integration/apps/api/src/gps-event-service.ts)). Un retry debe usar **un nonce PoP nuevo**; repetir literalmente la solicitud firmada sería detectado como replay.

## Justificación del handshake y límites reales

El motivo documentado en [ADR-016:5–11](../../Geops-integration/specs/architecture/adr/ADR-016-identidad-sesiones-gps.md) es válido: `STARTED` es evidencia reportada después de iniciar el FGS; solo entonces el servidor crea una sesión efectiva canónica, enlaza `client_session_id`, aplica política/horario y preserva trazabilidad. La base de datos exige `position_event.session_id NOT NULL` y FK a `gps_effective_session`; la sesión requiere `start_event_id NOT NULL`, vinculación a ventana, unicidad del ID local y a lo sumo una sesión abierta por dispositivo ([0009_gps_policies.sql:195–280](../../Geops-integration/apps/api/src/db/migrations/0009_gps_policies.sql)). Las FKs de organización/vinculación y el recibo se añadieron en [0012_gps_events.sql:15–66](../../Geops-integration/apps/api/src/db/migrations/0012_gps_events.sql).

**Esto justifica el orden de persistencia dentro de una transacción, no un ACK de red previo.** El código ya procesa `STARTED` antes de otros eventos de sesión dentro del mismo lote ([gps-event-service.ts:385–420](../../Geops-integration/apps/api/src/gps-event-service.ts)). La separación rígida SESSION/POSITION impide aplicar el mismo principio a una primera posición. La compuerta global de Android es una decisión adicional para evitar `202`; no es una FK ni un requisito de autenticación.

Si la API recibe posiciones antes de conocer el `client_session_id`, pone **todo el lote** en cuarentena y devuelve `202`, sin proyectar posiciones ni emitir ACK terminal; Android conserva y reintenta 30 segundos después ([gps-event-service.ts:392–406](../../Geops-integration/apps/api/src/gps-event-service.ts), [BatchSync.kt:120–124](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)). La cuarentena vence a los siete días y está acotada a 1000 eventos activos por dispositivo ([gps-event-service.ts:20–21](../../Geops-integration/apps/api/src/gps-event-service.ts), [gps-event-service.ts:230–298](../../Geops-integration/apps/api/src/gps-event-service.ts)). La llegada posterior de `STARTED` no da por sí sola ACK a esos lotes: el agente los reenvía; la prueba integrada muestra esa secuencia ([gps-events.integration.mjs:129–163](../../Geops-integration/apps/api/test/gps-events.integration.mjs)).

**Pérdida del ACK de `STARTED`.** Si la base de datos confirmó pero la respuesta se perdió, el cliente mantiene `STARTED` y bloquea todas las posiciones. Un reintento con mismo lote devuelve su recibo o un `duplicate_event_id` con la asociación, siempre que identidad/ancla/retención sigan admitidas. No duplica sesión. Pero hasta que llegue ese ACK, tampoco sube posiciones de otras sesiones. Si el evento queda rechazado o la comunicación del ACK falla de forma persistente, existe bloqueo de cabecera y posible inanición. El `409` pone en cuarentena local *todo* el lote seleccionado; después las posiciones huérfanas recibirán `202` y podrán agotar los siete días ([BatchSync.kt:130–145](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)). Un `STARTED` antiguo transmitido después de uno nuevo también puede chocar con `session_order_conflict` ([gps-event-service.ts:562–580](../../Geops-integration/apps/api/src/gps-event-service.ts)).

Cuando una cuarentena de servidor vence, el reenvío obtiene `410`; el `BatchSync` actual no tiene un caso específico para `410` y entra en el reintento genérico ([BatchSync.kt:148–159](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/BatchSync.kt)). Conserva el registro local, pero no lo resuelve por sí mismo. También se valida el alcance/ancla/edad antes de consultar un recibo de lote anterior ([gps-event-service.ts:325–384](../../Geops-integration/apps/api/src/gps-event-service.ts)); una revocación, cambio de instalación o expiración posterior puede impedir recuperar un ACK ya persistido. Este es un límite de recuperación del contrato actual, no una razón para borrar la cola.

**Ciclo y reinicio.** No hay ciclo lógico donde el servidor espere una posición para aceptar `STARTED`: es un orden unilateral. Sí hay acoplamiento de progreso entre sesiones por la compuerta global y entre un `202` y el reintento del cliente. Android conserva la cola al reiniciar y marca un fin no observado como `UNKNOWN_END` ([TrackingController.kt:236–249](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/TrackingController.kt)). El servidor conserva las sesiones/recibos frente a su propio reinicio. El límite de 10 000 registros/4 MB significa que un bloqueo prolongado puede terminar en `BUFFER_UNAVAILABLE` y detener la captura, pese a no perder los elementos ya persistidos; no se puede prometer captura ilimitada sin una política explícita de capacidad ([AgentStore.kt:116–139](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/AgentStore.kt), [AgentRuntime.kt:128–146](../../Geops-integration/apps/android-app/src/main/kotlin/com/geops/mobile/AgentRuntime.kt)).

## Comparación de alternativas

| Criterio | A. V1 con ACK previo de `STARTED` | B. `STARTED` + primeras posiciones en un lote atómico | C. Posiciones directas y sesión creada/reconciliada al ingerir |
| --- | --- | --- | --- |
| Red GPS inicial | 2 POST secuenciales como mínimo; + reintentos | 1 POST; posteriores pueden ser solo posiciones | 1 POST sin evento de inicio |
| Cliente y offline | Compuerta global, dos clases de lote y dos ACK; cola persiste | Agrupar por sesión, un ACK para el primer lote; cola persiste | Cliente simple en apariencia; exige semántica nueva para sesiones/pausas |
| FK/trazabilidad | FKs y `STARTED` reales del agente | Las mismas FKs y evidencia; `STARTED` se inserta antes de posiciones en el mismo COMMIT | Hay que derivar o crear inicio sintético; se pierde la hora real del FGS si solo llega la primera posición |
| Autenticación y aislamiento | Bearer+PoP, instalación, vínculo/tenant | Idénticos controles por petición | Debe conservar idénticos controles; `client_session_id` nunca autentica |
| Política y horario | Ancla, versión, ventana, tiempo de cada evento | Idénticas validaciones, dentro de la misma transacción | Requiere resolver ventana de cada punto y comienzo/fin sin `STARTED`; más casos ambiguos |
| Idempotencia/ACK | Recibo por lote + PK/digest por evento | Igual, con nuevo tipo de lote y ACK exacto después de COMMIT | Igual, más creación concurrente idempotente de sesión implícita |
| ACK perdido/reinicio | Reintento seguro pero bloqueo global hasta ACK | Reintento del lote atómico devuelve mismo resultado; sin compuerta global | Reintento seguro si la reconciliación de sesión implícita es transaccional |
| Fuera de orden/múltiples sesiones | `202` y posible inanición | Lotes por sesión y orden causal dentro de cada lote; sesiones ajenas avanzan | Resolver fronteras temporales e interrupciones fuera de orden es más complejo |
| Datos pendientes/versiones | Sin migración, pero conserva bloqueo | API aditiva; v1 sigue vivo; agrupar IDs locales intactos | Migración de evidencia histórica y esquema más invasiva |

**Recomendación: B**, con eliminación de la compuerta global. Una primera operación por sesión transporta el `STARTED` ya guardado junto con posiciones de esa sesión; el servidor crea o encuentra la sesión y acepta las posiciones en una transacción. Para una sesión ya conocida, acepta posiciones solas por `client_session_id`, aunque el ACK anterior se haya perdido. La opción C es técnicamente posible para una ubicación de un dispositivo autenticado, pero con el esquema y las garantías actuales exigiría inventar o declarar como inferido el inicio, cambiar `start_event_id NOT NULL`/transiciones y resolver ventanas y sesiones tardías. No ofrece una simplificación neta del sistema.

## Contrato API propuesto — diseño, no implementación

`POST /v2/device/gps/batches`, protegido exactamente como v1 con bearer corto, PoP del cuerpo y control actual de dispositivo/instalación/vínculo/organización. Cuerpo versionado y acotado, con un único `client_session_id` por lote y eventos tipados; ejemplo:

```json
{
  "schema_version": 2,
  "batch_id": "UUID-estable-para-este-cuerpo",
  "device_id": "UUID",
  "installation_id": "UUID",
  "client_session_id": "UUID",
  "events": [
    { "kind": "SESSION", "type": "STARTED", "event_id": "UUID", "scheduled_session_id": "UUID", "occurred_at": "UTC", "assignment_version": 12, "capture_anchor_id": "UUID", "boot_id": "UUID", "anchor_elapsed_realtime_ms": 1000, "elapsed_realtime_ms": 1200 },
    { "kind": "POSITION", "event_id": "UUID", "captured_at": "UTC", "assignment_version": 12, "capture_anchor_id": "UUID", "boot_id": "UUID", "anchor_elapsed_realtime_ms": 1000, "elapsed_realtime_ms": 5000, "latitude": 14.6, "longitude": -90.5, "accuracy_m": 8.5 }
  ]
}
```

Los valores ilustrativos no son un contrato v1 válido. En v2, la identidad de cada evento y su payload histórico deben conservarse exactamente; un envoltorio `kind` puede añadirse sin alterar el digest semántico almacenado para registros v1. El servidor exige un `STARTED` del mismo `client_session_id` si todavía no existe sesión efectiva; si ya existe, el evento puede omitirse. Ordena causalmente dentro de esa sesión, valida cada evento como hoy y hace una sola transacción de `STARTED`, sesiones/posiciones, eliminación de cuarentenas, recibo y auditoría. Un lote no debe mezclar sesiones ni organizaciones. Límites iniciales propuestos: 100 eventos y 256 KiB de cuerpo, con medición antes de fijarlos.

`200` solo después de COMMIT: `{batch_id,persisted_at,accepted_event_ids,duplicate_event_ids,session_mappings,processing:"complete"}`. `accepted ∪ duplicate` debe ser exactamente el conjunto enviado, sin intersección ni repetidos; el cliente borra esos IDs solo tras verificarlo y persistir localmente el cambio. Un retry del mismo `batch_id` y cuerpo devuelve el recibo; mismo ID/cuerpo distinto: `409`. Si el lote es válido pero carece de `STARTED` y el servidor no conoce la sesión, `202 pending_dependency` sin ACK terminal puede mantenerse como compatibilidad, con reintento e inclusión posterior del `STARTED`; no debe ser la ruta normal de v2. Rechazos `401/403` retienen el buffer, `422` aísla IDs inválidos sin confirmar los demás, `429/5xx` aplican backoff. Ningún `202` libera un registro.

La autenticación existente todavía puede necesitar challenge y apertura de bearer antes de este POST. Reducir también esos intercambios requeriría una revisión separada de seguridad de la identidad del dispositivo; no es consecuencia de eliminar el handshake GPS.

## Impacto y migración compatible

1. **Base de datos/API:** añadir tipo de recibo v2 o tabla equivalente sin reinterpretar `(device_id,kind,batch_id)` v1; transacción mixta por sesión con bloqueo/concurrencia deterministas. Conservar PK de eventos, digest, FKs, unicidad de sesión, una sesión abierta, tenant/vínculo, ancla y retención. Garantizar que un `STARTED` ya confirmado en v1 y con ACK perdido se reconozca como duplicado y proporcione el mismo `session_id`; que posiciones en cuarentena v1 se reconcilien por `event_id` sin segunda fila. Una nueva API v2 no debe convertir un `202` antiguo en ACK por mera existencia de cuarentena. Para sesiones que lleguen **fuera de orden entre sí**, definir una proyección histórica: un inicio anterior a la sesión abierta más reciente puede persistirse como `UNKNOWN_END` con evidencia de fin desconocido, sin convertirse en otra sesión abierta; sus posiciones deben quedar acotadas por su ventana y por el inicio posterior. Esto requiere pruebas de transiciones tardías y no puede resolverse solo cambiando el cliente.
2. **Android:** mantener el formato de estado cifrado y los UUID/eventos pendientes; sustituir selección global por grupos de `client_session_id`, incluir `STARTED` original en primer lote si sigue pendiente y permitir posiciones de otras sesiones. Guardar de forma duradera el resultado exacto del ACK; no necesitar `session_id` canónico para capturar ni para enviar un punto con `client_session_id`. Ordenar `STARTED`/interrupciones/reanudaciones/paradas y posiciones causalmente; un grupo inválido no detiene otros. Cambiar el texto de estado para mostrar causa real y número de pendientes.
3. **Despliegue:** desplegar y verificar API aditiva antes de habilitar APK v2; mantener rutas v1 para APK antiguas y rollback. Activar por capacidad/versionado explícito, no por suposición. Migrar la cola perezosamente sin sobrescribir payload, ancla, política, hora, `event_id` ni `installation_id` históricos. Si la nueva ruta no está disponible, conservar la cola y usar v1 solo con semántica v1 conocida. Ejecutar canary con ACK perdido y múltiples sesiones antes de retirar la compuerta de todos los clientes. No borrar ni purgar pendientes como parte de la migración.
4. **Capacidad/retención:** medir duración de vaciado de 10 000 registros con 100 por lote, cuota de 6 solicitudes/minuto por tipo y trabajo de 12 lotes por ejecución ([gps-event-service.ts:94–104](../../Geops-integration/apps/api/src/gps-event-service.ts), [PendingUpload.kt:14–49](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/PendingUpload.kt)). Definir margen de capacidad y alerta antes de alcanzar 4 MB/10 000; “no perder pendientes” requiere conservar cifrado y una salida operativa para rechazos terminales. La API solo admite eventos de hasta 90 días ([gps-event-service.ts:20](../../Geops-integration/apps/api/src/gps-event-service.ts), [gps-event-service.ts:186–190](../../Geops-integration/apps/api/src/gps-event-service.ts)).

## Política offline y límites de autorización

La primera captura exige una configuración autenticada para la instancia actual; recuperación tras un fallo de red puede usar la **misma instancia ya validada** ([AgentRuntime.kt:157–164](../../Geops-integration/apps/android-app/src/main/kotlin/com/geops/mobile/AgentRuntime.kt), [PolicyEngine.kt:37–72](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/PolicyEngine.kt)). La evaluación local mantiene el último contrato válido para esa instancia, pero la captura termina al vencer ventana, política, ancla o máximo de 12 horas y no puede comenzar ventanas de días posteriores sin nueva validación en línea ([PolicyEngine.kt:107–138](../../Geops-integration/apps/android-agent/src/main/kotlin/com/geops/agent/PolicyEngine.kt), [ADR-017](../../Geops-integration/specs/architecture/adr/ADR-017-politicas-gps-temporales-offline.md)). La subida del backlog sí puede ocurrir días después, siempre que identidad actual siga activa y los eventos históricos superen retención y validación de su propia ancla/horario. La prueba integrada acepta una ubicación históricamente autorizada después de reemplazar política ([gps-events.integration.mjs:315–332](../../Geops-integration/apps/api/test/gps-events.integration.mjs)). Una revocación conocida detiene nueva captura; una identidad revocada impide subir backlog hasta resolución autorizada. No se debe convertir “offline varios días” en permiso para capturar varios días sin autorización fresca.

## Pruebas de regresión propuestas

Todas deben verificar filas y ACK exactos, cola cifrada restante y aislamiento por dispositivo/organización; ejecutar con API v1 y v2 cuando corresponda.

| # | Escenario y resultado exigido |
| --- | --- |
| 1 | Primer lote v2 contiene `STARTED` + punto, sin ACK anterior: 200, una sesión, un punto, ambos IDs confirmados. |
| 2 | COMMIT de `STARTED`/primer lote seguido de ACK perdido: retry con mismo cuerpo y PoP nuevo devuelve mismo mapeo; una sola sesión/punto; otra sesión no se bloquea. |
| 3 | Retransmitir lote idéntico, concurrentemente y con `batch_id` nuevo: duplicados exactos sin segunda posición; mismo ID alterado da 409. |
| 4 | `client_session_id` desconocido: con `STARTED` válido se crea dentro del lote; sin él se responde 202 sin borrar ni proyectar. |
| 5 | Reinicio servidor después de COMMIT y antes de respuesta: recibo persistente y retry exacto. |
| 6 | Dispositivo offline varios días: solo captura durante instancia previamente validada hasta su límite; backlog histórico sube dentro de retención al volver red/autorización. |
| 7 | Múltiples sesiones acumuladas: un lote inválido/pendiente no impide procesar otra sesión; FK y una sesión abierta coherentes. |
| 8 | Sesiones fuera de orden: preservar orden causal; inicio antiguo tardío no reabre ni retrocede sesión posterior; rechazo aislado y sin pérdida local. |
| 9 | Contrato local anterior durante desconexión: aceptar eventos del intervalo históricamente autorizado tras nueva revisión, sin reescribir versión/ancla. |
| 10 | Revocación recibida posteriormente: detener nueva captura; eventos anteriores solo se aceptan conforme a estado actual de identidad y autorización histórica; pendientes rechazados siguen cifrados. |
| 11 | Ubicación fuera de ventana, después de TTL o durante `INTERRUPTED`: 422 sin fila/ACK de persistencia. |
| 12 | Dispositivo desconocido, clave inválida, instalación retirada o tenant distinto: 401/403; cero filas de sesión/posición. |
| 13 | ACK de ubicaciones perdido o malformado: cola intacta; retry con nonce nuevo da 200 exacto y una fila por `event_id`. |
| 14 | Miles de registros (incluido un `STARTED` antiguo fallido): vaciado por lotes hasta límite de cuota, sin inanición de otras sesiones ni desbordamiento silencioso; alertar antes del tope. |

La suite actual confirma el comportamiento v1 de 202 antes de `STARTED`, duplicados y rollback atómico ([gps-events.integration.mjs:129–171](../../Geops-integration/apps/api/test/gps-events.integration.mjs), [gps-events.integration.mjs:248–268](../../Geops-integration/apps/api/test/gps-events.integration.mjs)); la prueba Android actual **codifica expresamente la espera** que debe reemplazarse ([SyntheticTests.kt:522–546](../../Geops-integration/apps/android-agent/src/test/kotlin/com/geops/agent/SyntheticTests.kt)). Estas pruebas se inspeccionaron, no se ejecutaron durante la auditoría.

## Waves sugeridas, sujetas a autorización

1. **Contrato y pruebas:** fijar semántica v2, ACK, orden causal, límites, errores y compatibilidad; crear fixtures de los 14 casos.
2. **Servidor/DB aditivos:** transacción mixta, recibo v2, reconciliación con filas/cola de cuarentena v1 y controles de identidad/política existentes; verificar concurrencia y rollback.
3. **Android:** selección por sesión, transporte v2, ACK exacto, recuperación de estado v1 y diagnóstico; mantener captura local independiente.
4. **Canary y migración:** activar por capacidad en pocos dispositivos, medir latencia, pendientes, 202, 409/422, duplicados y límite del buffer; ampliar gradualmente con rollback a v1 sin pérdida de registros.

**Estado de esta auditoría:** propuesta únicamente. No se modificó código, base de datos, API ni APK. Esperar autorización para implementar.
