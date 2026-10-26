# ADR-022 — Permanencia acumulada por visita y jornada

**Fecha:** 2026-10-26. **Estado:** acumulación confirmada DEC-GEO-002; estimador y umbrales propuestos. **Complementa:** ADR-010 y SPEC-03.

## Contexto

Los puntos llegan a destiempo, pueden faltar y no equivalen a minutos. Una salida y reentrada no debe reiniciar el saldo, pero tampoco se debe rellenar un hueco sin evidencia.

## Decisión

Ordenar eventos únicos por `captured_at,event_id`, no por recepción. Contar solamente pares consecutivos de posiciones interiores confiables de calidad admisible, de una misma sesión/contexto y separados por menos de `max_gap_s`. Crédito por par: `max(0,min(delta,credit_cap_s)-uncertainty_guard_s)`; los pares son disjuntos y se recortan a la intersección de jornada, sesión GPS y vínculo agente–dispositivo. Una muestra y un hueco largo dan cero. Sumar créditos de entradas separadas en la misma visita; no transferirlos a otra jornada. Guardar IDs de muestras, regla, incertidumbre y cada crédito como inferencia auditable. Recalcular ante evidencia tardía sin duplicar.

## Consecuencias

El tiempo es una estimación corroborada, no prueba continua de presencia. La regla conservadora puede causar falsos negativos; se calibra con trazas físicas. Permanencia insuficiente solo es `INCOMPLETE` si cobertura aprobada lo permite; de otro modo `UNVERIFIABLE`. Ningún evento posterior a `end_at` aumenta saldo. Véase algoritmo completo en SPEC-03 `architecture.md`.
