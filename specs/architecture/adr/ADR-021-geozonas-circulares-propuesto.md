# ADR-021 — Geozonas circulares de puntos de cliente

**Fecha:** 2026-10-26. **Estado:** decisión funcional confirmada DEC-GEO-001; diseño técnico propuesto. **Complementa:** ADR-009 y SPEC-03.

## Contexto

El módulo necesita verificar visitas con GPS de precisión variable y mantener el significado histórico de una zona. `position_event.geom` ya es `geography(Point,4326)` e incluye precisión; la Web ya usa Leaflet y círculos.

## Decisión

Cada sede de cliente tiene revisiones publicadas de círculo con centro WGS84, radio en metros, mínimo de permanencia, estado y auditoría. PostGIS calcula `ST_Distance` geodésica y `ST_DWithin` prefiltra; GiST indexa centros. Muestra interior confiable exige `distance + accuracy <= radius`; exterior confiable exige `distance - accuracy > radius`; el resto es ambigua. La histéresis visual no sustituye esta prueba. Radios y precisión admisibles se calibran por operación, sin radio universal. La versión usada queda congelada en cada visita asignada.

## Consecuencias

No hay polígonos en esta versión. Círculos pequeños frente a precisión generan más `UNVERIFIABLE`. Se requieren pruebas de borde, señal débil y cambio de revisión; parámetros pendientes P-02. Una sede por cliente no es un límite del esquema: `client_site` admite varias.
