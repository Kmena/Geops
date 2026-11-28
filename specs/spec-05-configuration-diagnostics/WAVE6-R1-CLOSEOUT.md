# SPEC-05 — Cierre de W6-R1 para revisión

Fecha: 2026-11-28. La aprobación del usuario registra `WAVE6_LAB_ENVIRONMENT_PASS`, `GPS_V2_LAB_INTEGRATION_PASS`, `SPEC05_DIAGNOSTIC_INTEGRATION_PASS` y `WEB_RUNTIME_VALIDATION_PASS`. W6-R1 ejecutó auditoría remota de **solo lectura**, preparación de candidata local, descubrimiento de capacidades disponibles y verificación estática de APK. No cambió `main`, staging, ManageEngine, Moto G06, APK distribuida ni motor GPS. No empezó Wave 7.

## Entregables

1. [Inventario staging](WAVE6-R1-STAGING-INVENTORY.md), con evidencia sanitizada del controlador y HTTP en `output/spec05-wave6-r1/`.
2. [Matriz de compatibilidad](WAVE6-R1-STAGING-COMPATIBILITY.md), incluido prefijo SQL 0040 idéntico y rutas SPEC-05 ausentes en el release activo.
3. [Plan de release](WAVE6-R1-STAGING-RELEASE-PLAN.md), workflow manual sin push y manifiesto local en `output/spec05-wave6-r1/candidate-manifest.json`; digests GHCR/CI remoto pendientes.
4. [Respaldo y restore](WAVE6-R1-BACKUP-RESTORE-EVIDENCE.md): ensayo sintético `pg_dump -Fc`→`pg_restore`→0042 PASS; backup y restore **reales** de staging BLOCKED por acceso.
5. [Descubrimiento ManageEngine](WAVE6-R1-MANAGEENGINE-DISCOVERY.md): integración prevista MSP Cloud, tenant real no identificado, operaciones reales NOT_RUN.
6. [Compatibilidad APK](WAVE6-R1-APK-COMPATIBILITY.md): candidata y referencia histórica verificadas; instalación real BLOCKED.
7. [Acciones únicas del operador](WAVE6-R1-OPERATOR-ACTIONS.md), ordenadas por dependencia; un solo bloque privilegiado de solo lectura para inventario restante.
8. Este informe y [SDD actualizado](SDD.md).

## Pruebas y límites

`npm run typecheck`, `npm run lint` (0 errores, 12 avisos GPS preexistentes), `npm run contracts:check`, `npm test`, `npm run security:scan` (871 archivos elegibles), `npm run staging:check`, `npm run staging:caddy:check` y `VITE_MDM_ENABLED=true npm run build` pasaron en el worktree. La primera ejecución dentro del sandbox falló por `spawn EPERM` al iniciar subprocesos de Node/Vite/Git/Docker; la misma suite pasó con permiso de ejecución ampliado. La integración W6-A ya aprobada cubre 68 aserciones GPS/diagnóstico en PostGIS y 20 checks Chrome. El nuevo ensayo W6-R1 de restore sintético 0040→0042 pasó. No hubo CI remoto, imagen publicada, restauración del dump operativo ni prueba física.

Una imagen local construida y etiquetada por SHA es solo candidata **local**. Los IDs de imagen Docker se documentan en el manifiesto, pero no equivalen a digests GHCR. El workflow no se ha lanzado porque la rama no se publicó. La promoción necesita aprobación específica después de completar backup/restore real y la publicación de imágenes por digest.

## Estados independientes

| Estado | Resultado | Motivo |
| --- | --- | --- |
| STAGING_ACCESS | PASS | Alias SSH y controlador `status/check` de solo lectura operativos. |
| STAGING_INVENTORY | PARTIAL | Proyecto, 3 servicios, salud, digests, gate, recursos, puertos observados; Docker/DB runtime detallado requieren operador. |
| STAGING_DEPLOYED_SHA_IDENTIFIED | PARTIAL | Controlador reporta commit `b597c9f52f3f53da5e9d9be0fce43351f9eb4561`; label OCI no leído. |
| STAGING_IMAGE_DIGESTS_IDENTIFIED | PASS | API/Web activos por referencias `@sha256` del controlador. |
| STAGING_MIGRATION_LEDGER_IDENTIFIED | PARTIAL | 40 y hash exacto conocido; filas/`applied_at` pendientes. |
| STAGING_404_ROOT_CAUSE | PASS con procedencia pendiente | Release base sin código SPEC-05 y JSON 404 backend; rutas `/v1` conocidas devuelven 401. Label de imagen pendiente. |
| STAGING_RELEASE_CANDIDATE_READY | PARTIAL | Fuente, pruebas, migraciones y build local; falta CI SHA exacto y digest publicable GHCR. |
| STAGING_BACKUP_VALIDATED | BLOCKED | Sin dump operativo/fecha/checksum verificables. |
| STAGING_RESTORE_TEST_PASS | BLOCKED en staging | Restore **sintético local** PASS, no dump real. |
| STAGING_PROMOTION_READY | BLOCKED | Backup/restore, controlador 0040→0042, CI y digests de registro pendientes. |
| STAGING_PROMOTION_AUTHORIZED | NOT_RUN | No se solicitó ni ejecutó promoción. |
| MANAGEENGINE_TENANT_IDENTIFIED / REAL_AUTHENTICATION / REAL_DEVICE_READ / REAL_PROFILE_READ / REAL_PERMISSION_READ | BLOCKED | Sin tenant/cuenta READ; Compose visible MDM false, configuración efectiva sin verificar. |
| MOTO_G06_IDENTIFIED / APK_INSTALLED_VERSION_VERIFIED / APK_INSTALLED_SIGNATURE_VERIFIED | BLOCKED | Sin inventario real ni teléfono accesible. |
| APK_UPDATE_COMPATIBILITY / APK_CONTROLLED_UPDATE_READY | BLOCKED | Firma instalada y backend compatible desconocidos. |
| GPS_BACKGROUND_ROOT_CAUSE | UNCONFIRMED | Sin diagnóstico físico; motor GPS intacto. |
| PRODUCTION_READY | NO | Todos los gates operativos y físicos pendientes. |

**Punto de parada:** W6-R1 no autoriza `deploy`, cambio de perfil ni instalación. Resolver P0–P3 del [documento único](WAVE6-R1-OPERATOR-ACTIONS.md), preparar una solicitud concreta de promoción staging y, después de verificar su runtime, una autorización **separada** para actualizar exclusivamente el Moto G06.
