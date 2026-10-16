# ADR-011 — Optimización de rutas con IA diferida

**Fecha:** 2026-10-16. **Estado:** decisión de alcance confirmada por [PRD v1.1](../../prd/GEOPS-PRD-v1.1.md) RN-09 y sección de etapas.

## Contexto

La etapa 1 necesita rutas asignadas y realizadas, visitas verificables y métricas confiables. El PRD reserva la optimización automática con IA para etapa 2.

## Decisión

Etapa 1 no integra APIs de modelos ni genera rutas optimizadas automáticamente. Se versionan rutas y se recogen datos de calidad con procedencia y métricas agregadas para una evaluación futura de algoritmos/IA.

## Consecuencias

Se evita coste, dependencia externa y decisiones automatizadas con datos aún no validados. La selección de método, límites, métricas de mejora y tratamiento de datos para etapa 2 requerirá un spec y ADR futuros.
