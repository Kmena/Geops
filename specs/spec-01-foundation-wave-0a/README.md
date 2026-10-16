# SPEC-01 — Foundation, Device Identity & MDM Integration (Wave 0A)

**Estado:** READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING (2026-10-16), solo con datos y dispositivos sintéticos. Specify → Plan → Tasks están documentados. T01–T05 tienen implementación y pruebas locales parciales; no hay pruebas físicas ni despliegue de Wave 0A.

SPEC-00 permanece **BLOCKED**. T01–T05 se ejecutaron localmente con datos sintéticos según [wave-readiness.md](wave-readiness.md); la cuenta ManageEngine Free y el piloto Android no se consideran validados.

## Documentos

| Fase | Archivo | Propósito |
| --- | --- | --- |
| Specify | [spec.md](spec.md) | Alcance, historias y trazabilidad. |
| Specify | [research.md](research.md) | Auditoría, fuentes y decisiones de tecnología. |
| Specify | [architecture.md](architecture.md) | Componentes, seguridad y límites. |
| Specify | [data-model.md](data-model.md) | Esquema inicial, migraciones y retención. |
| Specify | [api-contracts.md](api-contracts.md) | Contratos HTTP y OpenAPI. |
| Plan | [plan.md](plan.md) | Orden de implementación e infraestructura. |
| Tasks | [tasks.md](tasks.md) | Tareas verificables y paralelismo. |
| Verify | [test-plan.md](test-plan.md) | Evidencia y puertas de calidad. |
| Verify | [implementation-evidence-T01-T05.md](implementation-evidence-T01-T05.md) | Resultados reales y límites de T01–T05. |
| Riesgos | [risks.md](risks.md) | Amenazas, decisiones y dependencias. |
| Entrada | [wave-readiness.md](wave-readiness.md) | Estado y criterios para empezar. |

La fuente de requisitos es [PRD v1.1](../prd/GEOPS-PRD-v1.1.md). Las decisiones vinculantes están en [ADR](../architecture/adr/) y los resultados de proveedor en [SPEC-00](../spec-00-technical-feasibility/README.md). Los contratos de identidad de SPEC-00 siguen siendo normativos; este paquete solo concreta su aplicación a 0A.
