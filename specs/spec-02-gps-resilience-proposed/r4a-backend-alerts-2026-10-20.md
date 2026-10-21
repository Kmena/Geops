# R4-A — Monitoreo y alertas backend (20/10/2026)

**Estado: CONDITIONAL_PASS sintético.** Se implementó evaluación periódica, persistencia y auditoría en el worktree aislado `codex/gps-resilience`, base `c27f656`. No hay endpoint HTTP nuevo, integración Web, notificaciones externas, despliegue, prueba física ni cambio de reglas de aceptación histórica. Se conservan R1–R3. La API nueva requiere migración 0016 en cualquier instalación futura; no ejecutar en Staging con esta wave.

## Arquitectura implementada

`GpsContinuityMonitor.tick()` corre tras el scheduler y con el mismo advisory lock de PostgreSQL. Evalúa únicamente dispositivos `ACTIVE` con binding e instalación activos, política `ACTIVE`, asignación efectiva vigente y sesión programada cuyo intervalo UTC `[start_at,end_at)` contiene el instante de evaluación. El scheduler materializa también una ventana **ya iniciada y todavía vigente** tras reinicio, sin recrear ventanas terminadas. El monitor no solicita ubicación ni altera Android.

Por ventana calcula de forma separada máximos de `captured_at` y `received_at` de posiciones persistidas; `observed_at` y `received_at` de salud; recepción de eventos de sesión y descarga autenticada de configuración como evidencia de comunicación. Una subida tardía acredita comunicación actual, pero conserva la hora antigua de captura. `gps_sync_status.last_ack_at` representa persistencia del lote en servidor y carece de vínculo a tenant/instalación. Por ello el monitor deja `last_batch_persisted_at` en `null` y no lo presenta como prueba de recepción del ACK por Android. `last_ack_known_at` también queda `null` hasta disponer de evidencia del cliente.

El razonamiento del servidor se almacena con `source=SERVER_INFERENCE`; el `tracking_state` más reciente se guarda aparte como observación del dispositivo. Una observación `STOPPED` no autoriza afirmar causa de silencio ni reemplaza la ausencia de capturas. No se guardan coordenadas en alertas o auditoría. La alerta cambia de motivo cuando la evidencia cambia, escala una sola vez por severidad y se resuelve por evidencia nueva, fin de ventana, cambio de política, cambio de instalación o inactividad. Una nueva interrupción en la misma ventana abre otro episodio; un índice único parcial impide dos alertas abiertas por tenant, dispositivo, binding, instalación y ventana. El lock compartido evita carreras con materialización y reconciliación de políticas entre réplicas API.

## Matriz de estados y alertas

| Condición en ventana autorizada | Observación | Inferencia/alerta | Resolución |
| --- | --- | --- | --- |
| Inicio o cambio de política dentro de gracia | Últimas marcas o `null` | Sin alerta; estado aún indeterminado | Se evalúa al terminar gracia. |
| Posición capturada recientemente y recibida | `captured_at` y `received_at` distintos | Sin alerta de seguimiento | Una alerta previa se resuelve `EVIDENCE_RECOVERED`. |
| Salud reciente, captura antigua o ausente | Salud recibida; `RUNNING`/`STOPPED` si el agente lo informó | `CAPTURE_STALE`, fuente `SERVER_INFERENCE`; no afirma causa | Solo una captura nueva recibida o fin/cambio de ventana la resuelve. |
| Posición histórica recibida ahora, sin captura reciente | Recepción reciente y `captured_at` antiguo | `CAPTURE_STALE`; la subida no finge captura actual | Igual. |
| No llega ninguna comunicación autenticada reciente | Última recepción de posición/salud/sesión/configuración o `null` | `COMMUNICATION_MISSING`; no infiere red, batería, GPS ni estado del proceso | Comunicación reciente cambia motivo o una captura nueva resuelve. |
| Fin de ventana o dispositivo sin elegibilidad | Última evidencia histórica | No se abre alerta ordinaria; alertas abiertas se resuelven | Nuevo turno requiere ventana y gracia propias. |

Valores iniciales **provisionales**, no SLO: `warning_after_s=300`, `critical_after_s=600`, `start_grace_s=300`, `policy_grace_s=300`. Se configuran por tenant con versión CAS, capacidad `gps.policy.write`, concesiones de datos y salud, motivo y auditoría. La operación existe solo como servicio backend; publicar su ruta requiere coordinación de contrato, Origin/CSRF y revisión de Seguridad. Los valores siguen sujetos a validación frente a `health_interval_s`, retrasos de subida, Doze y carga real. El monitor puede alertar por silencio mientras Android captura offline: es una inferencia de **falta de evidencia en servidor**, no prueba de ausencia de captura.

## GPS-CONTINUITY-001: delta contractual propuesto para R4-B

No se cambió `GPS-HEALTH-001` ni el OpenAPI compartido. El OpenAPI de diseño ya dibuja `GET /v1/admin/gps-alerts`, pero `AlertList.reason_code` solo enumera `COMMUNICATION_MISSING|UNKNOWN`, sin `severity`, fuente ni horas separadas. Publicar los nuevos motivos en esa forma rompe el contrato de diseño y puede interferir con Web en trabajo. **Se detuvo la ruta HTTP y la edición del esquema compartido.** No describir `/gps-alerts` como operativo.

Propuesta aditiva para revisión conjunta API/Web/Seguridad: `GET /v1/admin/devices/{id}/continuity` y lista de alertas versionada, por ejemplo `GPS-CONTINUITY-001` con `schema_version:1`. Cada ítem tendría `device_id`, `tenant_id` interno (no exponer si no hace falta), `scheduled_session_id`, `reason_code` (`CAPTURE_STALE|COMMUNICATION_MISSING`), `severity` (`WARNING|CRITICAL`), `source=SERVER_INFERENCE`, `observed_tracking_state` (`RUNNING|STOPPED|null`) con `observed_at`, `last_position_captured_at`, `last_position_received_at`, `last_health_observed_at`, `last_health_received_at`, `last_batch_persisted_at`, `last_ack_known_at:null`, `evidence_at`, `age_s`, `threshold_s`, `opened_at`, `updated_at`, `resolved_at`. Campos desconocidos se representan como `null`; no emitir `ONLINE` como estado inferido. Paginación y filtro de tenant deben definirse antes del HTTP público. No usar el `AlertList` existente con códigos nuevos sin versionarlo.

Lectura interna de alertas abiertas exige administrador `ACTIVE`, `gps.session.read` **y** `gps.location.read`, concesiones vigentes en `gps_data_tenant_access` y `gps_health_tenant_access`, motivo administrativo de 8–240 caracteres y auditoría. Es una propuesta conservadora de autorización; la capacidad final y retención requieren revisión de Seguridad/Privacidad. No hay endpoint anónimo. Los consumidores existentes continúan usando las rutas de salud, sesión y posición sin cambio de respuesta.

## Evidencia sintética

| Verificación | Resultado |
| --- | --- |
| Prueba pura de inferencia | 7 casos PASS: gracia, borde `[)`, salud sin capturas, lote tardío, silencio, cambio de política y ACK no demostrado. |
| PostgreSQL/PostGIS descartable `geops_verify_41629` | Migraciones 0001–0016 desde cero, 28 aserciones PASS y `checkReadiness=true`. Prueba concurrencia, deduplicación, escalamiento, recuperación, fin de turno, tenant, permisos, revocación, CAS, cambios de binding/instalación y scheduler tras reinicio. Versiones previas de 0016 se probaron en bases descartables distintas, sin tocar Staging. |
| Upgrade `geops_verify_41630` | 0015→0016 PASS; conservó administrador/dispositivo sintéticos, checksum/readiness válidos y reaplicación idempotente. |
| Typecheck API y contratos actuales | PASS. El contrato compartido sigue sin cambios. |
| Build API, Node, contratos, escaneo | PASS: compilación API, 32 pruebas Node existentes, 7 casos nuevos, contratos OpenAPI sin cambios, 394 archivos elegibles sin secretos detectados. |
| Lint | Los archivos R4-A de código/prueba revisados con Biome pasan. `npm run lint` global falla con 30 errores preexistentes de formato en otros archivos del checkout; no se reformateó trabajo ajeno. |

Solo se usaron marcas y coordenadas sintéticas de prueba `(0,0)` en la tabla PostGIS desechable; no se guardan coordenadas en la alerta. Los datos de prueba no son Staging. Falta medir volumen, costo de consultas e interferencia con el scheduler a 25 dispositivos y probar fallos reales de API/DB durante los ticks.

## Dependencias y riesgos para R4-B

1. Coordinar con frontend la versión de lista y resumen, motivos, permisos, estados de carga/error y compatibilidad con `AlertList` de diseño. No editar Web antes del acuerdo.
2. Aprobar retención y purga de alertas/auditoría. La migración 0016 no incluye purga automática porque no hay período aprobado; un uso operativo así quedaría bloqueado por privacidad.
3. Acordar si el administrador puede editar umbrales desde Web y la ruta protegida por Origin/CSRF, CAS y motivo. La operación interna no se publica aún.
4. Validar en dos Android la cadencia de telemetría y captura, retrasos de WorkManager/Doze, hora de fix y recepción. El monitor detecta ausencia de evidencia en servidor, no garantiza captura ni entrega por minuto.
5. Preparar ensayo de carga/índices con 25 dispositivos y revisión independiente de seguridad antes de Staging. No hubo revisión independiente en esta wave.
6. `GPS-OFFLINE-001` y ADR-017 permanecen: una reducción remota desconocida offline no es visible al servidor como captura actual hasta sincronizarse; la alerta no cambia aceptación histórica ni autorización local.

**Gate:** R4-A `CONDITIONAL_PASS` sintético si las verificaciones finales pasan. R4-B e integración final no autorizadas por este informe.
