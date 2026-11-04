# SPEC-03 — Reconciliación local de migraciones (2026-11-04)

**Resultado:** `SPEC03_MIGRATION_RECONCILIATION_PARTIAL`.

**Rama preparada:** `codex/spec03-migration-b32`; **SHA de código y pruebas:** `a7ccb3fbbd6f38c7a17f2c42437280c10be883bc`. La rama parte del historial B32 `4471f0e8986794e68740fd6f73dd9164825f911f`, que contiene 0001–0035. No hubo merge final, push, despliegue ni migración operativa. El checkout B32 con cambios ajenos y el informe anterior de integración permanecieron intactos.

## Evidencia de aplicación persistente

El responsable aportó la salida de solo lectura de `geops_schema_migrations` de `geops-spec02-staging-geops-db-1` y confirmó que staging es la **única base GEOPS persistente** donde SPEC-03 pudo haberse aplicado. Corrigió que la primera fila es `0001_postgis.sql`. Ese ledger contiene exactamente 0001–0035 y ninguna de las versiones/archivos SPEC-03 originales 0019–0026. Los checksums SHA-256 del prefijo 0001–0035 coinciden con los bytes SQL de esta rama. La evidencia de aplicación proviene del ledger aportado por el responsable; no se infiere del listado de contenedores o de Git. No se consultó staging directamente desde esta sesión ni se escribió allí.

En este worktree Windows, 0001–0018 aparecieron inicialmente con CRLF pese a `.gitattributes` (`eol=lf`), lo que alteraba sus checksums locales. Se normalizaron **solo los bytes del worktree** a LF; el índice y los objetos Git históricos no cambiaron. La prueba final 0035→0040 usó esos bytes y verificó el ledger completo. El empaquetado futuro debe conservar LF; un checkout con CRLF fallaría el control de checksum como corresponde.

## Matriz del historial preparado

`B32` designa la línea GPS/MDM/visitas aplicada en staging. `SPEC-03` designa SQL nuevo, presente solo en esta rama. En la columna de dependencias se indica el bloque principal; el orden íntegro es el del migrador. `Sí` en aplicación significa fila confirmada por el ledger aportado, no por el mero archivo Git. `No` en 0036–0040 significa ausente del ledger y solo aplicada en bases locales descartables. Los SHA son del contenido SQL que calcula `loadMigrations()`.

| ID | Archivo | SHA-256 | Origen | Dependencia principal | Staging | Colisión original |
| --- | --- | --- | --- | --- | --- | --- |
| 0001 | `0001_postgis.sql` | `c5a4b9f1d7549e59fbf69b161065e614e95c5ddb0cc014e4f9540f568c6c0934` | main/B32 | PostGIS | Sí, ledger aportado | No |
| 0002 | `0002_admin.sql` | `33cda143fbc20bf2b6224e902ab871b917c3429cc65bdcfbd95c5e0de8b39c6b` | main/B32 | 0001 | Sí, ledger aportado | No |
| 0003 | `0003_device_identity.sql` | `5b9cb24605520146a8ba9e1c9bc8874368e09f9f3542ef4b84e27fab412b61fa` | main/B32 | 0002 | Sí, ledger aportado | No |
| 0004 | `0004_mdm.sql` | `56f75813e603769e80f73241ba47dd430985cf64e03a5cb8de6c51af67b984d8` | main/B32 | 0003 | Sí, ledger aportado | No |
| 0005 | `0005_attestation_policy.sql` | `5b09cfb63532fa283de48e15afa30b2341d3a4a68f0ac222423523d82b794138` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0006 | `0006_lifecycle.sql` | `1ece13d745eb2ca09694a87951de380992c23c88e098709edf642fc774100f7b` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0007 | `0007_security_epoch.sql` | `7c8a94a5259959d49b00ecf6eefbc8c6edc8c13fecdc9a9eb2ca79e96994a8fb` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0008 | `0008_supervised_recovery.sql` | `744c3ba5b039b50477eda0f535e9658c14cdad3a93c9c16aafb4ce75f920d74e` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0009 | `0009_gps_policies.sql` | `821c2226f4b8138a680f2a382a3bfa4c1def5ebe49986c594f6a14ce86bc52ea` | main/B32 | GPS/admin | Sí, ledger aportado | No |
| 0010 | `0010_gps_health.sql` | `29ec3bddf982dbb547048062727f4f7c8a3b2e4e69724549a95e91bb4683a18c` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0011 | `0011_gps_published_name.sql` | `0f8e9a3008e85b334d6911d317470822d80b56a9b84da5a72bb2e5029353945b` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0012 | `0012_gps_events.sql` | `e649c6d96a42b7f9ebf6630f8c93dbec79f18f2bfb6e2865bb5630ef2e25f3e9` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0013 | `0013_gps_operations.sql` | `170fdec8120703ef5864b5f562aed2ee8f43e86f82b2ce437aee5283d531270d` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0014 | `0014_gps_installation_binding.sql` | `dc6aeebcabe8c0111a0c4dc40ed7d8e6410eb652c6003bc566c140b71d73ef09` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0015 | `0015_single_tenant_admin.sql` | `8ccb89274551f94e6e6f17fa85c6c869ebc88874006f08830d80bd93b3e16f8f` | main/B32 | admin/GPS | Sí, ledger aportado | No |
| 0016 | `0016_gps_continuity_alerts.sql` | `7c98850921042e60723433a00d7e9c5dd45cde58b8477cad2b2b577ddba22af2` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0017 | `0017_gps_continuity_evaluated_at.sql` | `32a8c342fe5ce557fe98f28c36e3c8d10736c32f5dc892c58fb3c73602234b82` | main/B32 | prefijo anterior | Sí, ledger aportado | No |
| 0018 | `0018_mdm_inventory.sql` | `8f91a73a82f71074c699559980daa3102331fab13e3a602cc88b203608adca07` | main/B32 | MDM | Sí, ledger aportado | No |
| 0019 | `0019_mdm_security.sql` | `a0c44497328d580968bde960032ec256856bf8852531ff855497af37eada9ddc` | main/B32 | 0018 MDM | Sí, ledger aportado | Sí, SPEC-03 original |
| 0020 | `0020_gps_mixed_batch_receipt.sql` | `f0df0ca28fd490ecf9c8b7dbdc9d667d13eb0f998c5fe5a19afba6b2e2cfa19e` | main/B32 | GPS | Sí, ledger aportado | Sí, SPEC-03 original |
| 0021 | `0021_gps_offline_policy_contract.sql` | `fd499a8db77f30d2c89b9524c9d4b79b028af0bc07fa530f9cfd43da78c98559` | main/B32 | GPS | Sí, ledger aportado | Sí, SPEC-03 original |
| 0022 | `0022_mdm_web_oauth.sql` | `935eb2ffb723a438bf292073497c0a41c23829790de5d3533645be9aa44d02ad` | main/B32 | MDM/admin | Sí, ledger aportado | Sí, SPEC-03 original |
| 0023 | `0023_mdm_oauth_client.sql` | `ec991513e907488543dc2442329a6f823a944bc6f10386318c7d8082607f88e9` | main/B32 | 0022 MDM | Sí, ledger aportado | Sí, SPEC-03 original |
| 0024 | `0024_client_geofences.sql` | `5b2a1cdfc479cf63057fc1081b81d76133d4e0fbcf10308170d3514168a573be` | B32 GPS/MDM/visitas | 0015 tenant/PostGIS | Sí, ledger aportado | Sí, SPEC-03 original |
| 0025 | `0025_route_catalog.sql` | `8e53fb4beddafe36be9a192221f4c324be18b0317fce7f339730a604566b4a06` | B32 GPS/MDM/visitas | 0024 client/site | Sí, ledger aportado | Sí, SPEC-03 original |
| 0026 | `0026_agents_assignments.sql` | `02d793841115f23da07fc0d43a71729415b57369996dc728663b84d9b84ea115` | B32 GPS/MDM/visitas | 0025 rutas | Sí, ledger aportado | Sí, SPEC-03 original |
| 0027 | `0027_visit_dwell_engine.sql` | `ebc405d652b8e902e4031d49fb5ad8d1630d12a4d5b76be662840f7e9fc23898` | B32 GPS/MDM/visitas | 0025/0026 | Sí, ledger aportado | No |
| 0028 | `0028_agent_device_links.sql` | `fec1d922f7c8e79a2cebab75153ac94467f5cfa683154ceb27b0f9a0679a5c80` | B32 GPS/MDM/visitas | GPS/MDM | Sí, ledger aportado | No |
| 0029 | `0029_geops_gps_identity.sql` | `1f818a9362905b1ab27e8a4aab2aaa7a171335116132134c83a171a35906e5e3` | B32 GPS/MDM/visitas | GPS | Sí, ledger aportado | No |
| 0030 | `0030_gps_continuity_geops_owner.sql` | `ee9f644c0026874fc6fac3ace7410bf44ba45b2d9672a4dc844c058fe6b614ba` | B32 GPS/MDM/visitas | GPS | Sí, ledger aportado | No |
| 0031 | `0031_agent_responsibility_geocoding.sql` | `a0075a4e2c67dc836264373fee7da71f8c608fe1fd164b198b7b7e3a1dbde57c` | B32 GPS/MDM/visitas | visitas | Sí, ledger aportado | No |
| 0032 | `0032_mdm_continuous_capture.sql` | `62b184b44c61a44435c30497c1dfea5d5e369c285993a1716fcc55fe6b76815c` | B32 GPS/MDM/visitas | MDM | Sí, ledger aportado | No |
| 0033 | `0033_visit_coverage_calibration.sql` | `3f02ce80ec30f9844cf5531e23d7d7894d681a5b3713240be0cef326b5e6edd2` | B32 GPS/MDM/visitas | visitas | Sí, ledger aportado | No |
| 0034 | `0034_gps_device_ownership.sql` | `bb4db9baab5ba79ddbb7dd08c3795a289c5f0b92af631ee2cffe525ce16d2b18` | B32 GPS/MDM/visitas | GPS | Sí, ledger aportado | No |
| 0035 | `0035_legacy_device_decommission.sql` | `cb0e20ed7eb1062db06f6cd2a50b53d7cf0c2496388b5fd38ea3bcc786102bb2` | B32 GPS/MDM/visitas | GPS/MDM | Sí, ledger aportado | No |
| 0036 | `0036_kmz_staging.sql` | `1dd00e28a8fd3d398237002ee8533c987b547cdc2e00a13d4cbb9be9d244c2a0` | SPEC-03 preparada | 0035 + client/site | No; solo local desechable | No |
| 0037 | `0037_kmz_analysis.sql` | `c394883a763e8fa5876fdb628e9caecfa2d4c3e5ee20dae64ea39484db428f97` | SPEC-03 preparada | 0036 + client/site | No; solo local desechable | No |
| 0038 | `0038_kmz_review.sql` | `125fb03324faf653f077bd929af1963a352a3f505efbfbc19bc66f4e809f3a45` | SPEC-03 preparada | 0037 + client/site | No; solo local desechable | No |
| 0039 | `0039_kmz_confirmation.sql` | `c6c32b78677612fe266883e7fc9b2e1bee48f72774c4148008da3432680c548d` | SPEC-03 preparada | 0038 + client/site | No; solo local desechable | No |
| 0040 | `0040_kmz_retention.sql` | `d03e2209dec4447355e575934bd91d92e77f6dd6b6ae48c6162e751c7c56cecb` | SPEC-03 preparada | 0039 + staging | No; solo local desechable | No |

## Colisiones originales y decisión aplicada

| SQL original SPEC-03 | SHA-256 original | Conflicto con B32 | Resolución |
| --- | --- | --- | --- |
| `0019_catalog_base.sql` | `15a1355ea33cff47a1af6ade8b838ba5961a872bf54df20bc87e91ccfba0f667` | 0019 MDM y catálogo paralelo | Omitido: B32 `client`/`client_site` son maestros. |
| `0020_catalog_integrity.sql` | `5f1255c6cf96640e3f734d4b8c09d160a22712af625e74e49560a4bcc183cc2c` | 0020 GPS y catálogo paralelo | Omitido; las restricciones operativas B32 permanecen. |
| `0021_kmz_staging.sql` | `9a892707899676887c5cea884897b986f4f6bc0653a507c895aaa67ce2885986` | 0021 GPS | Adaptado a 0036, permisos B32 preservados y vistas de lectura sobre `client`/`client_site`. |
| `0022_kmz_analysis.sql` | `c26f7514b1bb5e477dc55d4e2f513809c02e5c5f576e27043a3c01ac54adf165` | 0022 MDM | Adaptado a 0037; índice de código sobre `client_site`. |
| `0023_kmz_review.sql` | `45dfe0d3246632658d9924fb1142b198a4d0ae3d4b174b00529d07f43ebe18a1` | 0023 MDM | Adaptado a 0038; FK a `client`/`client_site`. |
| `0024_customer_approval.sql` | `1c516144c44b72eed0fe47c91693299791e11627fe3c565f65a135a81aa6751f` | 0024 clientes B32 y modelo paralelo | Omitido; la aprobación es `kmz_import_commit` y operaciones auditadas. |
| `0025_kmz_confirmation.sql` | `c6c32b78677612fe266883e7fc9b2e1bee48f72774c4148008da3432680c548d` | 0025 rutas B32 | Movido a 0039; SQL idéntico, servicio adaptado al catálogo B32. |
| `0026_kmz_retention.sql` | `d03e2209dec4447355e575934bd91d92e77f6dd6b6ae48c6162e751c7c56cecb` | 0026 agentes B32 | Movido a 0040; SQL idéntico. |

El renombrado no fue la única operación: se adaptaron permisos, claves foráneas, índice, vistas de comparación, confirmación, pruebas y UI. Los códigos del KMZ se guardan en `kmz_import_operation.source_code` como referencia no autoritativa. Un código GEOPS nuevo solo proviene de un valor aprobado explícitamente o de un identificador generado; no se interpreta el código KMZ como cédula o identidad oficial. La confirmación exige `catalog.import.confirm`, `visit.catalog.write`, administrador activo y acceso al tenant operativo. La carga y revisión exigen capacidades de importación y acceso al tenant. Las rutas semanales quedan candidatas; no se activan `route_template` ni visitas.

## Conflictos de código reconciliados

Se incorporaron los servicios W2–W6-R de la rama fuente `codex/spec03-w1b-w5` (`116a13f5fbc4e6bbca32e06d11e59d32f773ee1b`, evidencia `cb7ba886a0510a8b5e53dba999756c82620bcd33`) selectivamente sobre B32. `app.ts` registra una vez cada ruta KMZ junto a las rutas GPS, MDM, visitas y catálogo existentes. `main.ts` inicializa los servicios con el mismo pool y autenticación. Web añade la pantalla de revisión sin reemplazar navegación existente. No se introdujeron las tablas paralelas `catalog_customer` ni `catalog_establishment`; esas denominaciones existen solo como vistas de lectura para el comparador heredado. La vista de pins usa la última revisión activa de geocerca por sitio.

Los scripts heredados de integración KMZ que insertaban en el catálogo paralelo siguen preservados en la rama fuente; no se copiaron como pruebas ejecutables de B32. Se añadieron pruebas específicas del modelo canónico y se adaptó la de retención. La prueba MDM de inventario se actualizó para esperar el prefijo completo 0001–0040.

## Validación local

Todas las bases `geops_verify_*` se crearon dentro de un contenedor local `postgis/postgis:18-3.6` con publicación en `127.0.0.1`; no se usó una base operativa. La versión final de SQL se comprobó en bases nuevas.

| Validación | Resultado | Evidencia |
| --- | --- | --- |
| Instalación limpia | PASS | 40 migraciones aplicadas; `checkReadiness()` true. |
| Upgrade desde B32 0035 | PASS | `spec03-b32-upgrade.integration.mjs`: aplica 0036–0040 en orden y vuelve a aplicar sin cambios. |
| Ledger y checksums | PASS | 40 pares versión/SHA iguales al catálogo local; 0001, 0018 y 0035 cotejados expresamente con ledger aportado. |
| Restricciones, índices, FK | PASS | SQL completo en PostGIS 18; E2E inserta `client`/`client_site` con FK y consulta de geografía. |
| Fallo, rollback y reintento de migración | PASS | Colisión inducida de `catalog_revision`; ledger queda en 35 y no existe `kmz_import_session`; tras retirar colisión aplica 5. |
| E2E SPEC-03 | PASS | `spec03-b32-e2e.integration.mjs`: upload, rematch, revisión, creación, actualización selectiva, rollback de confirmación y replay. |
| Retención D-06 | PASS | `kmz-w6r-retention.integration.mjs`: 30 días, dry-run, archivo, auditoría, fallo, concurrencia, reintento; tablas operativas inalteradas. |
| GPS/MDM | PASS | GPS policy integration: 48 aserciones; MDM inventory integration: salida 0; prefijo 35 y objetos B32 conservados. |
| Unit/API/Web | PASS | `npm test`, 10 pruebas de parser/matcher KMZ, typecheck API/Web/contratos, build API/Web. |
| Lint y secretos | PASS | Biome dirigido: 27 archivos, cero errores; `security:scan`: 784 archivos, PASS. |

## Riesgos y trabajo pendiente

1. `maintenance-recovery.ts` de B32 ya fija el catálogo hasta 0031, mientras staging y esta rama llegan a 0035 y 0040. No se alteró ese mecanismo de recuperación sensible en esta reconciliación. Su actualización y ensayo específico son necesarios antes de usarlo como ruta de recuperación de un despliegue SPEC-03.
2. Los scripts históricos de upgrade y capacidad W2–W6-R que asumen `catalog_customer` como tabla o 0019–0026 como versiones no se trasladaron; el código fuente anterior permanece en su rama. Antes de un release deberán adaptarse o retirarse formalmente de la matriz de CI. La capacidad con el KMZ real no se repitió en esta tarea de reconciliación.
3. El ledger recibido es evidencia aportada por el responsable y se limitó a la única base persistente declarada. Cualquier entorno adicional descubierto posteriormente obliga a cotejar su ledger antes de aplicar estas versiones.
4. Staging sigue en 0035. No se probó ni autorizó ningún despliegue. Los checksums 0036–0040 aquí son candidatos de esta rama; un cambio posterior en SQL requiere regenerar la matriz y repetir el upgrade.

**Estado Git del corte:** commit de código `a7ccb3fbbd6f38c7a17f2c42437280c10be883bc`; este informe se registrará en un commit documental posterior de la misma rama. Ningún merge final ocurrió.

`MERGE_AUTHORIZED = NO`

`PUSH_AUTHORIZED = NO`

`DEPLOY_AUTHORIZED = NO`
