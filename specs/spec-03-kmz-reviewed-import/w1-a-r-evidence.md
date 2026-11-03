# SPEC-03 — Evidencia de corrección W1-A-R

**Corte:** 2026-11-03. **Rama/worktree:** codex/spec-03-w1a-r, creado desde 26efc9a y poblado solo con los archivos W1-A de SPEC-03. El worktree W1-A original permaneció intacto. No se tocó staging, GPS histórico ni ninguna otra aplicación.

## Cambios

| Hallazgo | Causa raíz y corrección | Prueba y resultado |
| --- | --- | --- |
| H-01 HIGH | CatalogService retenía un cliente de pool mientras appendAudit intentaba adquirir otro y descartaba el fallo. Ahora hace rollback y libera el cliente antes del evento de rechazo. Registra actor, alcance de empresa única, tenant operativo si existe, operación, recurso/ID y código de motivo. El índice único de 0017 evita duplicar el evento para el mismo request_id. Si falla la escritura de auditoría devuelve 503, no confirma un rechazo 403 sin evidencia, y no muta el catálogo. | catalog-w1ar.integration: ocho denegaciones concurrentes produjeron ocho eventos y 403; el mismo request_id reintentado conservó un evento; fallo inyectado de auditoría produjo 503 sin nueva fila. Conflicto 409 auditado tras rollback. |
| H-02 HIGH | FK verificaba existencia, no estado activo. 0017 añade triggers de inserción/cambio de destino que toman FOR SHARE sobre fuente, establecimiento, cliente, pin y ruta activa en borrador. El bloqueo compite con archive y evita nuevas asociaciones hacia archivados. | API rechaza fuente, establecimiento, cliente y pin archivados; tres carreras archive/stop dejaron cero referencias nuevas inválidas. Upgrade 0016→0017 conservó una parada histórica preexistente y rechazó otra nueva. |
| H-03 HIGH | El evento de creación del vínculo carecía de customer_id y motivo; DELETE eliminaba la única fila que los conservaba. La creación y la desvinculación ahora escriben eventos transaccionales con ambos IDs, actor, fechas y motivos, y la desvinculación incluye los datos originales del vínculo. | Crear, consultar audit_event, desvincular, reconstruir y revincular concurrentemente: una creación y un 409; dos eventos de creación y uno de desvinculación con datos completos. |
| M-01 MEDIUM | archive consultaba también miembros de grupo vencidos. La dependencia ahora filtra valid_until IS NULL. | Se cerró membresía, se archivó grupo y la fila histórica quedó conservada. |
| M-02 MEDIUM | El test original no ejercitaba fallos y bordes obligatorios. Se añadió catalog-w1ar.integration y upgrade específico. | Cubren referencias archivadas, carreras, ETag, cambios selectivos, paginación, 401/403/404/409/422/503 relevantes, CSRF/Origin, borrado de parada, rollback ante fallo de audit_event y grants/revocación catalog.* por servicio admin. |

La migración 0017_catalog_integrity.sql es aditiva: índice parcial de auditoría y tres triggers sobre asociaciones nuevas. No reescribe datos ni altera 0016. El servicio conserva referencias históricas existentes; el test de upgrade demuestra que una parada previa con destinos archivados sigue legible. No se inventan fechas o autores de vínculos ya eliminados antes de esta corrección; W1-A nunca se desplegó sobre datos reales.

## Entorno y comandos

Se usó un contenedor descartable postgis/postgis:18-3.6, solo bases geops_verify_1201–1210 con GEOPS_DATA_MODE=synthetic. El contenedor se retira al finalizar. Los tests nuevos rechazan bases no vacías o con otro nombre.

| Validación | Resultado |
| --- | --- |
| catalog:w1a:integration | PASS, migración limpia 0001–0017 |
| catalog:w1ar:integration | PASS en geops_verify_1210; H-01–H-03 y M-01–M-02 |
| catalog:w1a:upgrade:integration | PASS en geops_verify_1206; 0015→0017, fallo inducido y rollback |
| catalog:w1ar:upgrade:integration | PASS en geops_verify_1205; 0016→0017, fallo inducido, historia conservada, nueva asociación inválida rechazada |
| npm run gps:integration --workspace @geops/api | PASS, 45 verificaciones en geops_verify_1208 |
| npm run admin:users:integration --workspace @geops/api | PASS, 42 verificaciones en geops_verify_1209 |
| npm run test | PASS; API 32, Web 41, contratos 5, migración-target 2, restore 1 y replica-check 2 |
| npm run build | PASS; contratos, API y Web |
| Typecheck API/Web | PASS |
| npm run security:scan | PASS, 405 archivos elegibles |
| Biome dirigido a apps/api/src/catalog y dos pruebas W1-A-R | PASS, cero errores |
| npm run lint | FAIL heredado: 30 errores, 12 advertencias; W1-A original reporta 32 errores y 12 advertencias. No se editaron módulos ajenos para hacer pasar este gate. |

La primera preparación de geops_verify_1208 falló durante ejecución simultánea de tareas; el migrador revirtió todo (no quedó geops_schema_migrations). La ejecución secuencial posterior aplicó 17 migraciones y la regresión GPS pasó. Una ejecución inicial de catalog:w1ar:integration falló por fixture de paginación con un solo cliente activo; se corrigió el fixture y se repitió en base nueva. La prueba de fallo de auditoría imprime únicamente el código PostgreSQL sintético P0001, sin datos sensibles.

## Alcance y límites

GEOPS usa un único ámbito empresarial conforme a 0015_single_tenant_admin.sql; no existen IDs de empresa por fila ni un segundo tenant real para probar acceso cruzado. El evento registra company_scope=SINGLE_COMPANY y operating_tenant_id cuando la fila singleton está establecida. La prueba usa un ID inexistente para el acceso a objeto ajeno, pero el aislamiento entre empresas es no aplicable en el esquema actual. No se amplió a multiempresa.

La deduplicación de auditoría aplica al mismo request_id del servidor. Un nuevo HTTP request_id representa un nuevo intento y se audita por separado. W1-A no introdujo Idempotency-Key para escrituras de catálogo; la confirmación idempotente de importaciones sigue en W5. Los datos del KMZ, el catálogo comercial autorizado y visitas operativas siguen fuera de alcance.

## Reauditoría

H-01, H-02, H-03, M-01 y M-02 están cerrados para el alcance W1-A-R con pruebas de API, DB y regresión. A-01–A-06, A-08–A-10 pasan; A-07 permanece PARTIAL exclusivamente por el lint global heredado. Los detalles y gates W1AR están en [w1-a-audit.md](w1-a-audit.md#reauditoría-w1-a-r--2026-11-03).

**Recomendación:** READY_WITH_CONDITIONS. La integración no queda autorizada por este informe; requiere resolver o aceptar expresamente el gate global de lint y revisión de la evidencia. No hay autorización de push, merge o despliegue.
