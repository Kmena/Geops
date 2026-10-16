# ADR-009 — PostgreSQL/PostGIS y retención

**Fecha:** 2026-10-16. **Estado:** propuesta a medir. **Complementa:** [ADR-003](ADR-003-ingesta-gps.md) y [ADR-004](ADR-004-infraestructura.md).

## Contexto

Hasta 25 equipos a una posición/minuto durante 8–12 h generan 12.000–18.000 eventos/día y 1,08–1,62 millones/90 días. Las consultas de radio y el borrado a 90 días deben ser previsibles.

## Decisión

Guardar posiciones en PostgreSQL/PostGIS con `geography(Point,4326)`, `captured_at` y `received_at`; unicidad `(device_id,event_id)` para deduplicar. Indexar dispositivo/tiempo y pines espaciales con GiST; usar `ST_DWithin` en metros. Comenzar con tabla no particionada y purga por lotes controlados; medir tamaño, latencia y WAL. Evaluar particionado por fecha solo si los datos reales lo justifican, preservando unicidad global.

## Consecuencias

Backups, restauración y retención derivada requieren política. PostgreSQL exige incluir la clave de partición en restricciones UNIQUE de una tabla particionada; una migración futura debe resolverlo explícitamente. El modelo y estimaciones están en [data-model.md](../../spec-00-technical-feasibility/data-model.md).
