# SPEC-03 — Integración local W1-A-R / W1-A-R2

**Estado final:** `W1AR_LOCAL_INTEGRATION_PASS`
**Fecha:** 2026-11-03
**Rama destino:** `codex/geops-integration`
**SHA base:** `90ab9e9f10f6377e739e8bb64da9aef378c59fe2`
**SHA integrado y validado:** `98e1c1f39546c15e6d37b38b5d3997c936ec8ad7`
**Origen auditado:** `codex/spec-03-w1a-r` / `6ee99d7fe6683fdb1981774e0dd503874817336c`

## Integración Git y preservación

La rama `codex/spec-03-w1a-r2` se preparó desde el SHA base en un worktree aislado. Su commit de correcciones es `cae70d0a4ca187543c684a12eded0c87ae3630ef`; el informe R2 se registró en `dffc59b0e0c124831be2e74162414bf9bef84d4e`. Con aprobación explícita, `codex/geops-integration` avanzó por **fast-forward local** desde `90ab9e9` hasta `dffc59b`. El checkout Windows mostró 11 errores de formato por CRLF en scripts `.mjs` integrados. El commit `98e1c1f` fijó LF solo para esos scripts; se normalizaron sus copias de trabajo, sin cambio de blobs ni de pruebas, y la rama destino avanzó por otro fast-forward a ese SHA. No se creó merge commit.

Antes y después, el checkout destino mantuvo sus dos archivos GPS modificados y `apps/web/src/gps/policy-time-zones.ts` sin seguimiento. Ninguno se añadió a los commits de integración. El checkout físico principal `codex/spec-02-wave-1` y el worktree origen permanecieron intactos. La rama destino quedó **ahead 3** de `origin/codex/geops-integration`, sin push. La rama aislada coincide con el SHA de código integrado antes de este informe de cierre.

Los conflictos de `apps/api/src/app.ts` y `apps/api/src/main.ts` se resolvieron en R2 agregando solo el registro e inicialización del catálogo a la base GPS/MDM; el diff contra `90ab9e9` no elimina rutas, hooks, autenticación, monitor GPS, MDM real ni timers. Las migraciones nuevas son `0019_catalog_base.sql` y `0020_catalog_integrity.sql`; las migraciones GPS 0016/0017 y MDM 0018 no cambiaron. [Detalle de correcciones y hashes](w1-a-r2-evidence.md).

## Validaciones posteriores al fast-forward

| Verificación | Resultado |
| --- | --- |
| Lint dirigido de los 18 archivos TS/TSX/MJS integrados | PASS: 0 errores, 0 advertencias. El paso inicial sobre el checkout Windows marcó 11 archivos por CRLF; se corrigió con `98e1c1f` y se repitió con PASS. |
| Lint raíz en el checkout destino | 0 errores, 12 advertencias heredadas. Comparación previa en worktree aislado: base 31/12, R2 26/12, sin errores nuevos por archivo y regla. |
| Catálogo W1-A y W1-A-R | PASS: cuatro scripts en bases sintéticas independientes. Instalación limpia, permisos, CRUD solo DRAFT, auditoría, rollback, historia e idempotencia. |
| Migraciones | PASS: 0018→0020 y 0019→0020 con fallo inducido y rollback. Ledger sintético de 20 entradas; checksums 0019/0020 iguales a los SQL fuente. Recuperación supervisada 0018→0020 PASS. |
| API y Web | PASS: suites de ambos workspaces; Web 49 pruebas, incluidos los cambios GPS locales preservados. |
| GPS, MDM y administración | PASS: migración GPS hasta 0020, GPS continuity 44 aserciones, MDM y administración de usuarios 42 verificaciones. |
| Build y typecheck | PASS en API, Web y contratos. |
| Escaneo de secretos y prueba de destino de migración | PASS: 462 archivos elegibles y 2 pruebas de destino. |
| Integridad Git | PASS: fast-forward, SHA comprobado, `git diff --check` del rango integrado, sin archivos GPS locales en commits. |

Las pruebas SQL se ejecutaron solo en bases `geops_verify_*` de un contenedor `postgis/postgis:18-3.6` sin volumen, ligado a localhost. El contenedor efímero `geops_w1ar_merge_pg_1103` se detuvo y eliminó con `--rm`. No se consultaron ni migraron bases operativas.

## Gates de cierre

| Gate | Estado | Evidencia |
| --- | --- | --- |
| I-01 | PASS | `6ee99d7` verificado; correcciones R2 trazables por commits. |
| I-02 | PASS | Checkout principal y tres cambios GPS del destino preservados. |
| I-03 | PASS | Lint dirigido 0/0 y sin errores nuevos atribuibles a W1-A-R2. |
| I-04 | PASS | Fast-forward local correcto hasta `98e1c1f`; sin merge commit ni trabajo ajeno. |
| I-05 | PASS | Cuatro pruebas de catálogo e integración W1-A/W1-A-R. |
| I-06 | PASS | Suites API/Web y regresión GPS/MDM/administración. |
| I-07 | PASS | Build y typecheck. |
| I-08 | PASS | Migración sintética limpia, upgrade, rollback, ledger y recuperación 0018→0020. |
| I-09 | PASS | Permisos denegados por defecto, auditoría en pruebas y escaneo de secretos. |
| I-10 | PASS | Sin push, despliegue ni migraciones operativas. |

## Riesgos residuales y límites

La evidencia histórica indica que el catálogo W1-A no se desplegó sobre datos reales, pero no se inspeccionaron ledgers de entornos persistentes; cualquier despliegue futuro requiere comprobarlos y una autorización distinta. Los tres cambios GPS locales del checkout destino siguen sin commit y no forman parte del SHA integrado. Si la rama continúa avanzando, se repetirán los gates pertinentes antes de otro cambio operativo. No se activaron rutas ni visitas automáticas; W1-B y W2–W6 permanecen fuera de alcance.

`W1_B_NOT_AUTHORIZED`
`W2_W6_NOT_AUTHORIZED`
`PUSH_AUTHORIZED = NO`
`DEPLOY_AUTHORIZED = NO`
`STAGING_MIGRATION_AUTHORIZED = NO`
`PRODUCTION_MIGRATION_AUTHORIZED = NO`
