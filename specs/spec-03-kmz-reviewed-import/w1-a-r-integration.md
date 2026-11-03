# SPEC-03 — Informe de integración local W1-A-R

**Estado:** `W1AR_LOCAL_INTEGRATION_BLOCKED`
**Fecha:** 2026-11-03
**Alcance:** preflight y continuación solicitada el 2026-11-03; no se ejecutó merge, cherry-pick, rebase ni commit de integración.

Este informe conserva el estado del preflight anterior a W1-A-R2. La preparación posterior, ejecutada únicamente en una rama aislada, se documenta en [w1-a-r2-evidence.md](w1-a-r2-evidence.md). La rama `codex/geops-integration` sigue sin recibir el merge final.

## Referencias y estrategia

- Origen: `codex/spec-03-w1a-r`, commit auditado `6ee99d7fe6683fdb1981774e0dd503874817336c`; worktree de origen limpio al iniciar.
- Destino identificado para la integración: `codex/geops-integration`, HEAD `90ab9e9f10f6377e739e8bb64da9aef378c59fe2`, por ser la rama de integración activa con GPS/MDM posteriores a la base `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`. La rama del checkout físico principal, `codex/spec-02-wave-1`, permanece en `26efc9a` y tiene cambios locales; `main` local está desactualizada.
- Relación: `codex/geops-integration` tiene 20 commits y W1-A-R uno desde la base común `26efc9a`. No se asumiría fast-forward.
- Estrategia prevista: integración aislada desde el HEAD del destino, sin tocar los dos checkouts ocupados. Se creó `C:\Users\kmena\.codex\worktrees\geops-w1ar-integration-check\Geops` en HEAD separado para el preflight. No se aplicaron cambios allí.
- SHA de integración: **ninguno**.

## Gate obligatorio de lint

Se usó Biome 2.5.15 con el comando `lint` del paquete raíz en ambos árboles. Destino: **31 errores, 12 advertencias**. Origen: **30 errores, 12 advertencias**. La comparación por archivo y regla muestra un error `format` que existe solo en el destino (`apps/api/test/maintenance-recovery-versions.integration.mjs`) y ninguno exclusivo del origen dentro de ese comando. Los restantes errores del comando raíz son heredados y quedan como deuda técnica fuera de alcance.

El comando raíz no incluye dos pruebas añadidas por `6ee99d7`. Al ejecutar Biome sobre **todos los archivos TS/TSX/MJS cambiados por el commit**, aparecen **dos errores nuevos** de severidad `error`, regla `format`. El resultado se confirmó de nuevo en la continuación (2 errores, 0 advertencias en ese conjunto):

1. `apps/api/test/catalog-w1a-upgrade.integration.mjs`
2. `apps/api/test/catalog-w1a.integration.mjs`

Por tanto, el descenso numérico 31→30 no demuestra ausencia de regresiones. **I-03 falla** y la condición de avance no se cumple. El lint dirigido previo de `catalog/` y pruebas W1-A-R no cubría estas dos pruebas W1-A.

## Conflictos relevantes detectados sin integrar

- `git merge-tree --write-tree --name-only codex/geops-integration codex/spec-03-w1a-r` indica conflictos de contenido en `apps/api/src/app.ts` y `apps/api/src/main.ts`. El destino ya registra GPS continuity y MDM real; una elección automática de la versión origen retiraría esos servicios. La combinación correcta requiere resolución explícita y pruebas.
- El destino contiene `0016_gps_continuity_alerts.sql`, `0017_gps_continuity_evaluated_at.sql` y `0018_mdm_inventory.sql`; el origen añade `0016_catalog_base.sql` y `0017_catalog_integrity.sql`. El cargador ordena archivos por nombre completo, pero el procedimiento de recuperación tiene un catálogo cerrado de 18 migraciones y rechaza cualquier conjunto distinto. Incorporar los dos archivos sin actualizar ese contrato rompe recuperación. La solución propuesta para revisión es asignar al catálogo versiones posteriores a 0018 y ajustar referencias y pruebas de recuperación, conservando intactas las migraciones GPS/MDM ya existentes.

No se resolvió ningún conflicto. La última instrucción del usuario ordena detenerse ante conflictos importantes o regresiones nuevas; ambas condiciones se cumplen.

## Gates de cierre

| Gate | Estado | Evidencia |
|---|---|---|
| I-01 | PASS | `6ee99d7` existe, corresponde a W1-A-R; origen limpio al iniciar. |
| I-02 | PASS | Checkouts principal e integración ocupados preservados; sin stash, reset ni sobrescritura. |
| I-03 | FAIL | Dos errores `format` nuevos en pruebas añadidas, omitidas del lint raíz. |
| I-04 | NOT_VERIFIED | Integración Git detenida antes de aplicar cambios por I-03 y conflictos relevantes. |
| I-05 | NOT_VERIFIED | Sin pruebas posteriores a integración. |
| I-06 | NOT_VERIFIED | Sin regresión API/Web/GPS posterior a integración. |
| I-07 | NOT_VERIFIED | Sin build/typecheck posterior a integración. |
| I-08 | NOT_VERIFIED | Sin migración sintética posterior a integración; ninguna migración operativa ejecutada. |
| I-09 | NOT_VERIFIED | Sin escaneo/validación de seguridad posterior a integración. |
| I-10 | PASS | Sin push ni despliegue. |

## Riesgos, estado de worktrees y límites al cierre del preflight

La resolución debe conservar GPS independiente, MDM, auditoría y las restricciones de rutas/visitas de SPEC-03. El checkout `C:\Users\kmena\Documents\proyectos\Geops` conserva modificaciones y archivos sin seguimiento ajenos a esta integración. El checkout `C:\Users\kmena\Documents\proyectos\Geops-integration` conserva tres cambios locales GPS. El worktree aislado de preflight está en HEAD separado y solo contiene esta copia del informe sin seguimiento; no recibió cambios de integración. El worktree de origen también conserva su copia del informe sin seguimiento; el commit auditado no cambia. No hubo push, despliegue, importación real ni migraciones en staging, producción o bases operativas.

`W1_B_NOT_AUTHORIZED`
`W2_W6_NOT_AUTHORIZED`
`PUSH_AUTHORIZED = NO`
`DEPLOY_AUTHORIZED = NO`
`STAGING_MIGRATION_AUTHORIZED = NO`
`PRODUCTION_MIGRATION_AUTHORIZED = NO`
