# SPEC-03 — Clientes, geozonas, rutas y asignaciones

**Estado:** Waves 1 y 2 `TECHNICAL_PASS` local en `codex/spec03-wave1`; Wave 3 `WAVE3_PLANNING_TECHNICAL_PASS` con `AGENT_DEVICE_INTEGRATION_PENDING`; Wave 4A `WAVE4A_ENGINE_TECHNICAL_PASS` local y sintético. Wave 4B y Wave 5 siguen pendientes. `DEPLOYED = NO`, integración pendiente. Ver [cierres de Wave 1](wave1-closure.md), [Wave 2](wave2-closure.md), [Wave 3](wave3-closure.md) y [Wave 4A](wave4a-closure.md).

**Corte auditado:** HEAD `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`, 2026-10-26. Esta especificación se escribió en un worktree aislado. Las modificaciones sin commit del checkout principal no se incorporaron.

| Fase | Documento |
| --- | --- |
| Auditoría | [audit.md](audit.md) |
| Specify | [requirements.md](requirements.md), [architecture.md](architecture.md), [data-model.md](data-model.md), [api-contracts.md](api-contracts.md) |
| Plan | [plan.md](plan.md), [risks.md](risks.md) |
| Verify | [test-plan.md](test-plan.md), [traceability.md](traceability.md) |
| Decisiones | [ADR-021](../architecture/adr/ADR-021-geozonas-circulares-propuesto.md) a [ADR-026](../architecture/adr/ADR-026-recurrencia-asignaciones-propuesto.md) |
| Ejecución Wave 1 | [wave1-closure.md](wave1-closure.md) |
| Ejecución Wave 2 | [wave2-closure.md](wave2-closure.md) |
| Ejecución Wave 3 | [wave3-closure.md](wave3-closure.md) |
| Ejecución Wave 4A | [wave4a-closure.md](wave4a-closure.md) |

**Decisiones funcionales cerradas:** geozonas circulares; permanencia acumulada dentro de la jornada; rutas reutilizables con orden libre. Los parámetros técnicos y umbrales de negocio siguen propuestos hasta calibración y aprobación.

**Compatibilidad:** el diseño consume `position_event` ya persistidos; no solicita cambios de APK, GPS v2 ni políticas de captura. La unión histórica agente–dispositivo y la independencia MDM de la ruta de ingestión son bloqueos a resolver antes de asignaciones reales (véase auditoría).
