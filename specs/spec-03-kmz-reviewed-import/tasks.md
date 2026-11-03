# Tasks — SPEC-03

**Estado:** T01 documental completada con G0-04 PARTIAL. T02–T03 tienen la infraestructura W1-A implementada y corregida en W1-A-R; [evidencia](w1-a-r-evidence.md). La reauditoría mantiene A-07 PARTIAL por lint global heredado. El catálogo comercial autorizado W1-B sigue pendiente. T04–T14 no se iniciaron.

| ID | Wave | Tarea | Verificación |
| --- | --- | --- | --- |
| T01 | W0 | Registrar D-01–D-08 aprobadas, medir referencia KMZ en solo lectura, alinear ocho documentos y evaluar G0-01–G0-08. | [decisions.md](decisions.md), [plan.md](plan.md#evaluación-de-gates-w0--2026-11-03); G0-04 PARTIAL por D-01. |
| T02 | W1 | W1-A creó la migración base; W1-A-R2 la propone como 0019 y mantiene rutas DRAFT. W1-B pendiente: contrato comercial autorizado. | Migración limpia, upgrade 0018→0020, rollback y ausencia de grants verificados en DB desechable; [evidencia R2](w1-a-r2-evidence.md). |
| T03 | W1 | W1-A completada: API/servicio de catálogo, versiones, catalog_revision y allowlists admin; W1-B pendiente: ingestión comercial. | CRUD, FK/unicidad, denegación por defecto, carrera ETag, auditoría y regresión GPS/Web; [evidencia](w1-a-evidence.md). |
| T04 | W2 | Implementar receptor streaming, hash, ZIP/KML seguro y cuotas configurables con máximos duros D-05. | P01–P03/P16; CPU/memoria/concurrencia medidas antes de fijar valores productivos. |
| T05 | W2 | Persistir árbol y originales en staging, estados/TTL 30 días propuestos; limpieza solo tras política D-06. | P01/P04/P17; diff operativo vacío y retención aprobada. |
| T06 | W3 | Implementar normalizador reversible y validadores geográficos. | P05/P09 con casos límite. |
| T07 | W3 | Implementar matcher versionado con bandas iniciales 50/250 m solo para candidatos, explicación y rematch/rebase. | P06–P09, bordes y calibración con casos validados. |
| T08 | W4 | Crear tabla, filtros, comparación triple y edición con If-Match. | P07/P10; dos editores. |
| T09 | W4 | Crear mapa de revisión con capas y navegación bidireccional; sin dependencia de teselas para decisión. | P10/P11 y accesibilidad. |
| T10 | W5 | Generar plan inmutable/digest, resumen por acción y bloqueos. | P12, conteos reconciliados. |
| T11 | W5 | Implementar commit SERIALIZABLE, ledger, idempotencia, actualización por campos y recuperación tras timeout. | P07/P08/P13–P15 con PostgreSQL real y fallos inyectados. |
| T12 | W5 | Integrar audit_event, permisos, CSRF, retención y limpieza. | P17; logs redactados. |
| T13 | W6 | Ensayar flujo integral con fixture sintético y KMZ autorizado en entorno aislado. | P01–P19 y reporte antes/después. |
| T14 | W6 | Revisión independiente de seguridad, UX, integridad y compatibilidad GPS; preparar decisión de operación. | Gate global de [plan.md](plan.md) con evidencia firmada. |

No se modifica la app Android, la ingesta GPS ni el motor futuro de visitas. Una tarea que requiera alterar esos contratos debe proponer cambio de alcance y actualizar trazabilidad antes de implementarse.
