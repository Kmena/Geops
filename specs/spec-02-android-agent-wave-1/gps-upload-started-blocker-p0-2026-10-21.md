# P0 — GPS-UPLOAD-STARTED-BLOCKER: ingesta conjunta de sesión y posiciones

**Actualización de implementación:** el contrato v2 ya existe en la rama aislada
`codex/geops-spec02-mdm-integration` y pasó pruebas sintéticas. El estado
"propuesto/sin código" de los párrafos siguientes identifica el corte de
diseño original; el estado de ejecución y los gates vigentes están en el
[informe de integración](integration-execution-2026-10-21.md). Aún no hay
publicación, prueba POCO ni cierre P0.

**Fecha:** 2026-10-21. **Estado:** diseño v2 propuesto dentro de SPEC-02; sin código ni publicación. **Fuente:** [auditoría original](../../output/auditoria-protocolo-envio-gps-2026-10-21.md), [ADR-016](../architecture/adr/ADR-016-identidad-sesiones-gps.md) y [ADR-020](../architecture/adr/ADR-020-ultima-politica-valida-offline.md). **Prioridad:** P0 antes de las waves A–E de [autonomía GPS](ubicacion-autonoma-offline-propuesta-2026-10-21.md). El informe de auditoría describe el contrato offline v1 anterior a ADR-020; su diagnóstico del bloqueo de subida y la recomendación B son válidos, pero su límite de 12 horas **no** es la decisión vigente.

## Hallazgo y alcance

En `BatchSync.once(LOCATION)` de las ramas `codex/spec-02-wave-1` y `codex/geops-integration`, la búsqueda de **cualquier** `STARTED` pendiente devuelve `WAITING_SESSION` antes de seleccionar posiciones. No compara `client_session_id`. Un `STARTED` antiguo o de otra sesión impide vaciar toda la cola de posiciones. La captura/persistencia local sigue funcionando hasta que la capacidad finita se agote. La FK `position_event.session_id` y el `start_event_id` obligatorio justifican crear la sesión antes de sus posiciones **dentro del COMMIT**, no exigir un ACK HTTP anterior. La autenticación del dispositivo mediante bearer + PoP sigue siendo obligatoria y separada del evento GPS `STARTED`.

**Decisión objetivo B:** un primer lote de **una** sesión local transporta su `STARTED` original y sus primeras posiciones; una transacción backend crea/reconcilia `gps_effective_session`, inserta los eventos/posiciones, sus recibos y auditoría, y responde ACK exacto solo tras COMMIT. Lotes posteriores pueden llevar posiciones solas por `client_session_id` si la sesión ya existe, aunque se haya perdido el ACK anterior. La selección es por sesión; un grupo fallido no detiene grupos de otras sesiones. No se crea sesión a partir de una posición sin `STARTED` ni se simula una hora de inicio.

## Contrato de ingesta v2 **propuesto**

Ruta candidata **`POST /v2/device/gps/batches`**; no existe aún y no sustituye ni altera `POST /v1/device/gps-session-events/batches` ni `POST /v1/device/locations/batches` del OpenAPI v1. Se conserva bearer de dispositivo, firma PoP por método/ruta/cuerpo/token/hora/nonce, instalación activa, binding y tenant actuales, cuotas, aislamiento y límites aprobados. `client_session_id` correlaciona, nunca autentica. El backend deriva identidad y tenant del principal autenticado y comprueba que los IDs declarados coincidan.

El sobre v2 propuesto usa `schema_version:2`, `batch_id`, `device_id`, `installation_id`, un `client_session_id` y `events[]`. Cada elemento lleva `kind: SESSION|POSITION` y el **payload v1 original** de ese evento, con su `event_id`, tiempos, `assignment_version`, `capture_anchor_id`/evidencia temporal vigente y campos propios. El `kind` del sobre no cambia el digest semántico de un evento v1 migrado. Deben ser UUID estables y únicos dentro del lote. Máximo inicial propuesto de 100 eventos/256 KiB, sujeto a medición y aprobación del contrato; no se asume capacidad mayor de la API actual. El `batch_id` identifica el cuerpo exacto: mismo ID con otro cuerpo es conflicto; al cambiar subconjunto, se usa nuevo `batch_id` sin cambiar `event_id` ni payload histórico.

**Una sesión por lote** resuelve el caso de varias sesiones pendientes sin transacción cruzada entre ellas. Un cuerpo que mezcle `client_session_id`, instalación o tenant se rechaza íntegro con `422`; el cliente forma lotes separados y puede avanzar otra sesión. Dentro del lote, el servidor valida primero que exista exactamente un `STARTED` original para una sesión aún desconocida, o una sesión canónica ya vinculada; procesa `STARTED` antes de posiciones y comprueba que cada `captured_at` cae después del inicio y en su ventana. `STOPPED`/`INTERRUPTED`/`RESUMED` mantienen las transiciones de ADR-016; no se reetiquetan posiciones ni se admite un punto durante interrupción. Si falta STARTED y no existe sesión, `202 pending_dependency` no es ACK ni crea posición canónica; se retiene localmente y se diagnostica por esa sesión, sin bloquear otras. Para v2 normal el cliente adjunta STARTED y evita esta ruta.

**Orden entre sesiones:** el servidor serializa por dispositivo/instalación y conserva `UNIQUE(device_id,installation_id,client_session_id)` y máximo una sesión `OPEN/INTERRUPTED`. Si llega tarde un `STARTED` anterior a una sesión posterior ya abierta, puede persistirse como historia `UNKNOWN_END` **solo si** ambas ventanas/posiciones no se solapan y existe evidencia suficiente de orden; `stopped_at` queda nulo, sin fabricar STOPPED. Caso solapado o ambiguo: conflicto/cuarentena del grupo anterior, sin degradar la sesión posterior ni bloquear su subida. Una nueva sesión posterior no retrocede ni reabre la anterior. Esta regla necesita prueba transaccional y revisión de [ADR-016](../architecture/adr/ADR-016-identidad-sesiones-gps.md) antes del esquema v2, sin modificarlo en esta tarea.

### Atomicidad, respuesta y reintentos

| Resultado v2 propuesto | Semántica obligatoria |
| --- | --- |
| `200` | **Un solo COMMIT** de STARTED/sesión/posiciones válidas/recibo/auditoría; respuesta con `batch_id`, `persisted_at`, `accepted_event_ids`, `duplicate_event_ids`, `session_mappings`. Unión de aceptados+duplicados = **exactamente** IDs únicos enviados, sin intersección. Cliente elimina únicamente esos IDs después de validar y persistir localmente el ACK. |
| Reintento mismo `batch_id` y digest | Con identidad actual autorizada, devolver recibo previo y mismo mapa aun si el ACK se perdió; no crear segunda sesión/posición. Una ancla v1 que expiró **después de un COMMIT ya confirmado** no debe invalidar la lectura de ese recibo; identidad revocada sigue bloqueando. |
| `202 pending_dependency` | Sesión desconocida y sin STARTED en lote: cero filas canónicas de sesión/posición y cero ACK terminal; reintento acotado por grupo. Cualquier cuarentena cifrada es auxiliar y no equivale a persistencia de posición. |
| `422` | Contrato, horario, política o evento inválido: rollback **de todo el lote**, lista validada de `invalid_event_ids`/motivo. Cliente aísla los IDs inválidos, conserva los demás y forma nuevo lote con otro `batch_id`; si STARTED inválido, conserva sus posiciones dependientes y no las envía como si fueran huérfanas válidas. |
| `409` | Mismo ID con contenido distinto, `batch_id` reutilizado con otro digest o transición incompatible: ningún ACK ni aceptación parcial. Registrar grupo/IDs conflictivos sin borrar; otros grupos avanzan. |
| `410 dependency_expired` | La dependencia en cuarentena v1 venció: cero ACK terminal y ningún borrado local. Si el `STARTED` original aún está en cola, formar un lote v2 nuevo con él; si falta, dejar el grupo para remediación auditada, sin inventar sesión. No transformar un registro históricamente inválido en válido por reintento. |
| `401/403` | Autenticación/instalación/tenant/revocación de identidad: ninguna escritura canónica, conservar cifrado y bloquear subida hasta corrección autorizada; el MDM no valida la llamada. |
| `413/429/5xx` o timeout | Ningún borrado local; dividir por tamaño cuando sea seguro, backoff/jitter y nonce PoP **nuevo** en cada reintento. Timeout tras COMMIT se resuelve por recibo/deduplicación. |

La comprobación de ACK del cliente también rechaza duplicados en las listas, IDs extraños, `persisted_at` inválido, `batch_id` distinto o `session_mappings` contradictorio. No se acepta ACK parcial implícito. Un lote puede contener eventos ya confirmados por v1 y eventos nuevos: el backend coteja `(device_id,event_id)` y digest del **payload original**, los reporta como duplicados exactos y persiste el resto en el mismo COMMIT. La caída del servidor antes de COMMIT no deja sesión/posición/recibo parciales. La caída después de COMMIT y antes de respuesta devuelve el recibo en retry.

## Compatibilidad con ADR-020 y con v1

P0 quita el bloqueo de **subida**, no cambia cuándo la APK puede capturar. En su primera implementación, v2 puede aceptar eventos que satisfacen la validación temporal v1 existente, incluidos registros históricos de una política anterior dentro de la ventana v1; esto permite cerrar P0 **antes** de Wave A. No se afirma que v2 P0 ya admita jornadas nuevas/boots offline de ADR-020: la Wave A debe versionar la evidencia temporal y de asignación, y la Wave D debe ampliar la ingesta v2 para validarla. Hasta entonces los eventos de esa modalidad permanecen pendientes/cuarentenados, no se borran ni se declaran ACK. El protocolo v2 no puede volver a imponer 12 h como decisión arquitectónica. Una revocación **recibida** detiene captura; la ingesta de puntos capturados bajo una revisión local anterior debe distinguir identidad actualmente revocada, versión conocida y revocación remota todavía no entregada; la aceptación de la exposición diferida sigue gate de ADR-020.

API v2 **aditiva primero**, rutas/recibos v1 intactos para clientes antiguos y rollback. La tabla v1 `gps_event_batch_receipt` limita `kind` a `SESSION|POSITION`; requiere diseño de persistencia de recibo v2 sin reinterpretar su PK/hashes. `gps_effective_session.start_event_id NOT NULL`, FKs de posición/tenant/instalación, `gps_event_quarantine` y unicidad de sesión se preservan. No se asigna número de migración ni se ejecuta SQL aquí. La cola Android v1 conserva `event_id`, payload, orden temporal, ancla, revisión y `client_session_id`; el adaptador v2 la **envuelve** sin reescribirla. No borrar ni migrar destructivamente antes de comparar conteos/IDs y probar reinicio a mitad de envío. Activación por compatibilidad explícita; si backend v2 no está disponible, mantener v1 y los pendientes, sin confundir fallback con P0 resuelto.

## Ramas y dependencias

| Rama auditada | Evidencia actual | Implicación |
| --- | --- | --- |
| `codex/spec-02-wave-1`, HEAD `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf` | `BatchSync.kt` ya contiene compuerta global; API/SQL v1 y `TrackingController` existen; faltan `PendingUpload.kt` y `PendingUploadJobService.kt` del flujo integrado. Commits base visibles `2678513`, `dc38404`. | No corregir solo BatchSync ni declarar E2E de drenaje en esta rama; integrar orquestación y pruebas sin pisar cambios actuales. |
| `codex/geops-integration`, HEAD `90ab9e9f10f6377e739e8bb64da9aef378c59fe2` | Merge Android `5339b81`, origen de redelivery/subida `20ac1c6`; contiene JobScheduler, `PendingUpload`, diagnósticos y APK del POCO señalado, además de cambios Web ajenos no confirmados. | Tomar flujo como referencia, no hacer cherry-pick ciego del merge ni tocar Web; revisar dependencias de API/SQL 0009, 0012 y posteriores, compatibilidad de claves/cola y pruebas antes de integrar. |

**Secuencia de integración futura:** congelar matriz de commits/archivos y estado local de ambos worktrees; revisar diffs por componente; diseñar v2 contra contratos efectivamente presentes; backend aditivo y pruebas sobre DB desechable; Android v2 con feature gate y datos v1; auditoría independiente; POCO; recién después activar Wave A. P0 no autoriza despliegue por el mero hecho de compilar o pasar unitarias.

## Riesgos, pruebas y gate

**Decisiones para cerrar T13 antes de codificar:** aprobar nombre y sobre de la ruta v2, límite 100/256 KiB medido, formato exacto del ACK y `session_mappings`; confirmar el tratamiento transaccional de sesiones históricas fuera de orden frente a la restricción de una OPEN/INTERRUPTED; elegir esquema de recibo v2 y estrategia de negociación/rollback con APK v1. Seguridad y privacidad deben revisar que una posición de política anterior se valide según su autorización original sin aceptar captura posterior a `valid_until`; Wave A/D debe cerrar la evidencia adicional de ADR-020. Ninguna propuesta de este documento cambia por sí sola el contrato publicado.

| Riesgo | Mitigación de diseño | Prueba SPEC-02 |
| --- | --- | --- |
| Pérdida al envolver/migrar cola v1 | IDs/payload intactos, comparación antes/después, ACK exacto, rollback sin borrado. | S02-P19 |
| Sesión duplicada/ACK perdido | Unicidad y digest, recibo transaccional recuperable, retry con nonce nuevo. | S02-P15, P17 |
| Posición válida rechazada por política histórica/offline | Validación por versión y evidencia correspondiente; no traducir v1 a autorización ADR-020 ficticia. | S02-P18, P19 |
| Versión Android/API incompatible | API aditiva, negociación/gate, v1 preservado y rollback medido. | S02-P19 |
| ACK ambiguo o 202 confundido con ACK | Igualdad exacta de sets y COMMIT; 202 nunca libera cola. | S02-P17 |
| Bloqueos/concurrencia o reordenamiento de sesiones | Serialización determinista por dispositivo, transacción corta, historia `UNKNOWN_END` solo demostrable. | S02-P16, P17 |
| Retransmisión concurrente/ID alterado | Digest por evento/lote, recibos idempotentes, 409 atómico. | S02-P17 |
| Registro tardío >7 días o revocación diferida | Mantener cifrado, cuarentena/decisión histórica explícita en Wave D; no borrar. | S02-P18, P19 |

**Salida P0:** ninguna posición válida queda bloqueada por STARTED ajeno; un STARTED + primer punto llega en un lote y COMMIT; cero sesiones/posiciones lógicas duplicadas; ACK solo de filas confirmadas; pendiente v1 intacto ante fallo; captura continúa durante sync; bearer+PoP, política/horario, tenant e instalación se verifican; API v1 funciona; revisión independiente y prueba supervisada en el mismo POCO documentadas. Luego se autoriza **pasar a Wave A** por decisión separada. La matriz detallada de casos está en [test-plan](test-plan.md); el estado de readiness en [wave-readiness](wave-readiness.md).
