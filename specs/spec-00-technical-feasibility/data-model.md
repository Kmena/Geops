# Modelo de datos conceptual

**Estado:** propuesta, sin migraciones. Referencias: [PRD RF-02, RF-04, RF-07–RF-15](../prd/GEOPS-PRD-v1.1.md), [ADR-009](../architecture/adr/ADR-009-datos-geoespaciales.md), [ADR-010](../architecture/adr/ADR-010-visitas-recurrentes.md). PK internas son UUID salvo que se indique otra cosa. Tiempos de eventos se guardan en UTC y los calendarios conservan zona IANA.

| Entidad | Campos e invariantes clave |
| --- | --- |
| `admin_user` | Identidad, estado, referencia al proveedor de autenticación; todos los autorizados son administradores. |
| `device` | `geops_device_id` estable, estado DRAFT/INVITED/PENDING_CONFIRMATION/ACTIVE/SUSPENDED/REVOKED/RETIRED, modelo/OS y última comunicación; máximo operativo parametrizado 25. Identificadores MDM separados; el MDM ID no es PK. |
| `device_mdm_binding` | device_id, tenant/región, mdm_device_id, modo Fully Managed, método API/MANUAL, verificado_en, última_comprobación y estado; unicidad de mdm_device_id entre vínculos activos. UDID/serial solo si necesarios y protegidos. |
| `device_invitation` | ID, device_id, mdm_device_id esperado, HMAC del secreto con clave de servidor, estado ISSUED/CLAIMED/CONSUMED/CANCELLED/EXPIRED, emisor, tiempos y claim_id; sin secreto recuperable. |
| `device_key` | key_id, device_id, clave pública P-256, huella, estado PENDING/ACTIVE/REVOKED, versión, tiempos y metadatos de attestation verificada; nunca privada. |
| `device_session` | ID, hash de token opaco, key_id, device_id, emisión, expiración, revocación y último uso; 15 min iniciales. |
| `enrollment_challenge` / `request_nonce` | Challenge de un uso con TTL y resultado; nonce por clave con unicidad/TTL 10 min para impedir replay incluso bajo concurrencia. |
| `device_assignment` | device_id, employee_id, `valid_from`, `valid_to`; intervalos no solapados por dispositivo. Reasignar no transfiere visitas históricas. |
| `work_schedule` y `schedule_exception` | device_id, versión, zona IANA, días/franjas, excepciones y vigencia. Horarios que cruzan medianoche se representan como intervalo con inicio/fin local y se resuelven a instantes UTC. |
| `position_event` | `(device_id,event_id)` único, captured_at, received_at, `geog geography(Point,4326)`, accuracy_m > 0, metadatos de calidad, schedule_version, payload_hash; lat [-90,90], lon [-180,180]. ID estable del agente. |
| `device_heartbeat` | device_id, event_id, sent_at, received_at, diagnóstico reportado sin afirmar causa de desconexión; separado de coordenadas. |
| `establishment` | pin/candidato con fuente, source_id, fecha de importación, versión/licencia, coordenadas, clasificación pendiente/cliente/prospecto/descartado/duplicado y vínculo de duplicado. |
| `customer` y `catalog_import` | Catálogo autorizado, cédula comercial como texto con procedencia y revisión; no inferir desde OSM ni asumir unicidad global antes de conocer el esquema. `catalog_import` registra archivo, mapeo, errores y operador. |
| `pin` | Establecimiento o punto manual, `geog`, radio_m, precisión requerida y permanencia mínima configurables, prioridad, vigencia y versión. |
| `route`, `route_version`, `route_pin` | Asignación a dispositivo/empleado, lista de pines con orden opcional y fechas de vigencia. Cambios no reescriben el pasado. |
| `visit_rule` y `visit_obligation` | Regla de recurrencia versionada por pin/asignación; obligación por ventana temporal, estado, fecha límite y calidad evaluable. Única por regla/version/ventana. |
| `visit_evidence`, `visit_status_history` | IDs de posiciones usados, permanencia estimada, evaluación y razón; historial inmutable de cambios por llegada tardía. Tratamiento tras purga GPS pendiente. |
| `alert` | Tipo, obligación/dispositivo, severidad, apertura/cierre, última señal y antigüedad; clave idempotente por causa/ventana. |
| `ingest_outbox` | ID, device_id, rango/eventos afectados, estado, intentos, próximo intento; se inserta con posiciones y se consume al menos una vez. |
| `audit_event` | Actor humano/dispositivo/sistema, acción, objeto, timestamp, resultado, correlación; minimiza coordenadas y secretos. |

## Consultas e índices

- B-tree único `(device_id,event_id)` para idempotencia, y `(device_id,captured_at,event_id)` para historial y recalculo. `received_at` facilita observar retrasos y purga.
- GiST en `pin.geog`; `ST_DWithin(geography, geography, radio_m)` compara metros. Agregar GiST a `position_event.geog` solo si perfiles de consulta lo justifican. PostGIS documenta índice GiST y radios en metros: [ST_DWithin](https://postgis.net/docs/ST_DWithin.html), [índices](https://postgis.net/documentation/faq/spatial-indexes/).
- Índices por `visit_obligation(status,due_at)`, `alert(status,opened_at)`, `ingest_outbox(status,next_attempt_at)` y vigencias de horario/asignación/ruta. Consultas espaciales se limitan también por dispositivo/tiempo para evitar escanear 90 días.
- No se particiona inicialmente: ~1,08–1,62 M eventos/90 días es una escala que debe medirse, no una razón automática para complejidad. PostgreSQL exige que una restricción UNIQUE en tabla particionada incluya la clave de partición; partir por fecha complicaría la unicidad global `(device_id,event_id)`. Si se requiere particionar, diseñar antes un registro global de IDs o clave compatible y probar la purga. [PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html).

## Retención y reconciliación

`position_event` se purgará al cumplir 90 días desde `captured_at`, en lotes controlados con métricas y verificación de réplica/backup. Eventos recibidos tardíamente con `captured_at` ya fuera de ventana se rechazan o procesan conforme a una política pendiente; no se conservarán indefinidamente por llegar tarde. Un proceso automático revisa rezagos y deja evidencia de borrado.

Los registros derivados (visitas, alertas, auditoría) tendrán política de retención propia **por aprobar**. No pueden conservar coordenadas crudas copiadas para eludir los 90 días. Si una visita conserva referencias a eventos purgados, se preserva solo el resultado/minimización aprobada y se documenta la pérdida de verificabilidad detallada. Los respaldos deben tener expiración, restauración y borrado coherentes con la política legal; no se ha establecido su plazo.

Los eventos tardíos se atribuyen a asignación, horario, ruta y regla vigentes en `captured_at`, no al estado actual. La recomputación del worker es determinista y deja `visit_status_history`. Un dispositivo reasignado conserva su propio ID, pero el empleado histórico cambia solo desde la vigencia nueva. [business-rules.md](business-rules.md)
