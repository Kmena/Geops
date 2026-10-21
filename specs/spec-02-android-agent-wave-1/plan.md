# Plan — SPEC-02 / Wave 1

## Wave P0 — desbloqueo de envío GPS, anterior a autonomía A–E

[GPS-UPLOAD-STARTED-BLOCKER](gps-upload-started-blocker-p0-2026-10-21.md) es la primera wave nueva: cerrar contrato v2 y compatibilidad Android/backend; implementar después ingesta transaccional de STARTED+posiciones, quitar compuerta global de `BatchSync`, conservar ACK exacto, adaptar buffers v1 sin pérdida, probar regresiones/seguridad y verificar envío en el mismo POCO. [T13–T17](tasks.md) y [P15–P19](test-plan.md) son sus trazas. **Estado actual: diseño documental, P0 abierto.** Compilación y unitarias no cierran el gate: se requieren integración HTTP/PostGIS, interoperabilidad Kotlin, concurrencia, migración/restore, auditoría independiente y evidencia física. El paso a Wave A requiere decisión explícita tras cerrar P0; esta secuencia no modifica ADR-020 ni autoriza despliegue. La secuencia A–E de la replanificación inferior está subordinada a este P0.

**Replanificación documental 2026-10-21:** [waves A–E de DEC-GPS-OFFLINE-001](ubicacion-autonoma-offline-propuesta-2026-10-21.md#6-waves-sin-repetir-trabajo-completado) son el delta futuro sobre W1-A–E existentes, no un reinicio ni cierre de tareas previas. A versiona política/tiempo offline; B servicio Android; C capacidad/cola; D ingesta histórica y sincronización; E pruebas físicas. No se implementa ninguna en esta actualización. [ADR-020](../architecture/adr/ADR-020-ultima-politica-valida-offline.md) prevalece sobre límites offline históricos de la tabla inferior.

## Dependencias auditadas antes de implementar

[SPEC-01 readiness](../spec-01-foundation-wave-0a/wave-readiness.md) **no declara terminada Wave 0A**. T06–T12/T14–T18 siguen parciales o bloqueadas; P06–P17/P22–P25 y Q2–Q4, revisión de seguridad W0A-E2, CI/restore Linux y validaciones de dos Android/MDM Free no están cerrados. Admin session/CSRF/audit existen, pero las capacidades GPS de [ADR-015](../architecture/adr/ADR-015-capacidades-administrativas-gps.md) requieren trabajo W1-B. Identidad/PoP/restore epoch son dependencias de descarga e ingesta. Una prueba fake o Trial no acredita activación real. Diseño, contratos, motor y UI con fixtures pueden avanzar en sintético; captura física exige gates propios. SPEC-00 permanece BLOCKED.

| Wave | Entrega pequeña | Gate de entrada | Gate de salida |
| --- | --- | --- | --- |
| W1-A — Fundamentos y contratos | ADR-015–017, semántica temporal, amenazas, OpenAPI de diseño y vectores sintéticos; sin código operativo. | PRD/SPEC-00/01 y auditoría de readiness. | **Cerrada para implementación sintética:** [revisión cruzada](contract-review-2026-10-19.md), P0 de diseño resueltos y 15/15 pruebas de referencia PASS; no equivale a interoperabilidad de producto. |
| W1-B — Políticas y persistencia | Migraciones sintéticas de capacidades, política/asignación exclusiva y auditoría; servicio admin. | W1-A cerrada para sintético; auth/CSRF/audit SPEC-01 verificados para rutas nuevas, gate ADR-013. | P02/P03/P09 en DB aislada: CAS, versionado, grupo futuro, idempotencia, denegación por defecto y restore. |
| W1-C — Agente Android | Motor/caché/FGS/sesiones con GPS simulado y sincronización mock. | W1-A cerrada para sintético; PoP/Keystore SPEC-01 y cifrado ADR-008 antes de buffer de producto. | P04–P07 sintéticas: horarios, reboot, MISSED_START, política vencida, ACK y ninguna captura fuera de ventana; paridad Kotlin V01–V12. |
| W1-D — Administración Web | Editor operativo, vista de impacto, sesiones/alertas y separación ejecutiva con fixtures; sin activar dispositivos. | W1-B contratos/API admin; capacidades GPS y shell SPEC-01. | P10 accesibilidad/errores/CSRF/capacidades y lectura sensible auditada con mocks; integración real en E. |
| W1-E — Integración y validación | **E1:** API dispositivo/PostGIS, reconciliación, métricas, retención y carga sintética. **E2:** piloto físico supervisado y decisión operativa separada. | E1: B/C/D, seguridad/restore SPEC-01. E2: identidad/privacidad real, autorización de piloto, matriz de flota/MDM externo. | E1: P04/P07–P09/P11/P13, revisión independiente. E2: P12 por OS/modelo y riesgo aceptado; no implica despliegue general. |

MDM investiga por separado: desinstalación, bloqueo de ubicación, aprovisionamiento sin reset y multimarca. [ADR-014 propuesto](../architecture/adr/ADR-014-mdm-flota-existente-propuesto.md) conserva la decisión de negocio pendiente. Se pueden realizar W1-A–D en sintético sin esos privilegios. Su ausencia se muestra como limitación operacional y no se oculta en resultados. No se implementa MDM propio ni se cambia ManageEngine aquí.

## Secuencia de decisión

W1-A cerrada para sintético → ejecutar B/C/D/E1 con evidencia y paridad real de contratos → decidir E2 físico → decidir operación futura. Un gate incompleto conserva estado abierto; no convierte SPEC-00/01 a PASS. No se activa seguimiento remoto por publicar documentos o UI.
