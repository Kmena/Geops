# GEOPS — consolidación candidata para Staging (2026-10-21)

Rama aislada: `codex/geops-unified-staging-candidate`. Base: `6d2453eb2e55c272ef4c1f67158051227d591683` (`codex/geops-spec02-mdm-integration`). Este informe registra la validación local de la base más los ajustes de CI y de dos expectativas de pruebas de recuperación; el SHA final se obtiene con `git rev-parse HEAD` en el worktree candidato. No hubo publicación, instalación, cambios de MDM ni despliegue.

## Inventario y decisión Git

| Rama / worktree | HEAD observado | Relación con la base candidata | Estado local |
| --- | --- | --- | --- |
| `codex/geops-spec02-mdm-integration` | `6d2453e` | Base, contiene P0 y Waves A–D | Limpio |
| `codex/geops-mdm-security` | `8b04a2f` | Ancestro incorporado | Limpio |
| `codex/geops-integration` | `90ab9e9` | Ancestro incorporado; la referencia `b5d71ac` es un commit anterior | Tres cambios Web GPS sin commit, conservados allí |
| `feature/mdm-manageengine-integration` | `f24a4b0` | Ancestro incorporado | Limpio |
| `codex/spec-02-wave-1` | `26efc9a` | Ancestro incorporado | Documentos y archivos locales sin commit, conservados allí |
| `codex/gps-resilience` | `26c109f` | Ancestro incorporado | Limpio |
| `codex/poc-gps-weekend` | `d72cdb4` | Rama histórica; la PoC y sus cambios relevantes ya están en la línea integrada | Sin worktree activo |
| `main`, `spec-00-technical-feasibility`, `codex/spec-01-wave-0a` | `b5a5b5d`, `b5a5b5d`, `47f741d` | Ramas históricas, sin commits aprobados pendientes para esta consolidación | Sin worktree activo |

`git merge-base` devuelve el HEAD completo de las cuatro ramas principales y `codex/spec-02-wave-1`. `git branch --contains` confirma `26c109f` (resiliencia) y `dc38404` (simplificación y diagnósticos Android). `git branch --no-merged codex/geops-spec02-mdm-integration` no devuelve ramas locales o remotas relevantes. La base elegida evita repetir merges y preserva trazabilidad; no hubo conflictos de contenido. Los cambios Web de zona horaria sin commit y los documentos locales del worktree principal no se copiaron ni descartaron: carecen de commit y verificación de aprobación en esta solicitud.

## Matriz de cobertura funcional

| Función | Origen / commit clave | En la candidata | Prueba y evidencia | Riesgo pendiente |
| --- | --- | --- | --- | --- |
| Captura GPS, resiliencia y simplificación Android | `codex/spec-02-wave-1` `dc38404`; `codex/gps-resilience` `20ac1c6`; integrada `45ced09` | Incorporada | `syntheticTest`, `assembleDebug`, `lintDebug` | POCO/Huawei y Doze sin ensayo físico |
| Política offline ADR-020, vigencia, DST y reinicio | `45ced09`, `5cad31b` | Incorporada | Kotlin/JVM y GPS/PostGIS; migración 0021 | Hora civil tras reboot offline y tzdb/OEM requieren validación/aceptación |
| Cola AES-GCM, ACK exacto, STARTED y sesiones | `205899c`, `da8a651`, `45ced09`, `5cad31b` | Incorporada | Kotlin/JVM; `gps:mixed`, `gps:events`, `gps:continuity` | Continuidad física y red real pendientes |
| ManageEngine OAuth, inventario y seguridad | `feature/mdm-manageengine-integration` `283900f`; `codex/geops-mdm-security` `a283a0b` | Incorporada | `mdm:integration`, `mdm:security:integration`, OAuth unitario | Tenant MDM real no conectado en esta prueba |
| API, autenticación, autorización e ingesta v1/v2/v3 | `205899c`, `45ced09` | Incorporada | API/PostGIS, contratos, `npm test` | Piloto físico y revisión dirigida del SHA final |
| Dashboard GPS y contratos OpenAPI | `6b7c20c`, `20170e7`, `45ced09` | Incorporada | Web test/build/typecheck; `contracts:check` | Cambios Web de zona horaria sin commit excluidos |
| Migraciones y recuperación 0014–0021 | `b5d71ac`, `031c505`, `a283a0b`, `45ced09` | Incorporada | 21 migraciones; upgrades 14/15/16/17/18→21; backup/restauración | Rehearsal de entorno real/Staging pendiente |
| Staging e infraestructura | `codex/geops-integration` `90ab9e9`, `b5d71ac` | Incorporada | `staging:check`, `staging:caddy:check`, build | CI sin ejecución; publicación condicionada a lint |

La corrección nueva de pruebas sustituye solo dos expectativas obsoletas de 20 por 21 migraciones en `maintenance-recovery.integration.mjs` y `maintenance-cli-rehearsal.integration.mjs`. Ambas pruebas pasaron después con bases sintéticas nuevas. La rama candidata se añadió al disparador de `.github/workflows/spec-02.yml`; las puertas de CI siguen intactas.

## Resultados locales

| Control | Resultado |
| --- | --- |
| Instalación reproducible, typecheck, build API/Web, Node/Web, OpenAPI, seguridad estática, configuración Staging | PASS (`npm ci --offline`, `npm run typecheck`, `npm run build`, `npm test`, `contracts:check`, `security:scan`, `staging:check`, `staging:caddy:check`) |
| Vectores del contrato SPEC-02 | PASS, 15 pruebas |
| Kotlin/JVM | PASS, `gradle syntheticTest` |
| Android | PASS, `gradle assembleDebug lintDebug`; `testDebugUnitTest` no aporta pruebas propias |
| API/GPS/administración | PASS sobre `geops_verify_20261030`: enrolamiento, política, configuración, salud, eventos, lotes mixtos, operaciones, capacidades, tenant, usuarios, mantenimiento, carga de scheduler y continuidad |
| MDM | PASS en bases independientes `geops_verify_20261031` y `geops_verify_20261032`: desconexión persistente, replay, rotación, límites de login, inventario transaccional |
| PostGIS | PASS: 21 migraciones en base limpia; 0016→0021 y 0014→0021 pobladas; recuperación supervisada 0014–0018→0021; ensayo CLI `geops_dev`; copia `pg_dump`/`pg_restore` con cuarentena |
| Biome global | **FAIL heredado**: 31 errores de formato y 14 advertencias `noNonNullAssertion`. El mismo 31/14 se reprodujo en una exportación limpia del commit `6d2453e`; no proviene del merge ni de los dos cambios de expectativa. Dos archivos de prueba corregidos pertenecen a esos 31, por formato de línea ya presente. No se aplicó refactor general ajeno a SPEC-02. |
| GitHub Actions | NOT_VERIFIED: la rama no se publicó porque el job obligatorio `npm run lint` fallaría. |
| POCO, Huawei P40 y MDM real | NOT_VERIFIED: no se instalaron APK ni se modificaron dispositivos. |

## APK de diagnóstico, sin instalación

`apps/android-app/build/outputs/apk/debug/GeopsAndroid-debug.apk` se compiló en este worktree con Gradle 8.14.6. SHA-256: `5f4be2876d0a0bea6154dcd48a5eddfbdcc8ea54a9f5a6028ae02a476850754`. `apksigner verify` pasó; certificado SHA-256 `efadaebd9c4488d2e05f53178ea40de97e9b4af86b275f3451c5cf36cb46e03e`, sujeto `CN=Android Debug`. Paquete `com.geops.mobile`, `versionCode=7`, `versionName=0.1.6-test`, minSdk 26, targetSdk 35, compileSdk 36. El APK declara ubicación precisa/aproximada/background, servicio foreground de ubicación, notificaciones y arranque. Árboles Git Android usados: `apps/android-app=ac988f8956f6fc0f2b38ee2d030a3fe7c3337aa8`, `apps/android-agent=6411fd82a44c3fd51dc4035ca3062e9e3bdccdca`. El código Android no cambió respecto de la base `6d2453e`.

Este certificado de depuración difiere del APK anterior registrado en SPEC-02. Antes de actualizar el POCO o Huawei, comparar `applicationId`, firma y versión del APK instalado; una firma distinta impide actualizar sobre la instalación actual. No desinstalar ni borrar la cola cifrada para forzar la prueba. Compatibilidad física y conservación de datos: NOT_VERIFIED.

## Puertas y siguiente decisión

- `UNIFIED_CODE_PASS`: **FAIL como gate integral** por el lint obligatorio, aunque compilación y pruebas funcionales disponibles pasaron.
- `UNIFIED_CI_PASS`: **NOT_VERIFIED**, sin push ni ejecución en GitHub Actions.
- `UNIFIED_SECURITY_PASS`: **NOT_VERIFIED** hasta revisión independiente del SHA final de la candidata.
- `APK_DIAGNOSTIC_READY`: **PASS para artefacto verificable**, no para instalación o piloto.
- `STAGING_READY`: **NO**; `STAGING_BLOCKED` y `PRODUCTION_BLOCKED`: **SÍ**.

Para reabrir publicación: resolver explícitamente la deuda Biome de 31 archivos (o aprobar una política de lint versionada que preserve evidencia del fallo), repetir los gates en el SHA resultante y obtener revisión independiente. Para operación: validar POCO/Huawei, firma de actualización, tiempo civil tras reboot offline, tzdb, captura con pantalla apagada y retención/ACK sin pérdida. Ningún resultado sintético sustituye estas pruebas.
