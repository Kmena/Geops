# ADR-028 — Dashboard de cumplimiento provisional

Estado: **propuesto para integración**; implementado y verificado localmente en SPEC-03 Wave 5.

## Contexto

Las evaluaciones de permanencia de Waves 4A–4B son revisables cuando llega evidencia tardía. Las asignaciones, paradas y geozonas ya tienen snapshots inmutables; el resultado actual está en `visit_evaluation_current`, con historial append-only. Todavía no existe una política aprobada de cierre/reconciliación ni una retención de derivados.

## Decisión

El dashboard lee resultados persistidos y snapshots; no reprocesa GPS en HTTP. Devuelve KPI de **cumplimiento acreditado provisional**: visitas obligatorias completadas dividido entre visitas obligatorias de asignaciones activas. Las visitas opcionales no afectan el denominador; las canceladas se excluyen. Si el denominador es cero, el porcentaje es `null`. Una ruta está completada solo cuando todas sus visitas obligatorias están `COMPLETED`. Ausencia de evidencia, ACK antiguo, backlog u offline no generan automáticamente `NOT_VISITED`.

El filtro `sync_state` se deriva exclusivamente de `gps_sync_status.last_ack_at` y `backlog_reported` cuando existen `visit.device.read` y `gps.session.read`: `UNKNOWN`, `BACKLOG_REPORTED`, `ACK_RECENT` (ACK ≤15 min con backlog reportado 0) o `NO_RECENT_ACK`. Es una señal de comunicación observada, no garantía de entrega total. `processing_state` conserva por separado `visit_evaluation_job.state`. El umbral de 15 min es técnico y requiere calibración operativa; se muestra el timestamp del ACK.

Las ubicaciones son optativas: requieren además `gps.location.read`, proceden de `position_event` dentro del vínculo temporal agente–dispositivo y de la ventana de asignación, y se presentan como **última ubicación conocida de esa jornada**, con captura y antigüedad. Health muestra último reporte o falta de comunicación reciente sin inferir incumplimiento. Nunca se dibuja una ruta vial supuesta. El mapa de geozonas y posiciones se pagina junto con las visitas; los KPI y grupos consideran todo el conjunto filtrado.

Cada revisión nueva registra el motivo del job en `audit_event` existente. La historia se enlaza mediante el timestamp transaccional y las claves de asignación/parada/revisión; las revisiones anteriores sin motivo muestran ausencia explícita. La evidencia se consulta bajo `visit.evidence.read`, razón obligatoria y auditoría; las filas GPS crudas pueden haber expirado y entonces se conservan los intervalos sin reconstruir muestras.

## Consecuencias

No se añade migración: sirven los índices de asignación/calendario, evaluación actual/historia, posición por tenant/dispositivo/tiempo, health y ACK. Se limita la consulta a 31 fechas civiles, 10 000 snapshots, 100 filas por página y 100 pares agente–dispositivo para mapa. La aprobación futura de retención, cierre final y umbrales puede ampliar el contrato sin reinterpretar resultados históricos.
