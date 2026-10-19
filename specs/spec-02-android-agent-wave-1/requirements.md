# Specify — requisitos de SPEC-02

**Estado:** propuesta para revisión. Fuentes: [PRD v1.1](../prd/GEOPS-PRD-v1.1.md) RF-03–RF-07, RF-14–RF-15, RN-05/RN-07 y CA-02–CA-05; [SPEC-00](../spec-00-technical-feasibility/requirements.md); [SPEC-01](../spec-01-foundation-wave-0a/spec.md); [ADR-002](../architecture/adr/ADR-002-gps-propio.md), [ADR-003](../architecture/adr/ADR-003-ingesta-gps.md), [ADR-008](../architecture/adr/ADR-008-buffer-offline.md) y [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md).

## Requisitos funcionales

| ID | Requisito verificable | Aceptación |
| --- | --- | --- |
| S02-R01 | Solo administrador autenticado y autorizado en GEOPS Web crea, edita, activa, pausa o revoca políticas; Android no dispone de mutación. | API rechaza escritura anónima, CSRF ausente y actor dispositivo; auditoría conserva actor, antes/después y motivo sin coordenadas. |
| S02-R02 | La política versionada contiene asignación a dispositivo o grupo, días ISO de semana, hora local de inicio y fin, excepciones por fecha, zona IANA, intervalo objetivo GPS, intervalo objetivo de sincronización, vigencia UTC y estado. | Esquema y UI validan todos los campos; publicación crea revisión inmutable; servidor resuelve una sola política efectiva por dispositivo. |
| S02-R03 | El agente obtiene configuración con sesión de dispositivo y PoP de SPEC-00, y valida identidad, versión, vigencia y límites. | Política ajena, vieja, caducada, malformada o revocada no se aplica; reporta versión aceptada/rechazada. |
| S02-R04 | El agente captura solo dentro de intervalos autorizados. | Al cierre retira actualizaciones; callbacks tardíos y lecturas fuera de ventana no se persisten ni envían. Sin política vigente, identidad válida, permiso o GPS, no captura. |
| S02-R05 | El inicio y fin efectivo son eventos explícitos; una ventana programada puede quedar sin sesión efectiva. | Dashboard distingue programado, efectivo, omitido e interrupción, con fuente y calidad de evidencia. |
| S02-R06 | Cada posición autorizada se persiste en buffer protegido antes del envío y se sincroniza de modo idempotente. | Reinicio, corte de red, ACK perdido y duplicados no alteran IDs; solo ACK confirmado elimina pendientes. El envío de pendientes puede continuar fuera de horario. |
| S02-R07 | El agente informa versión aplicada, permisos, GPS, red, backlog, inicio/fin/interrupciones y errores con códigos sanitizados. | Heartbeat/diagnóstico no contiene coordenadas ni causa inventada; silencio se muestra como estado desconocido. |
| S02-R08 | La consola permite crear/editar horarios, asignar, fijar frecuencia, ver versión aplicada, sesiones y sincronización. | Configuración operativa queda en navegación distinta del resumen ejecutivo; guardado exige revisión de impacto y motivo. |
| S02-R09 | Política vencida/revocada o identidad suspendida impide nuevas capturas; offline usa último snapshot válido solo hasta su límite. | Pruebas de reloj, revocación y pérdida de red muestran cierre seguro; al reconectar se consulta servidor antes de reanudar. |
| S02-R10 | Posiciones y sesiones se vinculan a identidad GEOPS y versión de política aceptadas por backend. | No se confía en `device_id`, versión o `session_id` aislados enviados por cliente; servidor cruza asignación, ventana y vínculo. |
| S02-R11 | La ausencia de heartbeat supera un umbral administrado y produce alerta de comunicación, con última posición recibida y antigüedad; la causa se mantiene desconocida sin evidencia. | Prueba de silencio/red/permiso diferencia observación de inferencia; consulta sensible auditada. |
| GPS-HEALTH-001 (propuesto para W1-C/E1) | El agente observa batería, carga/cargador, ahorro, proveedor GPS, conectividad y FGS durante ventanas autorizadas con intervalo propio y conserva hora prevista/real. | S02-P14 sintético; la ingesta y lectura requieren el [cambio SDD propuesto](gps-health-change-proposal.md), sin alterar el baseline W1-A hasta aprobación. |

## Invariantes y casos límite

- Ventanas son intervalos semiabiertos `[inicio, fin)` en zona IANA. `inicio < fin` termina el mismo día, `inicio > fin` cruza medianoche y `inicio = fin` se rechaza; el día ISO 1–7 es el día local de inicio. DST, recorte por vigencia e instancias UTC siguen [ADR-017](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md). El dispositivo no extiende una ventana por tolerancia de reloj.
- Una excepción por fecha local prevalece sobre la regla semanal de esa fecha: `OFF` o ventana sustitutiva válida. Dos excepciones para la misma fecha se rechazan; se conserva su origen administrativo y motivo. La publicación previsualiza las ventanas UTC resultantes.
- Vigencia `valid_from < valid_until`, en UTC; `active=false` cancela captura al siguiente contacto. Autorización offline máxima: 12 h desde verificación autenticada, acotada por fin de ventana/vigencia. Reinicio offline o tiempo no verificable detiene capturas. No se promete revocación instantánea sin red; su riesgo residual exige aceptación antes del piloto.
- Una sola revisión efectiva por dispositivo e instante. No hay precedencia individual/grupo: cualquier solape se rechaza (409), incluso al cambiar membresía. `assignment_version` crece por dispositivo ante cambios futuros, desasignación o revocación. Una política futura requiere revalidación online antes de activarse. Reinstalación/restauración exige identidad vigente de SPEC-01.
- Frecuencias son objetivos, no garantías Android. Límites de contrato W1-A: captura 30–300 s y sincronización 60–900 s; 60 s GPS es referencia del PRD. El piloto puede estrecharlos tras batería/privacidad. `WorkManager` no define cadencia GPS de 60 s.
- El umbral de alerta por silencio durante una ventana autorizada se configura de 300 a 7200 s (predeterminado de diseño 900 s). Fuera de ventana no se crea alerta de ausencia de heartbeat ordinario.
- El envío ordena posiciones pendientes por `captured_at,event_id`, pero el servidor tolera llegada fuera de orden por reintentos; no se cambia `event_id` ni la hora de captura.
- Cambio de política durante una sesión: cerrar la sesión anterior con `POLICY_REPLACED`; evaluar nueva ventana y, si procede, abrir otra con nueva versión y nuevo provisional. No reetiquetar muestras históricas. La sesión canónica la crea el backend según [ADR-016](../architecture/adr/ADR-016-identidad-sesiones-gps.md).
- Captura real exige permisos, notificación e indicadores Android visibles. No se promete inicio automático desde segundo plano. Si Android lo impide, registrar `MISSED_START`/error y pedir interacción visible; no simular sesión.
- Empleados y asignaciones históricas siguen el modelo de SPEC-00; política por ID lógico de dispositivo o grupo, jamás UDID/serial como autorización.

## Fuera de alcance

MDM propio, cambios de ManageEngine, impedir desinstalación o desactivar ubicación, aprovisionar sin reset, cobertura multimarca, producción, visitas/rutas e inferencia de inicio/fin desde huecos GPS. Estos cuatro temas MDM son bloqueos independientes; no frenan contratos, UI ni lógica sintética de esta SPEC.
