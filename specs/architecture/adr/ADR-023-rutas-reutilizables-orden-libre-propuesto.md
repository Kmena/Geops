# ADR-023 — Rutas reutilizables con orden libre

**Fecha:** 2026-10-26. **Estado:** decisión funcional confirmada DEC-ROUTE-001; representación propuesta. **Complementa:** ADR-011.

## Contexto

La planificación necesita reutilizar grupos de clientes, pero una secuencia obligatoria penalizaría visitas válidas y no fue solicitada.

## Decisión

Una ruta es plantilla versionada de paradas de sede de cliente. `suggested_order` solo ordena la Web; el motor no lo usa. Cada parada marca obligatoriedad y mínimo de permanencia, con fallback a geozona publicada. La ruta asignada termina cuando todas sus paradas obligatorias están `COMPLETED`; las opcionales se muestran aparte. Un cliente puede integrar varias rutas. Publicar una nueva versión no cambia asignaciones previas.

## Consecuencias

No hay optimización IA ni penalización por llegada. Las rutas con cero paradas obligatorias requieren definición de producto antes de publicar; propuesta: rechazarlas para evitar completar una obligación vacía.

**Implementación local Wave 2:** se aplica la propuesta de rechazar publicación sin al menos una parada obligatoria. El orden se almacena en `suggested_order` y solo ordena la interfaz; no se implementó evaluación GPS. Una sede se permite una vez por ruta, y dos sedes del mismo cliente son visitas distintas. Esta regla queda documentada para revisar en integración de producto.
