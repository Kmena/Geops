# SPEC-03 — W1-A-R2: preparación de integración local

**Estado:** `W1AR2_READY_FOR_LOCAL_INTEGRATION`
**Fecha:** 2026-11-03
**Rama aislada:** `codex/spec-03-w1a-r2`
**Commit de correcciones:** `cae70d0a4ca187543c684a12eded0c87ae3630ef`
**Base de integración:** `codex/geops-integration` en `90ab9e9f10f6377e739e8bb64da9aef378c59fe2`
**Origen auditado:** `codex/spec-03-w1a-r` en `6ee99d7fe6683fdb1981774e0dd503874817336c`

El commit origen se aplicó **sin commit automático** en un worktree aislado desde la base de integración. Se reconciliaron allí los conflictos y se creó el commit local de correcciones. **No hubo merge final hacia `codex/geops-integration`.** La rama destino y sus tres cambios locales GPS permanecen intactos; el checkout físico principal también conserva sus cambios y archivos sin seguimiento. El worktree de origen y su commit auditado no se modificaron.

## Causas y correcciones

| Bloqueo | Causa | Corrección en R2 |
| --- | --- | --- |
| Lint de pruebas | El lint raíz omitía `catalog-w1a.integration.mjs` y `catalog-w1a-upgrade.integration.mjs`; Biome detectó dos errores `format` nuevos. | Se formatearon ambos archivos y se pasó lint dirigido sobre todos los archivos TS/TSX/MJS cambiados. |
| `app.ts` | Registro concurrente de GPS continuity, MDM real y rutas de catálogo en el mismo bloque. | Se añadieron solo `registerCatalogRoutes` y `catalog?: CatalogService`; quedaron el registro GPS, el inventario MDM, autenticación, CSRF, hooks y handlers existentes. |
| `main.ts` | Inicialización concurrente de GPS continuity/MDM real y el nuevo servicio del catálogo. | Se añadió `CatalogService` a `createApp`; se conservaron scheduler GPS, monitor, MDM real, timers, gate y cierre. |
| Migraciones | El destino ya usa 0016/0017 para GPS y 0018 para MDM. El recuperador supervisado acepta un catálogo cerrado de 18 versiones. | Catálogo base **0019**, integridad **0020**. Se actualizaron pruebas y referencias actuales; el recuperador admite 20 versiones, comprueba estructura, permisos y triggers, y preserva el inventario existente. |

Los documentos históricos W1-A/W1-A-R conservan los números 0016/0017 de las ejecuciones originales. Los documentos de diseño y plan actuales y las pruebas R2 usan 0019/0020. No se alteraron las decisiones D-01–D-08 ni se añadió W1-B.

## Migraciones, ledger y reproducibilidad

- `0016_gps_continuity_alerts.sql`, `0017_gps_continuity_evaluated_at.sql` y `0018_mdm_inventory.sql` son idénticos a la base `90ab9e9`.
- `0019_catalog_base.sql` y `0020_catalog_integrity.sql` conservan exactamente los bytes SQL del commit auditado antes de renumerar. Sus SHA-256 son `15a1355ea33cff47a1af6ade8b838ba5961a872bf54df20bc87e91ccfba0f667` y `5f1255c6cf96640e3f734d4b8c09d160a22712af625e74e49560a4bcc183cc2c`. `.gitattributes` fija LF solo para estas dos migraciones nuevas, estabilizando el checksum sin cambiar el tratamiento de migraciones existentes.
- La prueba en `geops_verify_110311` confirmó 20 entradas en `geops_schema_migrations`; los checksums de 0019/0020 coincidieron con los archivos fuente. El build copió ambos SQL a `dist` con hashes idénticos.
- La instalación limpia aplicó 0001–0020. La actualización desde el último esquema de integración 0018 aplicó 0019/0020 sin conceder permisos `catalog.*`; el choque SQL inducido dejó 18 entradas y sin objetos parciales, y el reintento completó 20. La prueba 0019→0020 indujo fallo, verificó rollback e historia conservada, y luego completó 0020. Recuperación supervisada 0014→0020 y 0018→0020: PASS.
- Las pruebas usaron exclusivamente bases `geops_verify_*` en un contenedor `postgis/postgis:18-3.6` sin volumen, ligado a localhost. El contenedor `geops_w1ar2_pg_1103` fue detenido y eliminado con `--rm` al terminar. No se consultó ni modificó una base persistente.

## Validaciones

| Verificación | Resultado |
| --- | --- |
| Lint explícito de los dos archivos inicialmente fallidos | PASS; 0 errores. |
| Biome dirigido a 18 archivos de código cambiados | PASS; 0 errores, 0 advertencias. |
| Lint raíz comparado con la base | Base 31 errores/12 advertencias; R2 26 errores/12 advertencias. Ningún error nuevo por archivo y regla; cinco errores `format` heredados desaparecieron al actualizar pruebas afectadas. Los 26 errores restantes son deuda fuera de alcance. |
| Catálogo W1-A y W1-A-R, instalación limpia y upgrades | PASS; cuatro scripts. Las pruebas limpia, 0018→0020 y 0019→0020 se repitieron después de fijar los bytes SQL finales. |
| Migración GPS 0016→0020 y GPS continuity | PASS; 44 aserciones en continuity. |
| Integración MDM y administración de usuarios | PASS; administración 42 verificaciones. |
| Recuperación supervisada y migración de destino | PASS; 54 checks desde 0014, escenario 0018→0020 y 2 pruebas de destino. |
| Suite API y suite Web | PASS; Web 48 pruebas. |
| Typecheck y build final | PASS; API, Web y contratos. |
| Escaneo de secretos | PASS; 461 archivos elegibles en la ejecución final. |
| `git diff --cached --check` antes del commit | PASS. |

Las primeras ejecuciones locales de Vite y del escaneo encontraron `spawn EPERM` bajo el sandbox; se repitieron con el permiso de ejecución necesario y pasaron. Una primera prueba administrativa usó una base vacía y una primera invocación del migrador omitió las confirmaciones de destino exigidas por GEOPS; ambas se repitieron sobre la base sintética correctamente preparada y pasaron. No corresponden a fallos de código.

## Gates R2

| Gate | Estado | Evidencia |
| --- | --- | --- |
| R2-01 | PASS | Rama y worktree aislados; destino, checkout principal y origen preservados. |
| R2-02 | PASS | Lint dirigido 0/0; delta raíz sin errores nuevos. |
| R2-03 | PASS | Diff final de `app.ts`/`main.ts` agrega únicamente catálogo a la base y preserva GPS/MDM. |
| R2-04 | PASS | Numeración única 0001–0020; GPS/MDM intactos. |
| R2-05 | PASS | Ledger sintético de 20 entradas y checksums 0019/0020 exactos; copia `dist` exacta. |
| R2-06 | PASS | Catálogo limpio y upgrades con rollback y ausencia de grants. |
| R2-07 | PASS | Migración y continuity GPS; MDM preservado. |
| R2-08 | PASS | Build y typecheck finales. |
| R2-09 | PASS | Escaneo de secretos, permisos por defecto y pruebas administrativas. |
| R2-10 | PASS | Commit aislado `cae70d0`; rama destino sin merge; pruebas y estrategia reproducibles. |

## Riesgos y límites

La evidencia histórica afirma que W1-A no se desplegó sobre datos reales y no se encontró evidencia de 0016/0017 de catálogo aplicada en un entorno persistente. No se inspeccionaron ledgers operativos; antes de cualquier despliegue deberá verificarse ese hecho en el entorno correspondiente. Si la rama de integración avanza desde `90ab9e9` o cambian sus archivos locales, se repetirán los gates sobre la nueva base. La autorización actual termina con esta preparación y no incluye merge final, push ni despliegue.

`MERGE_AUTHORIZED = NO`
`PUSH_AUTHORIZED = NO`
`DEPLOY_AUTHORIZED = NO`
`W1_B_NOT_AUTHORIZED`
`W2_W6_NOT_AUTHORIZED`
