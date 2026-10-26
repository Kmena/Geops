# ADR-026 — Reglas recurrentes materializadas en asignaciones diarias

**Fecha:** 2026-10-26. **Estado:** decisión técnica implementada localmente para planificación Wave 3; adopción operativa pendiente. **Complementa:** ADR-010 y ADR-024.

## Contexto

La recurrencia semanal, las excepciones, los cambios de plantilla y el horario con zona IANA no pueden evaluarse de forma confiable solo a partir de la regla actual. El esquema operativo carece de agente y vínculo agente–dispositivo.

## Decisión propuesta

Guardar `route_schedule_rule` con días ISO, horario local, zona, vigencia y excepciones versionadas. Materializar ocurrencias diarias dentro de horizonte controlado, únicas por regla y fecha local; cada ocurrencia produce una `route_assignment` con límites UTC resueltos y snapshot de ruta/geozona. Ediciones futuras de regla afectan solo ocurrencias no iniciadas y se auditan; cancelar y reasignar son transiciones explícitas. Conflictos de agente/jornada se rechazan mediante rango temporal. Dispositivo es opcional hasta vincularlo históricamente al agente; ninguna ubicación se atribuye por la posesión actual.

## Consecuencias

El materializador limita cada solicitud a 31 fechas civiles y guarda `(rule_id,local_date,applied_version)`; la reejecución no duplica ocurrencias. Los cambios futuros reconcilian solo asignaciones `PLANNED`, dejando registro cancelado y snapshot histórico. Horas DST inexistentes o ambiguas se rechazan. La identidad de agente para planificación se mantiene independiente de MDM; la vinculación histórica agente–dispositivo requiere un tenant canónico del dispositivo y sigue pendiente. Por ello Wave 3 no valida GPS ni habilita uso operativo.
