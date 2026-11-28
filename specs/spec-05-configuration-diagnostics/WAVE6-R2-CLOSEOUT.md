# W6-R2 — Cierre de preparación de promoción

Fecha: 2026-11-28 UTC. Rama `codex/mdm-diagnostics-wave0`. Fuente de aplicación `809bb0678feaefdbbe8006a1ba05325ccb1ad0a8`; último commit de CI publicado `3a5c5be43905e8875db94bbbc3fc7701c8287da1`. [Run remoto PASS](https://github.com/Kmena/Geops/actions/runs/46164447870); [manifiesto de imágenes](WAVE6-R2-GHCR-RELEASE-MANIFEST.json). No se modificaron API, Web, Android ni SQL después del SHA fuente. Solo se añadió workflow y portabilidad/diagnóstico del runner E2E; diff y fallos resueltos en [CI](WAVE6-R2-CI-EVIDENCE.md).

La aprobación parcial de W6-R1 se registra literalmente: `WAVE6_LAB_ENVIRONMENT_PASS`, `STAGING_READ_ONLY_INVENTORY_PASS`, `STAGING_HEALTH_PASS`, `STAGING_SCHEMA_0040_CONFIRMED`, `STAGING_MIGRATION_PREFIX_COMPATIBILITY_PASS`, `STAGING_404_ROOT_CAUSE_CONFIRMED`, `LOCAL_RELEASE_CANDIDATE_BUILD_PASS`, `SYNTHETIC_BACKUP_RESTORE_PASS`; `STAGING_REAL_BACKUP_RESTORE_BLOCKED`, `MANAGEENGINE_REAL_VALIDATION_BLOCKED`, `APK_INSTALLED_COMPATIBILITY_BLOCKED`, `GPS_BACKGROUND_ROOT_CAUSE_UNCONFIRMED` y `PRODUCTION_READY=NO`.

| Estado solicitado | Resultado | Evidencia/límite |
| --- | --- | --- |
| STAGING_PRIVILEGED_INVENTORY | PARTIAL | Controlador/HTTPS W6-R1; Docker/DB privilegiados pendientes. |
| STAGING_OCI_LABELS_VERIFIED | BLOCKED | Candidatas verificadas; labels de imágenes **activas** no legibles con `abi`. |
| STAGING_REAL_MIGRATION_LEDGER_VERIFIED | BLOCKED | Hash de 40 coincide; faltan filas/checksums/`applied_at` reales. |
| MIGRATION_0041_VALIDATION | PARTIAL | Código, SHA, imagen empaquetada, integración y restore sintético PASS; restore real pendiente. |
| MIGRATION_0042_VALIDATION | PARTIAL | Código, SHA, imagen empaquetada, integración y restore sintético PASS; restore real pendiente. |
| REMOTE_CI_PASS | PASS | Run 46164447870, validate PASS. |
| GHCR_API_IMAGE_PUBLISHED | PASS | `ghcr.io/kmena/geops-api@sha256:e137e65016dc2c7b8d9130a6d81dae5d9510d422bd3b1e1e955405cefa8662b5`; pull/labels/42 SQL verificados. |
| GHCR_WEB_IMAGE_PUBLISHED | PASS | `ghcr.io/kmena/geops-web@sha256:583058e25cd33cc1ca58e750c7837210580ed1a482c6321a44c62b43c846133f`; pull/labels/bundle verificados. |
| RELEASE_MANIFEST_READY | PARTIAL | Identidad, CI, digests, labels y SQL listos; campos backup/restore reales nulos y comando de promoción sin validar. |
| STAGING_REAL_BACKUP_PASS | BLOCKED | Sin acceso a respaldo protegido. |
| STAGING_REAL_RESTORE_PASS | BLOCKED | No se obtuvo dump real ni se hizo réplica. |
| RESTORED_DATABASE_MIGRATION_PASS | BLOCKED | 0040→0042 solo PASS con fixture sintética; datos reales pendientes. |
| STAGING_PROMOTION_READY | BLOCKED | Falta inventario/ledger real, backup/restore y ensayo del operador para cambio de esquema. |
| STAGING_PROMOTION_AUTHORIZED | NOT_RUN | Requiere autorización independiente posterior. |
| STAGING_DEPLOYED | NOT_RUN | No se invocó despliegue. |
| MANAGEENGINE_REAL_VALIDATION | BLOCKED | Edición/licencia/tenant/scopes reales pendientes. |
| APK_INSTALLED_COMPATIBILITY | BLOCKED | Versión y certificado de APK **instalada** en Moto G06 pendientes. |
| GPS_BACKGROUND_ROOT_CAUSE | BLOCKED | Sin prueba física discriminante; causa no confirmada. |
| PRODUCTION_READY | BLOCKED | Staging, MDM, APK y GPS físico pendientes; no hay aprobación productiva. |

## Entregables

[Inventario privilegiado](WAVE6-R2-PRIVILEGED-INVENTORY.md), [migraciones](WAVE6-R2-MIGRATION-VALIDATION.md), [CI](WAVE6-R2-CI-EVIDENCE.md), [manifiesto JSON](WAVE6-R2-GHCR-RELEASE-MANIFEST.json), [backup](WAVE6-R2-STAGING-BACKUP.md), [restore](WAVE6-R2-RESTORE-REHEARSAL.md), [plan de promoción y smoke](WAVE6-R2-PROMOTION-PLAN.md), [comandos de operador](WAVE6-R2-OPERATOR-COMMANDS.md) y [SDD actualizado](SDD.md).

El [bloque único de inventario](WAVE6-R2-OPERATOR-COMMANDS.md) es el siguiente paso para un operador privilegiado. Luego se requiere backup real, restore aislado y ensayo del mecanismo de migración, sin conectar a ManageEngine ni notificar dispositivos. Solo al cerrar esos gates se podrá presentar una solicitud concreta de promoción 0040→0042. La publicación GHCR no autoriza promoción. Se detiene W6-R2 aquí: `main`, staging operativo, producción, políticas, APK, enrolamiento y motor GPS permanecen sin cambios; Wave 7 no se inicia.

Una lectura final de `sudo -n /usr/local/sbin/geops-staging-simple status` tras la publicación confirmó que staging conserva los mismos digests API/Web, 40 migraciones con el mismo hash, gate `open` y tres servicios healthy. El push documental posterior produjo jobs `validate` e `images` **skipped** por el gate de mensaje del workflow; no volvió a publicar imágenes.

## Auditoría de cierre de gates solicitada

Se preservó sin cambios el bloque A de [comandos de operador](WAVE6-R2-OPERATOR-COMMANDS.md) para que lo ejecute una cuenta autorizada. La conexión SSH disponible es `abi`; `sudo -n -l` confirmó que no puede usar Docker/DB sin una contraseña que Codex no posee. El wrapper `geops-staging-simple` es root-only. La copia legible de `backup.sh` y `compose.staging.yaml` en staging coincide byte a byte con el checkout; esto **verifica el procedimiento de código**, no la ejecución de un backup. El runbook histórico identifica `geops-backup` mediante Compose y está incorporado en los comandos existentes.

| Gate | Estado | Resultado faltante |
| --- | --- | --- |
| STAGING_REAL_LEDGER_VERIFIED | BLOCKED | 40 filas `version,checksum,applied_at` reales y comparación exacta con el SHA fuente. |
| STAGING_ACTIVE_OCI_LABELS_VERIFIED | BLOCKED | Labels OCI/IDs/digests de contenedores activos desde Docker privilegiado. |
| STAGING_BACKUP_PASS | BLOCKED | Dump real nuevo, fecha, bytes, SHA-256, `sha256sum -c`, `pg_restore --list` y custodia. |
| STAGING_REAL_RESTORE_PASS | BLOCKED | Copia real en DB/volumen/red aislados con conteos, identidades y relaciones verificados. |
| STAGING_RESTORED_MIGRATION_0042_PASS | BLOCKED | Aplicar 0041/0042 solo a esa copia; ledger 42, objetos SQL y funcionalidad con ambos digests candidatos. |
| STAGING_OPERATOR_REHEARSAL_PASS | BLOCKED | Interfaz/runbook protegido y ensayo 0040→0042 sobre copia, con gate, backup, health, smoke y recuperación. |
| STAGING_PROMOTION_READY | BLOCKED | Depende de los seis gates anteriores. |
| STAGING_PROMOTION_AUTHORIZED | NOT_RUN | La solicitud de autorización se presentará después de `READY=PASS`. |
| STAGING_DEPLOYED | NOT_RUN | Ninguna promoción operativa ejecutada. |

**Única intervención requerida:** una cuenta de operador Docker/DB ya autorizada ejecuta el bloque A sin cambios y los comandos protegidos de backup/verificación en [WAVE6-R2-OPERATOR-COMMANDS.md](WAVE6-R2-OPERATOR-COMMANDS.md); conserva dump/secretos en infraestructura protegida, ensaya restore y migración solo en entorno aislado, e informa resultados sanitizados y la interfaz real del controlador. [Backup](WAVE6-R2-STAGING-BACKUP.md) y [restore](WAVE6-R2-RESTORE-REHEARSAL.md) definen los criterios. Sin esa evidencia no se puede elevar ninguno de estos gates a PASS.
