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

El PRD v1.1 se incorporará posteriormente a `prd/`. Cada wave tendrá su propia especificación, plan, tareas y verificación; ninguna está implementada ni declarada completa. Los ADR iniciales registran decisiones de partida que podrán revisarse con evidencia del piloto.
