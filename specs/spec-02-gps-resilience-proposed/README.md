# SPEC propuesto — Continuidad y resiliencia GPS

**Estado:** R0_PASS_PREPARATION (aceptado por negocio), R1_CONDITIONAL_PASS (aceptado), R2_CONDITIONAL_PASS sintético (aceptado) y R3_CONDITIONAL_PASS sintético de transporte independiente. Corte: 20/10/2026. La continuidad física sigue sin validar. R4 no empieza automáticamente. No están autorizados el inicio diario automático desatendido, `ACCESS_BACKGROUND_LOCATION`, privilegios Device Owner supuestos ni despliegue.

Flujo SDD: [Specify](requirements.md) → [Plan](plan.md) → [Tasks](tasks.md). Complementos: [arquitectura y contratos](architecture-contracts.md), [viabilidad Android](automatic-start-feasibility.md), [pruebas y gates](test-plan.md), [matriz de decisiones](risks-decisions.md), [contraste de baseline e integración Git](baseline-integration-review-2026-10-20.md), [evidencia R0](r0-baseline-2026-10-20.md), [evidencia R1](r1-observability-2026-10-20.md), [evidencia R2](r2-android-continuity-2026-10-20.md), [evidencia R3](r3-independent-upload-2026-10-20.md) y [evidencia R4-A](r4a-backend-alerts-2026-10-20.md).

Esta propuesta parte de `c27f656c71a82eee31e2bf281bb98eaf473be067` en la rama aislada `codex/gps-resilience` y contrasta la [auditoría local del 20/10](../../docs/audit-continuidad-gps-2026-10-20.md) con ese HEAD. Se copió únicamente ese documento al worktree y se verificó igualdad SHA-256; sigue sin confirmar en ambos checkouts y es entrada de trabajo, no evidencia publicada. No se copiaron cambios Android/API/Web sin confirmar ni capturas. Cada integración de código requerirá seleccionar un cambio por SHA/diff y verificar sus dependencias.

## Invariantes

1. Capturar solo si identidad, instalación, permiso Android, última política autenticada vigente conocida localmente, versión, ancla temporal y **la instancia UTC actual validada online** están vigentes. Las ventanas son `[inicio, fin)`; un callback tardío queda fuera. Ante duda, no capturar. La política anterior puede seguir rigiendo durante esa instancia si el teléfono aún no conoce una reducción remota y no venció ADR-017 (`GPS-OFFLINE-001`); una nueva instancia requiere contacto online.
2. Enviar fuera de horario únicamente **posiciones que ya fueron capturadas y persistidas** en horario autorizado. También puede transmitirse diagnóstico técnico limitado de red/cola/servicio, sin consultar GPS. El transporte no debe abrir `LocationManager`, crear una sesión `STARTED` ni ampliar la ventana.
3. Preservar PoP, revocación, ACK tras COMMIT, idempotencia, tenant y auditoría de SPEC-01/02. Silencio de red no prueba causa.
4. Respetar indicadores/notificación de Android, parada explícita del usuario y controles de privacidad. MDM no elimina restricciones del sistema.
5. No tocar el frontend activo, PoC, Staging, teléfonos, MDM, Inventori ni Billing en R0.

## Estado del aislamiento

El checkout principal está en `codex/spec-02-wave-1`, HEAD `c27f656`, con cambios sin confirmar en Android, API, Web, OpenAPI y archivos sin seguimiento. El worktree `gps-resilience-spec` se creó desde ese SHA y ahora tiene la rama independiente `codex/gps-resilience`; carpeta gestionada: `C:/Users/kmena/.codex/worktrees/gps-resilience-spec/Geops`. Integrar código local del checkout principal sigue pendiente de revisión de propiedad y dependencias. Ningún `reset`, `clean`, `stash`, `checkout` del directorio principal ni copia indiscriminada forma parte del plan.

**Decisiones recibidas:** `GPS-OFFLINE-001` está **APPROVED** con autorización offline acotada por ADR-017 y trazabilidad de revisión. Captura solo dentro de la instancia conocida por dispositivo; transporte histórico fuera de ella; botón manual de respaldo; estudio de autoarranque/MDM sin presuponer privilegios. Alertas 5/10 minutos y diagnóstico técnico fuera de horario siguen condicionados en sus detalles. La [matriz](risks-decisions.md) separa decisiones aprobadas, condicionadas y bloqueadas. R0 detectó que `PolicyEngine.current()` puede permitir offline una instancia futura incluida en el snapshot: debe fallar cerrado conforme a ADR-017. La aceptación backend de eventos de la instancia actual sigue pendiente de prueba, sin cambiar reglas implícitamente.
