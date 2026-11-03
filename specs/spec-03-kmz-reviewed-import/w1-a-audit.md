# SPEC-03 — Auditoría técnica de cierre W1-A

**Actualización:** la auditoría original se conserva como evidencia histórica. La [reauditoría W1-A-R](#reauditoría-w1-a-r--2026-11-03) al final de este documento evalúa las correcciones posteriores y sustituye la recomendación original para la rama codex/spec-03-w1a-r.

**Fecha:** 2026-11-03. **Objeto:** worktree codex/spec-03-w1a, base 26efc9a. **Modalidad:** lectura, pruebas y SQL sintético reversible; ningún cambio productivo, commit, push, merge o despliegue.

## A. Resumen ejecutivo

**AUDIT = NOT_READY_FOR_INTEGRATION.** La implementación cubre la estructura base, los permisos nuevos, la API administrativa y las rutas DRAFT. La migración limpia, el upgrade 0015→0016, el rollback inducido y las regresiones ejecutadas pasaron. El resultado W1_A_TECHNICAL_PASS reportado por implementación no se confirma como gate de integración: hay tres hallazgos HIGH reproducibles en integridad y auditoría. La suite W1-A no los detecta. No se identificaron cambios en GPS v2, posiciones históricas ni evaluación de visitas.

La revisión contrastó README, requirements, design, api-contracts, tasks, plan, decisions, test-plan y w1-a-evidence; migraciones 0001–0016, CatalogService, rutas, autenticación, administración de usuarios, Web, pruebas existentes y ADR-003/009/010/011. El diseño W0 propone partes adicionales de W1-B y waves posteriores; se califican fuera del alcance autorizado y no como defectos de W1-A.

## B. Matriz de trazabilidad

| Requisito | Implementación | Prueba | Evidencia | Resultado |
| --- | --- | --- | --- | --- |
| W1-A catálogo persistente: fuente, cliente, establecimiento, pin, grupo, referencias | Migración 0016:16–120; servicio 11–29, 165–233 | catalog-w1a.integration:53–78 | Migración limpia y CRUD básico pasan; referencias archivadas aceptadas (H-02) | PARTIAL |
| W1-A identidad comercial D-01 | 0016:18–50 exige fuente CSV/XLSX autorizada para VERIFIED; servicio 181–194 solo crea CANDIDATE y fuente PENDING | catalog-w1a.integration:53–61, 142–146 | Código KMZ no adquiere autoridad; contrato CSV/XLSX pendiente | PASS |
| W1-A asociación explícita cliente–establecimiento–pin | 0016:75–98, 149–167; servicio 328–388, 475–505 | catalog-w1a.integration:82–96, 118–120 | FK de vínculo funciona; archivados no se excluyen de nuevas asociaciones (H-02) | PARTIAL |
| W1-A rutas/paradas DRAFT D-03 | 0016:122–170; servicio 208–223, 435–565 | catalog-w1a.integration:79–96, 121–125, 136–141 | ACTIVE y CONFIRMED rechazados; no hay escritura de visitas | PASS |
| W1-A versión, actualización selectiva D-08 | Servicio 235–295, 507–543, ETag y FOR UPDATE | catalog-w1a.integration:97–110, 128–133 | Carrera 200/409 y antes/después de customer; preservación de otros campos no probada directamente | PARTIAL |
| W1-A lectura/escritura/confirmación D-07 | 0016:2–8; user-administration:9–22; Web AdminUsers:6–19; servicio 98–131 | catalog-w1a.integration:44–51, 147–153; admin users 42 | Sin auto-grants; denegación de escritura sí, registro de denegación falla con pool lleno (H-01) | PARTIAL |
| W1-A auditoría de operaciones | Servicio 114–132, 226–228, 289–292, 334–347, 362–388 | catalog-w1a.integration:126–133 | Cambios simples auditados; vínculo pierde identidad tras desvinculación (H-03) | FAIL |
| W1-A API/DTO/paginación | Rutas 40–148; servicio 36–77, 144–163, 450–471 | catalog-w1a.integration:31–41, 89–90, 117–121 | Validación y límite 100 presentes; filtros/búsqueda comercial W1-B pendientes; paginación y CSRF negativo sin prueba nueva | PARTIAL |
| W1-A migración limpia/upgrade/rollback | 0016; migration-manager y migration-target | catalog-w1a.integration y catalog-w1a-upgrade.integration | Bases descartables 1121/1122; rollback y repetición pasan | PASS |
| IR-01/02/03 carga, parser y originales | No implementado por alcance W2 | No ejecutado | Documentado en plan/test-plan | OUT_OF_SCOPE |
| IR-04/05 matching y anomalías | No implementado por alcance W3 | No ejecutado | Umbrales D-02 aún por calibrar | OUT_OF_SCOPE |
| IR-06 interfaz de revisión | No implementada por alcance W4 | No ejecutado | Solo allowlist de permisos Web cambió | OUT_OF_SCOPE |
| IR-07 revisión y vínculo comercial completo | Base de candidatos y vínculos manuales; flujo autorizado CSV/XLSX y UI faltan | Cobertura parcial W1-A | D-01 impide declarar conciliación comercial | OUT_OF_SCOPE |
| IR-08 separación grupo/ruta; geometrías de staging | Tablas separadas, estados DRAFT/CANDIDATE; staging no existe | W1-A y GPS integration | Separación base pasa; geometrías de W2 fuera de alcance | PARTIAL |
| IR-09/10 plan, confirmación e idempotencia | No implementados por alcance W5 | No ejecutado | Ningún endpoint KMZ/confirm | OUT_OF_SCOPE |
| IR-11 auditoría completa, TTL, ledger | Capacidades base y audit_event; TTL/ledger futuros | Cobertura parcial W1-A | H-01/H-03; política D-06 pendiente | PARTIAL |
| IR-12 independencia GPS/visitas | Sin FK ni escrituras hacia tablas GPS/visitas; app solo registra rutas nuevas | GPS 45 verificaciones; API/Web 32/41 | Regresión sintética pasa; snapshot de historia productiva no se hizo | PASS |

Los endpoints reales de W1-A coinciden con la sección actual de api-contracts.md:36–40. El documento W0 había propuesto filtros por estado, búsqueda comercial y una vista de cliente con namespace/vínculos; no están en la API y requieren contrato de W1-B. No hay endpoints KMZ, parser, matcher, confirmación o visitas nuevos.

## C. Hallazgos

### H-01 — HIGH — Denegaciones sin auditoría bajo saturación del pool

- **Ubicación:** apps/api/src/catalog/service.ts:98–131, en especial 108–110 y 116–119; pool productivo apps/api/src/db/pool.ts:4–9.
- **Evidencia reproducible:** dos creaciones denegadas en paralelo con pool sintético de máximo dos conexiones y timeout de 250 ms devolvieron [403,403] en 268 ms, con audit_delta=0. Cada escritura retuvo un cliente mientras appendAudit intentó adquirir otro del mismo pool; la excepción se descartó. En producción el pool tiene máximo cinco y timeout de dos segundos, por lo que cinco denegaciones simultáneas pueden reproducir la misma pérdida y demora. La extrapolación a cinco es inferencia del código y configuración, no prueba de carga productiva.
- **Impacto:** faltan eventos de seguridad exigidos por D-07 y se retrasa la respuesta cuando se agota el pool; con un pool sin timeout el patrón puede bloquearse indefinidamente.
- **Recomendación:** liberar/rollback del cliente antes de registrar el rechazo, o registrar de forma no bloqueante con capacidad reservada y garantía verificable. No silenciar el fallo de auditoría.
- **Wave responsable:** corrección W1-A. **Cierre:** prueba de denegaciones concurrentes con pool lleno que compruebe 403 oportunos y un evento por solicitud.

### H-02 — HIGH — Nuevas asociaciones admiten entidades archivadas

- **Ubicación:** apps/api/src/db/migrations/0016_catalog_base.sql:86–98 y 149–167; apps/api/src/catalog/service.ts:198–203 y 475–499. createPin y createStop validan UUID/FK, pero no comprueban estado activo de establecimiento o pin.
- **Evidencia reproducible:** dentro de una transacción sintética se insertó establecimiento con archived_at, pin con state ARCHIVED y luego una parada con ambos IDs; las tres inserciones fueron aceptadas y la consulta devolvió archived_at=true, pin=ARCHIVED, stop=CANDIDATE. Se ejecutó ROLLBACK. El mismo hueco está en los métodos API indicados.
- **Impacto:** el catálogo puede contener paradas candidatas y puntos vinculados a entidades retiradas; el vínculo existe técnicamente pero carece de validez operativa y puede contaminar W1-B/W5.
- **Recomendación:** validar vigencia de todos los destinos dentro de la transacción y cerrar la carrera con bloqueo/condición apropiada; añadir prueba API y DB de referencias archivadas y de archivado concurrente.
- **Wave responsable:** corrección W1-A. **Cierre:** createPin/createStop rechazan destinos archivados y una carrera con archive no produce referencias nuevas hacia ellos.

### H-03 — HIGH — El historial de vínculo comercial no se puede reconstruir

- **Ubicación:** apps/api/src/catalog/service.ts:114–123, 328–347 y 362–388; apps/api/src/db/migrations/0016_catalog_base.sql:75–84.
- **Evidencia reproducible:** el evento catalog.customer.link de la prueba sintética guarda solo version y resource_id del establecimiento; previous_state y next_state son NULL. El customer_id y el motivo quedan únicamente en catalog_customer_establishment. unlinkCustomer borra físicamente esa fila; el evento de creación no conserva qué cliente se vinculó. La consulta de audit_event devolvió exactamente esos campos.
- **Impacto:** tras desvincular, no se puede reconstruir el vínculo aprobado ni su motivo a partir del ledger de auditoría, incumpliendo el objetivo de trazabilidad de D-01/D-08 e IR-11.
- **Recomendación:** registrar ambos IDs, motivo y actor en un evento inmutable de creación dentro de la misma transacción; conservar historial de vínculo con vigencia o una evidencia equivalente verificable.
- **Wave responsable:** corrección W1-A. **Cierre:** prueba de vincular y desvincular que reconstruya cronológicamente ambos extremos y el motivo usando solo datos persistidos.

### M-01 — MEDIUM — Membresía histórica bloquea archivado del grupo

- **Ubicación:** apps/api/src/catalog/service.ts:303–314 y 403–432.
- **Evidencia reproducible:** se cerró temporalmente una membresía sintética con valid_until=now(); la consulta indicó una fila histórica y cero activas. La condición de archive busca cualquier fila de catalog_territory_member, de modo que seguiría devolviendo 409. Se revirtió la transacción.
- **Impacto:** un grupo con miembros pasados no puede archivarse aunque no tenga miembros vigentes.
- **Recomendación:** distinguir dependencias activas de historial que debe conservarse y probar archive después de cerrar membresías.
- **Wave responsable:** corrección W1-A. **Cierre:** archivado permitido o rechazado según regla documentada y prueba con membresía cerrada.

### M-02 — MEDIUM — La suite W1-A deja comportamientos obligatorios sin aserción

- **Ubicación:** apps/api/test/catalog-w1a.integration.mjs:43–153 y catalog-w1a-upgrade.integration.mjs:17–61.
- **Evidencia reproducible:** el test W1-A crea seis recursos, pero solo actualiza customer; no verifica borrado exitoso, conservación de campos no enviados en establishment/stop, paginación con más de una página, Origin/CSRF negativos, IDs ajenos/inexistentes, referencia archivada, denegaciones concurrentes, historial de vínculo ni rollback de una operación de catálogo al fallar audit_event. La suite administrativa prueba grants GPS, no las tres capacidades nuevas.
- **Impacto:** los conteos reportados no sustentan el PASS integral de API/seguridad W1-A.
- **Recomendación:** añadir casos aislados que cubran cada escenario y comprobar estados SQL además del HTTP.
- **Wave responsable:** corrección W1-A. **Cierre:** nueva evidencia ejecutada para los casos listados; no basta con elevar el conteo total.

## D. Validación ejecutada

| Comando/ensayo | Entorno | Resultado |
| --- | --- | --- |
| npm run catalog:w1a:integration --workspace @geops/api | geops_verify_1121, sintética vacía | PASS; incluye migración 0001–0016 |
| npm run catalog:w1a:upgrade:integration --workspace @geops/api | geops_verify_1122, sintética vacía | PASS; 0015→0016, fallo inducido, rollback, conservación de admin/dispositivo e idempotencia |
| npm run test --workspace @geops/api | worktree | 32/32 PASS |
| npm run test --workspace @geops/web | worktree | 41/41 PASS |
| npm run gps:integration --workspace @geops/api | geops_verify_1123 | 45 verificaciones PASS |
| npm run admin:users:integration --workspace @geops/api | geops_verify_1124 | 42 verificaciones PASS |
| tsc --noEmit para API y Web | worktree | Ambos PASS |
| Ensayo independiente de referencias archivadas | geops_verify_1121; transacción con ROLLBACK | INSERT de parada aceptado con establecimiento y pin archivados |
| Ensayo independiente de denegación concurrente | geops_verify_1121; pool 2/250 ms | [403,403], audit_delta=0 |
| Inspección de audit_event de vínculo | geops_verify_1121 | customer_id y motivo ausentes en evento de creación |

Los scripts de integración W1-A no tienen un contador de aserciones propio; no se convierte su PASS en un número inventado. Los 32/41 son pruebas de suites existentes; 45/42 son verificaciones reportadas por scripts de integración. No se probaron posiciones/visitas productivas, restauración desde backup real, carga, rendimiento ni flujo KMZ.

## E. Migraciones y compatibilidad

Imagen local PostGIS 18-3.6, bases geops_verify_1121–1124 dentro de contenedor descartable. El migrador aplicó 16 scripts desde cero en 1121/1123/1124; en 1122 se cargó 0015 sintético y solo 0016 se aplicó después. Una colisión inducida hizo fallar 0016 sin dejar objetos parciales ni alterar el registro de 15 migraciones; al retirarla, aplicó y una nueva ejecución no aplicó nada. En 1123 el comando guardado de migrate verificó el destino y, al repetirse, informó cero migraciones. La prueba de upgrade conservó un admin y un dispositivo sintéticos y no concedió permisos catalog.*.

DDL de 0016 crea solo tablas nuevas y amplía el CHECK de admin_permission; no modifica position_event, políticas, sesiones GPS ni tablas de visitas. PostgreSQL/PostGIS, FK, GiST, SRID 4326, unicidad de fuente/referencia e índices básicos están presentes. La autoridad comercial puede añadirse en W1-B sin reemplazar claves base; aún faltan diccionario, flujo de autorización, vigencia/procedencia comercial y pruebas con muestra aprobada. No se midieron locks de migración ni restore desde backup, así que compatibilidad operativa de despliegue permanece sin verificar.

## F. Gates A-01–A-10

| Gate | Resultado | Fundamento |
| --- | --- | --- |
| A-01 Alcance W1-A | PARTIAL | Entidades/API presentes; H-02/H-03 impiden cierre de integridad/traza. |
| A-02 Modelo de datos | FAIL | H-02 permite referencias archivadas. |
| A-03 Migración reproducible | PASS | Limpia, upgrade, rollback y repetición aislados. |
| A-04 Seguridad y permisos | FAIL | Denegación efectiva, pero H-01 pierde auditoría bajo concurrencia. |
| A-05 Contratos API | PARTIAL | Endpoints principales, validación y ETag presentes; H-02/H-03 y cobertura parcial. |
| A-06 Rutas y visitas aisladas | PASS | Estados DRAFT/CANDIDATE, ninguna escritura de visitas/GPS; regresión GPS pasa. |
| A-07 Pruebas y regresión | PARTIAL | Suites pasan, pero M-02 deja escenarios W1-A sin probar. |
| A-08 Calidad técnica | PARTIAL | Transacciones y módulos claros; H-01 y M-01 afectan operación. |
| A-09 Compatibilidad W1-B | PARTIAL | Claves base evolucionables; referencia a archivados e historial de vínculo bloquean reconciliación segura. |
| A-10 Git controlado | PASS | Rama/worktree aislados, cambios locales sin commit, push, merge ni despliegue. |

## G. Riesgos residuales

**Bloqueantes:** H-01, H-02 y H-03. Deben resolverse y revalidarse antes de integración. **No bloqueantes pero abiertos:** M-01, M-02, contrato comercial W1-B, calibración D-02, política D-06, matriz de roles D-07, campos D-08 y ensayo de restore/rendimiento previo a despliegue. El resultado de regresión GPS es sintético; no demuestra por sí solo invariancia de datos históricos reales.

## H. Recomendación y estado final

**NOT_READY_FOR_INTEGRATION.** Mantener W1-A en la rama aislada; corregir hallazgos HIGH en una ejecución autorizada posterior y repetir gates A-01, A-02, A-04, A-05, A-07 y A-09. Esta auditoría no modifica decisiones D-01–D-08 ni inicia W1-B.

| Dimensión | Estado |
| --- | --- |
| IMPLEMENTATION (reportado) | W1_A_TECHNICAL_PASS |
| AUDIT (independiente) | NOT_READY_FOR_INTEGRATION |
| MERGE_AUTHORIZED | NO |
| PUSH_AUTHORIZED | NO |
| DEPLOY_AUTHORIZED | NO |

## Reauditoría W1-A-R — 2026-11-03

**Rama evaluada:** codex/spec-03-w1a-r. [Evidencia detallada](w1-a-r-evidence.md). El alcance autorizado fue corregir los tres HIGH y los dos MEDIUM, sin iniciar W1-B ni otras waves. Se ejecutaron tests en PostgreSQL/PostGIS sintético y suites existentes; el lint global heredado sigue fallando. Las ubicaciones siguientes son las líneas de la rama W1-A-R después del formateo dirigido.

| ID | Severidad original | Causa raíz | Corrección | Regresión/evidencia | Estado |
| --- | --- | --- | --- | --- | --- |
| H-01 | HIGH | Auditoría de rechazo intentaba adquirir conexión mientras la transacción aún la retenía y descartaba errores. | CatalogService:143–253 libera conexión antes de persistir rechazo; fallo de audit_event produce 503 y sin mutación; índice único por request_id en 0017:2–3. | Ocho rechazos paralelos generaron ocho eventos; reintento con mismo request_id, uno; fallo inyectado, 503; conflicto 409 auditado. | CERRADO |
| H-02 | HIGH | FK permitía destinos archivados. | Triggers de 0017:5–70 validan y bloquean fuente, establecimiento, cliente, pin y ruta antes de nuevas asociaciones. | API rechaza archivados; tres carreras archive/stop preservaron integridad; 0016→0017 conservó parada histórica y rechazó otra nueva. | CERRADO |
| H-03 | HIGH | El vínculo se borraba sin evento con ambos extremos y motivo. | CatalogService:581–605 y 668–692 escribe eventos transaccionales con IDs, actor, fecha, estado y motivo antes/después. | Creación, consulta, desvinculación y revinculación concurrente reconstruidas desde audit_event; una revinculación gana y otra devuelve 409. | CERRADO |
| M-01 | MEDIUM | archive contaba membresías históricas como activas. | CatalogService:508 filtra valid_until IS NULL. | Grupo se archivó tras cerrar membresía; fila histórica permaneció. | CERRADO |
| M-02 | MEDIUM | Faltaban aserciones de seguridad, CRUD, concurrencia y rollback. | Nuevas pruebas catalog-w1ar.integration.mjs y catalog-w1ar-upgrade.integration.mjs. | Cubren permisos, 401/403/404/409/422/503, CSRF/Origin, ETag, patch selectivo, paginación, borrado, historial, carreras, auditoría y rollback. | CERRADO para W1-A-R |

**Límite de empresa:** GEOPS tiene una sola empresa operativa según 0015; no existe una segunda empresa ni tenant_id por fila. Las denegaciones guardan company_scope=SINGLE_COMPANY y operating_tenant_id si se estableció el singleton. No se inventó un identificador de empresa ni se amplió el modelo a multiempresa. La prueba usa IDs inexistentes para acceso fuera del catálogo; la prueba entre empresas es no aplicable al modelo actual. Cada nuevo request_id HTTP se audita como intento distinto; el reintento interno del mismo request_id no duplica el evento.

### Gates A-01–A-10 revaluados

| Gate | Estado | Evidencia |
| --- | --- | --- |
| A-01 Alcance W1-A | PASS | Entidades/API conservadas y cinco hallazgos cerrados. |
| A-02 Modelo de datos | PASS | 0017 protege destinos activos y conserva historia previa. |
| A-03 Migración reproducible | PASS | Limpia 0001–0017, upgrades 0015→0017 y 0016→0017, rollback e idempotencia aislados. |
| A-04 Seguridad y permisos | PASS | Denegación durable bajo concurrencia, 503 seguro si audit_event falla, grants/revocación catalog.* y Origin/CSRF probados. |
| A-05 Contratos API | PASS | CRUD W1-A, patch selectivo, ETag, paginación y errores comprobados; endpoints KMZ futuros permanecen fuera de alcance. |
| A-06 Rutas y visitas aisladas | PASS | DRAFT/CANDIDATE, sin escritura GPS/visitas; 45 verificaciones GPS pasan. |
| A-07 Pruebas y regresión | PARTIAL | Todas las suites y build pasan; npm run lint falla con 30 errores heredados frente a 32 del worktree W1-A. Chequeo dirigido de catálogo y pruebas W1-A-R pasa. |
| A-08 Calidad técnica | PASS | Transacciones liberan recursos antes de auditar rechazo; bloqueo DB cierra carrera; M-01 resuelto. |
| A-09 Compatibilidad W1-B | PASS | Migración aditiva, historia previa conservada y base comercial sigue sin atribuir autoridad a KMZ. |
| A-10 Git controlado | PASS | Rama/worktree aislados, commit local W1-A-R, sin push/merge/despliegue; árbol limpio al cierre. |

### Gates específicos W1-A-R

| Gate | Estado | Fundamento |
| --- | --- | --- |
| W1AR_AUDIT_CONCURRENCY | PASS | Ocho denegaciones/ocho eventos, reintento sin duplicado, 503 ante fallo de auditoría. |
| W1AR_ARCHIVED_REFERENCES | PASS | Rechazo de archivados, carreras y lectura histórica verificadas. |
| W1AR_LINK_HISTORY | PASS | Dos extremos, actor, fechas y motivos recuperables tras desvincular/revincular. |
| W1AR_MEDIUM_FINDINGS | PASS | M-01 corregido; M-02 cubierto por regresiones nuevas. |
| W1AR_DATABASE_INTEGRITY | PASS | Triggers con locks, FK, migración aditiva, upgrades y rollback. |
| W1AR_SECURITY | PASS | Auth/capacidades/CSRF/origen, denegación auditada y fallo cerrado; límite de empresa única explícito. |
| W1AR_FULL_REGRESSION | PARTIAL | Tests, GPS, administración, build, typecheck y secret scan pasan; lint global heredado falla. |
| W1AR_A01_A10_REAUDIT | PARTIAL | Nueve gates PASS; A-07 PARTIAL por lint global. |
| W1AR_READY_FOR_INTEGRATION | PARTIAL | Tres HIGH cerrados y ninguna regresión crítica; queda pendiente resolver o aceptar el gate lint global. |

**Recomendación actual:** READY_WITH_CONDITIONS. Una revisión del responsable debe resolver o aceptar expresamente el fallo de lint heredado antes de declarar W1AR_READY_FOR_INTEGRATION=PASS. Esto no autoriza integración ni despliegue. W1-B y W2–W6 siguen bloqueadas.

| Dimensión | Estado W1-A-R |
| --- | --- |
| IMPLEMENTATION | Correcciones H-01–H-03 y M-01–M-02 verificadas |
| AUDIT | READY_WITH_CONDITIONS |
| MERGE_AUTHORIZED | NO |
| PUSH_AUTHORIZED | NO |
| DEPLOY_AUTHORIZED | NO |
