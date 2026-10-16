# Especificaciones GEOPS

Este directorio organiza el desarrollo **Spec-Driven Development (SDD)**. Antes de implementar una wave, sus objetivos, decisiones, tareas y criterios de aceptación deberán poder relacionarse entre sí.

**Ciclo:** PRD → Specify → Plan → Tasks → Implement → Verify → Archive.

1. **PRD:** registrar necesidades, alcance y restricciones del producto en `prd/`.
2. **Specify:** concretar comportamiento y criterios observables de una wave en `waves/` y `acceptance/`.
3. **Plan:** documentar diseño, dependencias y riesgos; las decisiones transversales van en `architecture/adr/`.
4. **Tasks:** dividir el plan en unidades implementables y verificables.
5. **Implement:** crear código y configuración de acuerdo con la especificación aprobada.
6. **Verify:** registrar evidencia de pruebas y aceptación, además de los desvíos encontrados.
7. **Archive:** conservar las especificaciones y resultados de la wave para trazabilidad.

## Waves previstas

| Wave | Enfoque | Estado |
| --- | --- | --- |
| 0 | Fundamentos y MDM | Prevista |
| 1 | Agente Android y sincronización | Prevista |
| 2 | Rastreo, mapa y alertas | Prevista |
| 3 | Captación territorial | Prevista |
| 4 | Rutas y visitas recurrentes | Prevista |
| 5 | Dashboard y reportes | Prevista |
| 6 | Integración, validación y despliegue | Prevista |

El [PRD v1.1](prd/GEOPS-PRD-v1.1.md) es la fuente principal de [SPEC-00 — Technical Feasibility & Architecture Readiness](spec-00-technical-feasibility/README.md). SPEC-00 está documentado pero su cierre figura como BLOCKED por dependencias pendientes. Cada wave tendrá su propia especificación, plan, tareas y verificación; ninguna está implementada ni declarada completa. Los ADR registran decisiones revisables con evidencia del piloto.

## Corte documental de SPEC-00 y seguimiento

El [informe de cierre de SPEC-00](spec-00-technical-feasibility/closure-report.md) completa la investigación y arquitectura para este corte, sin cerrar su viabilidad operativa: el estado global sigue **BLOCKED**. SPEC-01 comenzó como especificación de Wave 0A bajo los [criterios de entrada](spec-00-technical-feasibility/closure-report.md#8-criterios-de-entrada-de-spec-01). La autorización posterior de implementación sintética y sus límites se registran en [wave-readiness de SPEC-01](spec-01-foundation-wave-0a/wave-readiness.md).
## SPEC-01 — Wave 0A

La [especificación de fundamentos, identidad y MDM](spec-01-foundation-wave-0a/README.md) contiene Specify → Plan → Tasks, [OpenAPI de diseño](spec-01-foundation-wave-0a/openapi.yaml), plan de pruebas y puertas de entrada. Estado: **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** solo para datos y dispositivos sintéticos; ADR-012 tiene aprobación provisional y su implementación requiere pruebas y revisión de seguridad. SPEC-00 sigue **BLOCKED**.
