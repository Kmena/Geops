# SPEC-03 — Clientes, geozonas, rutas y asignaciones

**Estado actualizado Wave 5:** dashboard técnico local en `codex/spec03-wave5`, derivado de Wave 4B, con resultados provisionales y validación física pendiente. Ver [cierre Wave 5](wave5-closure.md), [cierre Wave 4B](wave4b-closure.md) y [protocolo físico](wave4b-physical-protocol.md). `DEPLOYED = NO`.

**Integración y release readiness:** rama aislada `codex/spec03-release-candidate` sobre `79a8a1c`. Incluye Waves 1–5, MDM/GPS, migraciones 0028–0030 y continuidad GEOPS sin binding MDM. El [informe de release readiness](release-readiness-report.md) y [ADR-029](../architecture/adr/ADR-029-continuidad-geops-sin-mdm-y-upgrade-supervisado.md) distinguen pruebas locales de la actualización remota aún pendiente. `STAGING_DEPLOYMENT_PENDING`; no hay despliegue.

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
| Ejecución Wave 4B | [wave4b-closure.md](wave4b-closure.md), [protocolo físico](wave4b-physical-protocol.md) |
| Ejecución Wave 5 | [wave5-closure.md](wave5-closure.md), [ADR-028](../architecture/adr/ADR-028-dashboard-cumplimiento-provisional-propuesto.md) |

**Decisiones funcionales cerradas:** geozonas circulares; permanencia acumulada dentro de la jornada; rutas reutilizables con orden libre. Los parámetros técnicos y umbrales de negocio siguen propuestos hasta calibración y aprobación.

**Compatibilidad:** el diseño consume `position_event` ya persistidos; no solicita cambios de APK, GPS v2 ni políticas de captura. La unión histórica agente–dispositivo y la independencia MDM de la ruta de ingestión son bloqueos a resolver antes de asignaciones reales (véase auditoría).
