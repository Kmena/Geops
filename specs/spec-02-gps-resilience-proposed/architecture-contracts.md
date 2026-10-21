# Arquitectura, datos y coordinación de contratos — propuesta

## Fronteras y estado real

En HEAD, `AgentRuntime` tiene scheduler, captura y sync en el mismo proceso; `GeopsLocationService` se detiene al desregistrar; `TrackingController` autoriza con instancias UTC y ancla de `PolicyEngine`; `BatchSync` conserva idempotencia. El backend obtiene salud con `GET /v1/admin/devices/{id}/health` y calcula silencio **a demanda**. `GET /v1/admin/gps-alerts` aparece en el OpenAPI de diseño, pero no hay ruta registrada equivalente en `apps/api/src`; es una propuesta, no un endpoint operativo.

El checkout principal contiene trabajo Android sin confirmar: razones de política, decisiones de callback y contadores; también trabajo Web y OpenAPI sin confirmar. No se fusiona por copiar archivos. La fase de implementación empezaría con un diff de tres bases: SHA publicado, checkout local y SPEC aprobado. La auditoría local no equivale a HEAD.

## GPS-OFFLINE-001: autorización conocida y eventos históricos

**Decisión de negocio APPROVED bajo ADR-017.** El teléfono desconectado usa exclusivamente el último snapshot autenticado, de la misma identidad/instalación, cuya política y asignación siguen vigentes **según la información local**, y solo durante la instancia que ya estaba vigente al contacto online. Cada lectura exige `captured_at` dentro de esa instancia UTC `[inicio,fin)`, antes de `offline_not_after`, ancla y boot válidos, permiso/FGS/sesión efectiva. Una instancia futura incluida en el snapshot **no** queda preactivada offline: ADR-017 exige nuevo contacto online antes de iniciarla. El snapshot no se prorroga ni se sustituye por uno anterior tras observar una revisión más nueva. Al recibir una política válida nueva, se cierra la generación/listener viejo antes de aplicar sus ventanas, incluso cuando eso reduce el horario. La falta de conectividad impide conocer inmediatamente una reducción remota durante la instancia actual; este riesgo acotado es aceptado.

**Trazabilidad actual y delta propuesto:** `Snapshot` incluye `policy_revision` y `assignment_version`; los eventos de sesión/posición llevan `assignment_version`, `capture_anchor_id`, ID de sesión y `captured_at`. La revisión de política puede reconstruirse mediante la entrega/ancla y la sesión programada, pero **la posición no lleva un campo directo `policy_revision`**. Antes de afirmar trazabilidad durable por captura hay que probar la integridad y retención de esas relaciones. Añadir un campo al lote actual rompería el parser estricto; proponer una versión nueva solo si la relación actual es insuficiente, con revisión API/Kotlin/Seguridad.

**Brecha del cliente en R0:** la API puede entregar instancias futuras con un `offline_not_after` que llega al fin de la primera de ellas (`gps-device-config.ts:89–109`). `PolicyEngine.current()` en HEAD solo comprueba que `now` cae en alguna instancia y antes del límite; no exige que esa instancia estuviera vigente al último contacto online. Así puede preactivar una ventana futura offline, en contradicción con ADR-017. Debe fallar cerrado sin acortar el derecho a continuar durante la instancia actual. No se corrige código en R0.

**Aceptación histórica backend por verificar:** `rebuildDevice` cancela sesiones anteriores cuyo `start_at >= cambio`; una instancia **ya iniciada** tiene `start_at < cambio` y no entra en esa cancelación. `scheduled()` permite estado `SCHEDULED`/`MISSED` y versión histórica exacta; `anchorTime()` verifica `offline_not_after`. Esto sugiere que posiciones de la instancia actual capturadas bajo la revisión anterior podrían aceptarse al reconectar, sujeto a sesión/PoP/identidad vigentes. La suite existente no reproduce todavía la reducción concurrente y no se declara PASS. El caso de ventana futura cancelada es un rechazo esperado bajo ADR-017, pues no debía activarse offline. **No se modifica aquí la aceptación backend.**

Si la reproducción de la instancia actual revela rechazo de eventos legítimos, proponer un ajuste mínimo con evidencia histórica inmutable de entrega, ventana y TTL; validar PoP, tenant, identidad y revocación. Solo entonces revisar regla/migración con Seguridad y API y delta SDD. No aceptar genéricamente sesiones `CANCELLED`, pues podría autorizar una instancia futura no validada online. Si el flujo actual ya acepta correctamente, conservarlo y añadir regresión; no cambiar backend por prevención especulativa.

## Separación de procesos

```text
Snapshot PoP + ventanas UTC ──► Validador de captura ──► FGS location ──► buffer cifrado
             │                         │                        │
             │                         └─► diagnóstico sin coordenadas
             │
             └─► revocación/versiones

buffer cifrado ──► trabajador de subida independiente ──► PoP/ACK API
                      (nunca abre GPS)

salud/posiciones recibidas ──► evaluador backend por ventana ──► alerta inferida
```

Separar **intención autorizada**, estado real de FGS, listener registrado, callback entregado, fix válido, evento persistido, evento confirmado y posición recibida. Ningún reloj de WorkManager/AlarmManager sustituye la autorización UTC. El evaluador backend jamás pide iniciar captura; solo evidencia falta de comunicación/captura y ofrece acción humana. La sincronización posterior al turno usa credenciales vigentes y conserva timestamps; revocación bloquea ingesta normal y mantiene cola para manejo supervisado.

## Datos mínimos propuestos

| Dato | Fuente y propósito | Privacidad/retención propuesta |
| --- | --- | --- |
| `last_callback_at`, `last_valid_fix_at`, `last_persisted_capture_at`, `last_ack_at` | Android; distinguir GPS sin fixes, rechazos, cola y red. | Solo metadatos UTC; diagnóstico local cifrado y acotado; período por aprobar. |
| `reject_reason`, `count`, `scope_start/end` | Android; C07/C08. Códigos cerrados, sin coordenadas ni payload. | Agregado por ventana/revisión; no registrar una línea por fix en servidor. |
| `observed_at`, `received_at`, `source`, `state`, `age_s` | API; observado frente a inferido. | Mantener política de retención de GPS-HEALTH-001; extensión requiere revisión. |
| `alert_id`, `device_id`, `window_id`, `kind`, `opened_at`, `resolved_at`, `source`, `threshold_s` | API; deduplicación y auditoría. | Tenant/capacidad obligatorios; no incluir coordenadas ni nombres personales en notificaciones. |

No persistir timestamp detallado de lecturas fuera de horario como trayectoria encubierta. Un callback tardío se descarta; un contador agregado es suficiente. Se acepta provisionalmente enviar **diagnóstico técnico** fuera de jornada: estado de cola, red, servicio y última comunicación, sin invocar ubicación ni generar un fix. Campos, frecuencia, acceso y retención corta siguen condicionados a Seguridad/Privacidad. La subida de **posiciones previas** está permitida independientemente de esa decisión.

## Propuesta de contrato versionado, aún no aprobada

`GPS-CONTINUITY-001` se propone como **endpoint nuevo** para evitar romper el parser estricto de `GPS-HEALTH-001` (`parseHealthBatch` rechaza claves desconocidas y exige `schema_version: 1`). No añadir campos sin acuerdo al lote actual. Mantener `/v1/device/config`, sesiones, posiciones y salud existentes con semántica intacta.

| Ruta propuesta | Esquema/respuesta | Seguridad y compatibilidad |
| --- | --- | --- |
| `POST /v1/device/continuity/batches` | `schema_version: 1`, lote acotado, `batch_id`, eventos con ID, `kind` cerrado (`CAPTURE_STALE`, `BUFFER_FULL`, `FGS_STOPPED`, `WINDOW_ENDED`, `SYNC_BACKLOG`, `RECOVERED`), `observed_at`, `window_id`/revisión opcionales, contadores agregados. ACK solo tras COMMIT. | Sesión dispositivo + PoP por petición, nonce, binding activo, tenant derivado del servidor, idempotencia/replay/quotas. Fuera de ventana solo `SYNC_BACKLOG`/estado técnico de cola, red o servicio, nunca fix ni posición nueva. La allowlist exacta y retención se aprueban antes de codificar. Cliente antiguo no lo llama. |
| `GET /v1/admin/devices/{id}/continuity` | `schema_version: 1`, últimas marcas temporales y estado con `source` y `age_s`; `null` = desconocido. | Cookie admin, capacidad propuesta `gps.session.read`, concesión tenant, `X-GEOPS-Access-Reason` y lectura auditada para resumen sin ubicación. Diagnóstico profundo podría exigir `gps.audit.read`; Seguridad decide. Frontend antiguo ignora la ruta. |
| `GET /v1/admin/gps-alerts` | Completar ruta ya dibujada en OpenAPI de diseño, con cursor, estado y fuente. | Capacidad/tenant/motivo/auditoría por acordar; no asumir implementada. Alerta server-side independiente de vista Web. |

Antes de fijar campos: contrato OpenAPI, migración separada, paridad Kotlin/Node, límites de lote, retención, cuotas y vectores de compatibilidad `cliente viejo→servidor nuevo` y `cliente nuevo→servidor viejo`. En un despliegue gradual, el cliente nuevo debe detectar ausencia de endpoint y degradar a diagnóstico local sin afectar captura ni PoP. No debe reinterpretar 401/403 como falta de soporte. No se versionará `GPS-HEALTH-001` por simple adición: su parser actual la rechazaría.

**Configuración de alertas propuesta:** `warning_after_s=300` y `critical_after_s=600` en configuración operativa versionada por tenant, separada de la revisión GPS existente; cambios requieren capacidad administrativa, CSRF/Origin/CAS, motivo y auditoría. El evaluador usa `max(inicio_ventana, última recepción autenticada)` como referencia, agrega una gracia que se valide contra `health_interval_s` y Doze, y resuelve/deduplica por dispositivo y ventana. Si se necesita override por dispositivo/política, se acuerda después con Web; no sustituir silenciosamente `heartbeat_missing_after_s` actual. Los valores 5/10 min son candidatos, no SLO ni PASS.

## Matriz de dependencias con frontend

| Categoría | Trabajo futuro | Dependencia/coordination gate |
| --- | --- | --- |
| A. Solo Android | Watchdog de callbacks, transición de política, ciclo de vida FGS, buffer lleno, contador/rechazo local, subida independiente, revalidación en recreación. | Puede diseñarse separado. Implementar solo tras SPEC; pruebas Kotlin/Android y política de privacidad. No tocar archivos Web ni contratos compartidos. |
| B. Solo API | Evaluador periódico de silencio usando salud/posición ya persistidas; deduplicación de alertas; timestamps/fuente en lectura existente si no cambia forma. | Requiere PostGIS desechable, capacidad tenant, auditoría y revisión de carga. Si respuesta/ruta cambia, pasa a C. |
| C. Compartido con Web | Nuevos estados y endpoint de continuidad, lista de alertas, conteos/horas, `UNKNOWN` y recuperación, filtros/acciones. | RFC `GPS-CONTINUITY-001`, aprobación de contrato y coordinación con conversación frontend antes de editar `apps/web`, `packages/api-contracts` o ruta que consume Web. |
| C. Configuración de umbral | Si negocio exige editar umbrales desde Web, política/revisión/contrato y UI cambian juntos. | Decidir primero semántica, defaults y CAS; no alterar política publicada retroactivamente. |

El frontend existente puede seguir mostrando `GPS-HEALTH-001` sin nuevas claves. Su `RemoteHealth.source` actual solo contempla `DEVICE_OBSERVATION | SERVER_INFERENCE`: **no** introducir otro enum en esa respuesta ni cambiar `ONLINE`/`NO_COMMUNICATION` mientras Web usa la forma vigente. El nuevo `GpsDeviceWorkspace` sin seguimiento consulta dispositivos, sesiones, salud y posiciones; no consulta continuidad ni alertas. El informe de continuidad no debe obligarlo a desplegar un cambio coordinado para que el backend antiguo siga funcionando. Véase la [revisión de baseline e integración](baseline-integration-review-2026-10-20.md). Esta tarea no envía mensajes a la otra conversación ni modifica su checkout.
