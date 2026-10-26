# ADR-024 — Versionado histórico de rutas y geozonas

**Fecha:** 2026-10-26. **Estado:** propuesta técnica; requiere aprobación. **Complementa:** ADR-009/010.

## Contexto

Una edición posterior no debe alterar el cálculo de una asignación pasada. Las políticas GPS ya usan revisiones publicadas inmutables en `0009_gps_policies.sql`.

## Decisión propuesta

Mantener cabecera editable para borradores y revisión publicada append-only para geozona y ruta. Al crear asignación, congelar versión de ruta, lista de paradas, revisiones de geozona y mínimos efectivos en `assignment_visit`, con hash. La evaluación usa siempre ese snapshot; una corrección administrativa es evento explícito de reemplazo/reasignación y nueva evaluación, nunca UPDATE silencioso de revisión. Desactivación afecta asignaciones futuras y no borra historia.

## Consecuencias

Más almacenamiento y migración aditiva, pero reconstrucción determinista. Se debe definir qué cambios urgentes pueden reemplazar una asignación abierta y cómo se notifica al dashboard. La retención del snapshot debe sobrevivir al catálogo operativo.

**Implementación local Wave 2:** `route_template` es la cabecera estable; `route_draft_stop` contiene borrador mutable; `route_revision` y `route_stop_revision` contienen snapshot publicado. Publicación sella la revisión en la misma transacción; triggers SQL rechazan cambios y paradas tardías. La revisión conserva nombres/códigos cliente y sede, centro/radio, revisión de geozona y permanencia efectiva. Editar después abre un nuevo borrador. La congelación adicional al asignar sigue reservada para Wave 3; esta implementación local no equivale a aprobación del ADR para producción.
