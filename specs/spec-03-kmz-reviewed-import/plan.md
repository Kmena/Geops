# Plan por waves — SPEC-03

**Estado W0:** W0_PARTIAL. **Implementación:** W1-A-R2 preparada en rama aislada; merge local aún no autorizado. W1-B y W2–W6 pendientes. D-01–D-08 quedaron registradas el 2026-11-03. Evidencia histórica en [w1-a-evidence.md](w1-a-evidence.md) y [w1-a-r-evidence.md](w1-a-r-evidence.md); preparación de integración en [w1-a-r2-evidence.md](w1-a-r2-evidence.md). Dependencias PRD/SPEC-00/01/02 se verifican de nuevo al iniciar cada wave.

| Wave | Objetivo y alcance | Entrada / bloqueo | Módulos previstos y contratos | Pruebas / cierre | Riesgo principal |
| --- | --- | --- | --- | --- | --- |
| W0 Auditoría y decisiones | Registrar D-01–D-08, medir KMZ sin modificarlo, verificar coherencia y preparar diseño W1. | Decisiones aprobadas para documentación; muestra comercial y política siguen pendientes. | Solo estos ocho documentos; futuro OpenAPI de diseño tras completar esquema. | G0-01–G0-08 abajo; G0-04 PARTIAL. | DDL de customer no congelable sin catálogo autorizado. |
| W1 Catálogo persistente | W1-A implementada y corregida: infraestructura base, API, rutas DRAFT, catalog_revision, permisos y asociación con destinos activos. W1-B pendiente: fuente comercial autorizada e identidad VERIFIED. | W1-A-R2 autorizada solo para preparación; migraciones 0019/0020 verificadas en bases sintéticas; muestra/diccionario D-01 pendiente. | Migraciones 0019/0020 y servicio de catálogo; contratos en [api-contracts.md](api-contracts.md#dependencias-de-catálogo-w1). | [Evidencia W1-A-R2](w1-a-r2-evidence.md); lint dirigido PASS, deuda heredada fuera de alcance. P19/P08/P11/P17/P18 completos permanecen abiertos para waves posteriores. | Esquema comercial externo desconocido y validación de fuente autorizada. |
| W2 Parser y staging | Upload streaming, cuotas, ZIP/XML seguro, árbol y registros originales, TTL/hash. | W1 modelo de catálogo o contrato mínimo de candidatos; límites D-05, almacenamiento privado. | Servicio parser/import-session en apps/api/src; nuevas migraciones de staging; POST/GET upload y estado. | P01–P05/P16, fuzz/ZIP malicioso, cero diffs operativos. | ZIP bomb, XXE, fuga de datos. |
| W3 Normalización y matching | Comparación determinista, explicación, candidatos, rebase y detección intraarchivo. | W2; autoridad D-01 y umbrales D-02. | Servicio matcher y consultas PostGIS; GET records, rematch. | P05–P09; paridad de clasificación con fixture; no fusiones automáticas. | Falsos positivos/negativos. |
| W4 Revisión Web | Tabla, panel triple, mapa, filtros, acciones, concurrencia de editores. | W3 endpoints y autorización; D-03/D-04 para UX de rutas/polígonos. | apps/web/src/imports/ propuesto; rutas Web protegidas; PATCH/bulk. | P07/P10/P11, accesibilidad, sin teselas, dos admins. | Correcciones invisibles o confusas. |
| W5 Confirmación y auditoría | Plan/digest, transacción, ledger, idempotencia, permisos, recuperación y retención. | W1 catalog_revision usado por todos los escritores; W4 decisiones; D-06/D-07/D-08. | Servicio commit en apps/api/src/imports/ propuesto; migraciones ledger; validate/confirm/result; audit_event. | P08/P12–P15/P17/P18; rollback y timeout con DB real. | Publicación parcial, carrera, reintento duplicado. |
| W6 Validación integral | Ensayo E2E en DB aislada con fixture autorizado del KMZ; reconciliar conteos y desempeño, documentar salida. | W1–W5 cerradas; tratamiento de datos y hash aprobados; sin despliegue implícito. | Fixtures y pruebas en apps/api/test y apps/web/src/imports; reporte de evidencia. | P01–P19; diff antes/después, resultados reproducibles y revisión independiente. | Datos reales revelados o asumidos correctos. |

## Secuencia y compatibilidad

W0 → W1 → W2 → W3 → W4 → W5 → W6. W2 y W3 pueden desarrollar parsers/matcher con fixtures sintéticos mientras W1 cierra catálogo, pero ninguna publicación hasta pasar W5. Si otra SPEC implementa catálogo/rutas antes de W1, W1 se convierte en auditoría de compatibilidad y adaptación; no crear duplicados. Contratos nuevos se versionan bajo /v1/admin y solo se incorporan a packages/api-contracts una vez autorizados. W0 no reservó número de migración; W1-A-R2 propone 0019/0020 tras las migraciones GPS/MDM vigentes, con pruebas de restore sintético y sin merge final.

## Evaluación de gates W0 — 2026-11-03

| Gate | Estado | Evidencia / límite |
| --- | --- | --- |
| G0-01 Decisiones | PASS | D-01–D-08 aprobadas por responsable y registradas con fecha, consecuencias, riesgos y trazas en [decisions.md](decisions.md). |
| G0-02 Coherencia SDD | PASS | Requisitos, diseño, API, pruebas, plan y tareas reflejan fuente comercial, bandas de candidatos, staging de geometrías, permisos y actualización selectiva. Enlaces y trazas verificados. |
| G0-03 Dependencias W1 | PASS | [design.md](design.md#1-diagnóstico-actual) distingue PostGIS/auth/GPS existentes de catálogo/rutas ausentes; Q-11 y política documentados. |
| G0-04 Diseño W1 | PARTIAL | Entidades, migraciones, contratos, permisos, compatibilidad y pruebas preparados en [design.md](design.md#8-preparación-técnica-de-w1--sin-implementación). DDL de identidad comercial y contrato CSV/XLSX no se congelan sin muestra/diccionario autorizados. |
| G0-05 Riesgos | PASS | [decisions.md](decisions.md#riesgos-y-controles) y este plan cubren duplicados, integridad, ZIP, privacidad, permisos y regresión GPS. |
| G0-06 Pruebas | PASS | [requirements.md](requirements.md) IR-01–IR-12 trazan [test-plan.md](test-plan.md) P01–P19; no se atribuye ejecución a casos futuros. |
| G0-07 Pendientes | PASS | D-01 muestra, D-02 calibración, D-03 calendarios, D-05 recursos, D-06 política, D-07 grants y D-08 campos figuran como pendientes y con wave afectada. |
| G0-08 Alcance documental | PASS | Solo se editaron documentos SPEC-03; sin código, migraciones, datos, despliegue, commit o push. |

**Resultado histórico de W0:** W0_PARTIAL por G0-04. La autorización posterior abrió únicamente W1-A. El trabajo de identidad comercial W1-B requiere muestra/diccionario autorizado D-01. D-02 se resuelve antes de W3; D-03 antes de activar rutas; D-05 antes de abrir upload W2; D-06 antes de habilitar limpieza/retención W2/W5; D-07 antes de otorgar permisos; D-08 al definir campos comerciales. Ninguna pendiente habilita importación operativa anticipada.

## Gate de salida global

Solo se declara lista para operación una implementación con contratos revisados, pruebas P01–P19, cuotas medidas, revisión de seguridad, restauración ensayada, autoridad comercial resuelta, retención aprobada y autorización de despliegue separada. El PASS técnico de W1-A no habilita operación. El informe de W6 distinguirá fixture sintético, archivo real de referencia y datos productivos. **W1-B y W2–W6 pendientes.**
