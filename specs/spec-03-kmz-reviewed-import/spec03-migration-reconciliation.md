# SPEC-03 — Reconciliación de migraciones (corte 2026-11-04)

**Estado:** `SPEC03_MIGRATION_RECONCILIATION_BLOCKED`. Rama aislada `codex/spec03-migration-reconcile`, creada desde `origin/main` en `f1b0aa8d3662c25634820ba5b9bf762433580a77`. No se fusionó SPEC-03 ni se modificó SQL. El responsable indicó que habilitará acceso de lectura al ledger; aún no existe evidencia de su contenido ni de todos los entornos persistentes. La condición del encargo impide renumerar SPEC-03 antes de demostrar que sus migraciones 0019–0026 nunca fueron aplicadas allí.

## Referencias verificadas

`git ls-remote --heads origin` devolvió `main=f1b0aa8`, `codex/geops-integration=a6da139` y `codex/geops-unified-staging-candidate=03e582f`. El origen W6-R sigue en `cb7ba886a0510a8b5e53dba999756c82620bcd33` (código `116a13f5fbc4e6bbca32e06d11e59d32f773ee1b`). La rama de integración remota contiene catálogo 0019–0020 y es anterior a la línea GPS/MDM de `main`; por eso la rama preparatoria parte de `main` y conserva sus 23 SQL. El informe del bloqueo anterior, `spec03-integration-deployment.md`, quedó sin commit en otro worktree y no se copió ni descartó.

El migrador `loadMigrations()` usa el **nombre completo** como versión y SHA-256 del contenido UTF-8 como checksum. `applyMigrations()` rechaza versiones desconocidas o checksums distintos; `checkReadiness()` exige coincidencia exacta de cantidad y pares versión/checksum. Los SHA-256 siguientes se calcularon sobre bytes de cada objeto Git, sin normalizar fin de línea. La coincidencia de 0001–0018 se verificó entre las tres referencias.

## Matriz de archivos en Git

**Aplicación persistente:** «No verificada» significa que la fila está en Git, pero no se ha consultado el ledger de staging ni el inventario de los demás entornos persistentes. Las pruebas previas SPEC-03 usaron únicamente bases desechables; no demuestran ausencia de aplicaciones en otro entorno. La columna de dependencia resume el objeto o prefijo principal, no reemplaza el orden del migrador.

| ID | Archivo | SHA-256 | Rama de origen | Dependencia principal | Aplicación persistente | Colisión |
| --- | --- | --- | --- | --- | --- | --- |
| 0001 | `0001_postgis.sql` | `c5a4b9f1d7549e59fbf69b161065e614e95c5ddb0cc014e4f9540f568c6c0934` | main / integración / SPEC-03 | PostGIS | No verificada | No |
| 0002 | `0002_admin.sql` | `33cda143fbc20bf2b6224e902ab871b917c3429cc65bdcfbd95c5e0de8b39c6b` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0003 | `0003_device_identity.sql` | `5b9cb24605520146a8ba9e1c9bc8874368e09f9f3542ef4b84e27fab412b61fa` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0004 | `0004_mdm.sql` | `56f75813e603769e80f73241ba47dd430985cf64e03a5cb8de6c51af67b984d8` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0005 | `0005_attestation_policy.sql` | `5b09cfb63532fa283de48e15afa30b2341d3a4a68f0ac222423523d82b794138` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0006 | `0006_lifecycle.sql` | `1ece13d745eb2ca09694a87951de380992c23c88e098709edf642fc774100f7b` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0007 | `0007_security_epoch.sql` | `7c8a94a5259959d49b00ecf6eefbc8c6edc8c13fecdc9a9eb2ca79e96994a8fb` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0008 | `0008_supervised_recovery.sql` | `744c3ba5b039b50477eda0f535e9658c14cdad3a93c9c16aafb4ce75f920d74e` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0009 | `0009_gps_policies.sql` | `821c2226f4b8138a680f2a382a3bfa4c1def5ebe49986c594f6a14ce86bc52ea` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0010 | `0010_gps_health.sql` | `29ec3bddf982dbb547048062727f4f7c8a3b2e4e69724549a95e91bb4683a18c` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0011 | `0011_gps_published_name.sql` | `0f8e9a3008e85b334d6911d317470822d80b56a9b84da5a72bb2e5029353945b` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0012 | `0012_gps_events.sql` | `e649c6d96a42b7f9ebf6630f8c93dbec79f18f2bfb6e2865bb5630ef2e25f3e9` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0013 | `0013_gps_operations.sql` | `170fdec8120703ef5864b5f562aed2ee8f43e86f82b2ce437aee5283d531270d` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0014 | `0014_gps_installation_binding.sql` | `dc6aeebcabe8c0111a0c4dc40ed7d8e6410eb652c6003bc566c140b71d73ef09` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0015 | `0015_single_tenant_admin.sql` | `8ccb89274551f94e6e6f17fa85c6c869ebc88874006f08830d80bd93b3e16f8f` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0016 | `0016_gps_continuity_alerts.sql` | `7c98850921042e60723433a00d7e9c5dd45cde58b8477cad2b2b577ddba22af2` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0017 | `0017_gps_continuity_evaluated_at.sql` | `32a8c342fe5ce557fe98f28c36e3c8d10736c32f5dc892c58fb3c73602234b82` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0018 | `0018_mdm_inventory.sql` | `8f91a73a82f71074c699559980daa3102331fab13e3a602cc88b203608adca07` | main / integración / SPEC-03 | Prefijo anterior | No verificada | No |
| 0019 | `0019_mdm_security.sql` | `a0c44497328d580968bde960032ec256856bf8852531ff855497af37eada9ddc` | main (GPS/MDM) | 0018 MDM; admin | No verificada | Sí: misma cifra SPEC-03 |
| 0020 | `0020_gps_mixed_batch_receipt.sql` | `f0df0ca28fd490ecf9c8b7dbdc9d667d13eb0f998c5fe5a19afba6b2e2cfa19e` | main (GPS/MDM) | 0003 dispositivo; GPS | No verificada | Sí: misma cifra SPEC-03 |
| 0021 | `0021_gps_offline_policy_contract.sql` | `fd499a8db77f30d2c89b9524c9d4b79b028af0bc07fa530f9cfd43da78c98559` | main (GPS/MDM) | 0009/0012 GPS | No verificada | Sí: misma cifra SPEC-03 |
| 0022 | `0022_mdm_web_oauth.sql` | `935eb2ffb723a438bf292073497c0a41c23829790de5d3533645be9aa44d02ad` | main (GPS/MDM) | admin; MDM | No verificada | Sí: misma cifra SPEC-03 |
| 0023 | `0023_mdm_oauth_client.sql` | `ec991513e907488543dc2442329a6f823a944bc6f10386318c7d8082607f88e9` | main (GPS/MDM) | 0022; admin/tenant | No verificada | Sí: misma cifra SPEC-03 |
| 0019 | `0019_catalog_base.sql` | `15a1355ea33cff47a1af6ade8b838ba5961a872bf54df20bc87e91ccfba0f667` | integración / SPEC-03 | 0002/0015 admin; PostGIS | No verificada | Sí: misma cifra main |
| 0020 | `0020_catalog_integrity.sql` | `5f1255c6cf96640e3f734d4b8c09d160a22712af625e74e49560a4bcc183cc2c` | integración / SPEC-03 | 0019 catálogo | No verificada | Sí: misma cifra main |
| 0021 | `0021_kmz_staging.sql` | `9a892707899676887c5cea884897b986f4f6bc0653a507c895aaa67ce2885986` | SPEC-03 | admin; catálogo | No verificada | Sí: misma cifra main |
| 0022 | `0022_kmz_analysis.sql` | `c26f7514b1bb5e477dc55d4e2f513809c02e5c5f576e27043a3c01ac54adf165` | SPEC-03 | 0021; 0019 catálogo | No verificada | Sí: misma cifra main |
| 0023 | `0023_kmz_review.sql` | `45dfe0d3246632658d9924fb1142b198a4d0ae3d4b174b00529d07f43ebe18a1` | SPEC-03 | 0021/0022; catálogo | No verificada | Sí: misma cifra main |
| 0024 | `0024_customer_approval.sql` | `1c516144c44b72eed0fe47c91693299791e11627fe3c565f65a135a81aa6751f` | SPEC-03 | 0019 catálogo | No verificada | No; debe desplazarse |
| 0025 | `0025_kmz_confirmation.sql` | `c6c32b78677612fe266883e7fc9b2e1bee48f72774c4148008da3432680c548d` | SPEC-03 | 0021/0023/0024 | No verificada | No; debe desplazarse |
| 0026 | `0026_kmz_retention.sql` | `d03e2209dec4447355e575934bd91d92e77f6dd6b6ae48c6162e751c7c56cecb` | SPEC-03 | 0021/0023/0025 | No verificada | No; debe desplazarse |

## Conflictos y estrategia condicionada

1. **Identificadores.** `main` usa 0019 MDM, 0020 GPS, 0021 GPS, 0022 MDM y 0023 MDM. SPEC-03 usa 0019–0023 con otros nombres/checksums. Los originales SPEC-03 0024–0026 tampoco pueden conservar sus cifras si se ordena todo SPEC-03 después de 0023.
2. **Permisos.** `0023_mdm_oauth_client.sql` añade `mdm.oauth.configure` a la restricción `admin_permission_permission_check`. El SQL de catálogo `0019_catalog_base.sql` reemplaza esa restricción con una lista que omite dicho permiso. Aplicarlo detrás de `main` rompería MDM; la reconciliación debe conservar el permiso MDM y añadir los tres `catalog.import.*` sin retirar ninguno.
3. **Recuperación y pruebas.** `maintenance-recovery.ts` fija nombres, orden, límites de versión, inventario de objetos y permisos; ambas líneas lo modificaron. También requieren conciliación las expectativas de ledger/checksums en pruebas W1-A, W2–W6-R, GPS/MDM, upgrades y los scripts de release que fijan el catálogo.
4. **Código.** `git merge-tree --write-tree --name-only origin/main cb7ba88` detectó 11 conflictos de contenido: `.github/workflows/spec-02.yml`, `admin-auth/user-administration.ts`, `db/maintenance-recovery.ts`, seis pruebas API de migración/GPS/MDM, `apps/web/package.json` y `apps/web/src/AdminUsers.tsx`. `app.ts` y `main.ts` se combinan textualmente, pero requieren verificación semántica de rutas, OAuth, autenticación y orden de servicios. No se aplicó el árbol hipotético al worktree.

**Secuencia propuesta, todavía NO aplicada:** si el inventario de todos los entornos persistentes confirma ausencia de las versiones/objetos SPEC-03 y `main` permanece en 0023, asignar 0024 catálogo base, 0025 integridad, 0026 staging, 0027 análisis, 0028 revisión, 0029 aprobación, 0030 confirmación y 0031 retención. Antes de fijarla, comparar checksums del prefijo real, verificar dependencias y resolver el permiso MDM. Renombrar solo archivos no basta: deben cambiar recuperación, pruebas, documentación, scripts/manifiestos y checksums esperados. Si aparece cualquier migración SPEC-03 aplicada en un entorno persistente, no renombrarla; diseñar una migración de compatibilidad específica con evidencia de ledger y aprobación separada. Ninguna migración histórica de GPS/MDM se cambiará.

## Validación y riesgos

| Validación solicitada | Estado al corte | Razón |
| --- | --- | --- |
| Instalación limpia y upgrade desde esquema de integración | NOT_RUN | No hay catálogo reconciliado autorizado ni copia del esquema persistente real. |
| Orden, restricciones, índices y checksums | PARTIAL | Orden/checksums de Git inventariados; SQL conjunto no aplicado. |
| Fallo inducido, rollback y reintento | NOT_RUN | Dependen de migraciones reconciliadas. |
| Compatibilidad GPS/MDM y E2E SPEC-03 | NOT_RUN | El merge hipotético tiene conflictos y SQL con colisión. |
| Seguridad de datos operativos | PASS para esta preparación | Solo lectura Git; ningún PostgreSQL operativo ni staging modificado. |

El bloqueo principal es **falta de evidencia de aplicación persistente**. El checkout remoto de staging `03e582f` no prueba el ledger: el usuario SSH `abi` no tenía acceso Docker ni `sudo -n` al controlador en la inspección anterior. El responsable aportó un inventario de contenedores en que `geops-spec02-staging-geops-api-1` y `geops-spec02-staging-geops-web-1` figuran saludables tras 45 horas y `geops-spec02-staging-geops-db-1` figura saludable tras cinco días. Esa evidencia confirma disponibilidad de servicios según el inventario aportado, pero no identifica esquema, ledger ni checksums. Una nueva comprobación SSH de solo lectura devolvió de nuevo `permission denied` para Docker y `sudo: a password is required` para el controlador v2. También falta confirmar qué línea, de 21 o 23 SQL, representa el esquema real que se copiará para probar la ruta. La reconciliación propuesta puede requerir revisar datos/permisos ya existentes; ninguna prueba sintética sustituirá esa comprobación.

**Estado Git:** rama aislada en `f1b0aa8d3662c25634820ba5b9bf762433580a77` antes de este documento. No existe SHA de código reconciliado porque no se modificó SQL ni se resolvieron conflictos. El SHA de un eventual commit documental se registrará en la entrega. Los cambios sin commit de GPS en el checkout de integración y el informe anterior en el worktree SPEC-03 permanecen intactos.

`MERGE_AUTHORIZED = NO`

`PUSH_AUTHORIZED = NO`

`DEPLOY_AUTHORIZED = NO`
