# ADR-010 — Procesamiento desacoplado de visitas recurrentes

**Fecha:** 2026-10-16. **Estado:** propuesta; umbrales de negocio pendientes. **Complementa:** [ADR-003](ADR-003-ingesta-gps.md).

## Contexto

Las posiciones llegan tarde, duplicadas y fuera de orden. Una visita requiere radio, precisión, permanencia y calendario; evaluar todo dentro de la petición retrasaría la ingesta y complicaría correcciones.

## Decisión

Insertar en la misma transacción las posiciones y una tarea outbox. Un worker del backend procesa tareas al menos una vez, recalcula obligaciones afectadas por `captured_at` y versiones históricas de horario, asignación, ruta y regla, y registra transiciones auditables. Distinguir pendiente, verificada, vencida evaluable y no verificable. Las escrituras derivadas serán idempotentes. No introducir Kafka, RabbitMQ ni microservicios en la escala inicial.

## Consecuencias

El dashboard puede tener retraso respecto al ACK de persistencia y debe mostrar frescura de cálculo. Se necesitan métricas de cola y recuperación/reprocesamiento. Parámetros de radio, precisión, cobertura y vencimiento se acuerdan antes de implementar. Véase [business-rules.md](../../spec-00-technical-feasibility/business-rules.md).
