# Tasks — backlog trazable de implementación controlada

R0 tiene `PASS_PREPARATION` y R1–R4-A `CONDITIONAL_PASS` sintéticos aceptados. R4-A tiene evaluador y persistencia, con lectura HTTP/OpenAPI y Web pendientes por conflicto de contrato; véanse [informe R4-A](r4a-backend-alerts-2026-10-20.md) y [coordinación previa a R4-B](r4b-contract-coordination-2026-10-20.md). No se cambiaron contratos compartidos ni reglas de aceptación histórica.

**Actualización 21/10:** lectura HTTP versionada, Web y migración 0017 de R4-B implementadas en `codex/geops-integration`; [detalle y evidencia](r4b-integration-2026-10-21.md). Faltan E2E navegador, revisión independiente, política definitiva de retención y prueba física. La frase anterior conserva el estado histórico antes de R4-B.

| ID | Wave | Trabajo y dependencia | Evidencia de cierre |
| --- | --- | --- | --- |
| R-T01 | R0 | Reconciliar `c27f656` con diff local Android/API y auditoría no confirmada. | Tabla de cambios que se adoptan, se rehacen o se descartan; sin pérdida de trabajo ajeno. |
| R-T02 | R0 | Registrar `GPS-OFFLINE-001` aprobado; mantener autoarranque diario y permiso background fuera de alcance; revisar ADR-017/privacidad. | Matriz de decisiones y límite offline explícitos. |
| R-T03 | R0/R4-B | Propuesta `GPS-CONTINUITY-001` redactada; pendiente revisión conjunta API/Web/Seguridad/Privacidad antes de editar OpenAPI, backend HTTP o Web. | Vectores de cliente viejo/nuevo, contrato aprobado y política de retención. |
| R-T04 | R1 | C07/C08/C09: diagnósticos, conteos de 24 h y razón de fin. **Observabilidad implementada; PASS sintético.** | Unit tests de razones, alcance, boot, horario y no fuga. El texto operativo y UX final se revisan al integrar Android local. |
| R-T05 | R1/R4 | C01/C05: marcas de callbacks y `BUFFER_UNAVAILABLE` **instrumentadas en R1**; watchdog/alertas y recuperación de buffer siguen pendientes. | Sin fixes con proveedor activo debe poder producir `CAPTURE_STALE` cuando se apruebe evaluador; error de cola preserva datos. |
| R-T06 | R2 | C03: transición de revisión sin `stopSelf` prematuro. **Sintético implementado.** | Revisión/revocación JVM sin doble listener; prueba OS/OEM pendiente. |
| R-T07 | R2 | C02: recuperación permitida de FGS, estado de intención y stop explícito. **Implementada condicionalmente.** | Estado cifrado y guardia probados en JVM; redelivery/Task Manager/reboot pendientes en dos teléfonos. |
| R-T08 | R3 | C04: JobScheduler de subida independiente, persistido, con red y barrido; **implementado sintéticamente**. | JVM valida backlog tras fin y ACK; faltan dos teléfonos y observación de Doze/OEM. |
| R-T09 | R4-A | C06 y C01 server-side: evaluador/alerta periódica y lectura interna autorizada implementados; ruta HTTP diferida. | PostGIS aislado, concurrencia, deduplicación, aislamiento tenant, cambio de binding y auditoría PASS sintético; contrato HTTP R4-B pendiente. |
| R-T10 | R5 | Pruebas físicas y revisión de seguridad/privacidad. | Dos OEM, versiones aplicables y evidencias sin coordenadas en repo. |
| R-T11 | R0/R2 | Formalizar predicado `ALLOW` y generación de listener por revisión; probar actualización que amplía/reduce con callback concurrente y desconexión. | R-P13; GPS-OFFLINE-001 registrado, sin ampliar ventana local ni TTL. |
| R-T12 | R0/R4 | Diseñar configuración de alerta 300/600 s, gracia, capacidad, retención y lectura Web opcional. | R-P15, compatibilidad de `RemoteHealth`, revisión de Seguridad y responsable Web. |
| R-T13 | R0/R3 | Delimitar diagnóstico fuera de horario a cola/red/servicio, con allowlist, cuota y retención. | R-P14: cero llamadas de ubicación, tenant/capacidad/motivo/auditoría y datos eliminados al vencer plazo. |
| R-T14 | R0/R2/R4 | Reproducir reducción durante instancia actual y sync histórico; demostrar que una instancia futura incluida en snapshot no se preactiva offline. | R-P16–R-P19 con PostGIS desechable; guardia Android fail-closed. Cambio API solo ante fallo demostrado y decisión API/Seguridad. |

Ninguna tarea concede permiso para tocar frontend ni contratos compartidos sin gate R-T03. La rama aislada `codex/gps-resilience` ya existe; no trasladar cambios locales por `stash`/`reset` automático.
