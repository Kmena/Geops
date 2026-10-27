# B30 — Compatibilidad técnica del controlador de staging

**Corte histórico:** la réplica Docker real y el cierre técnico posterior están documentados en `b30-staging-controller-replica-validation.md`. El estado parcial de este informe corresponde a la evaluación anterior a esa prueba.

**Corte local:** 2026-10-27. **Rama aislada:** `codex/b30-packaging-readiness`.

`B30_STAGING_CONTROLLER_TECHNICAL_PASS = NO`

`B30_STAGING_CONTROLLER_TECHNICAL_PARTIAL = YES`

`STAGING_ED25519_TRUST_KEY = PENDING_OPERATOR_VERIFICATION`

`STAGING_BUNDLE_SIGNATURE = PENDING`

`GHCR_PUBLISHED = NO`

`STAGING_CHANGED = NO`

## Alcance y diferencia con el laboratorio

El controlador privilegiado B30 del laboratorio completó B23→B30 y recuperación en Docker aislado. Su proyecto, nombres de servicios, imágenes y clave eran `LAB_ONLY`. El controlador de staging existente (`geops-deploy-v2`) solo admite hasta B23. Este corte incorpora un controlador de promoción separado en `scripts/deploy/b30-staging/controller.py`, una guardia privilegiada y un instalador compatibles con la topología de staging. No altera ni ejecuta el controlador v2 instalado en ningún servidor.

| Control | Adaptación B30 |
| --- | --- |
| Rutas y permisos | Paquete root en `/opt/geops-b30-staging`, wrapper en `/usr/local/sbin`, estado y lock en `/var/lib/geops-b30-staging`, regla sudo nueva; verifica propietario y modos del gate y de rutas administrativas. |
| Secretos | Lee únicamente `/etc/geops-deploy-v2/secrets` y `runtime-secrets`; compara hashes de los montajes API sin imprimir valores. Requiere GID `24001`. |
| Docker Compose | Reutiliza el bundle staging v2 fijado por hash, proyecto `geops-spec02-staging`, overlays MDM/digest y perfil `maintenance`; exige los seis secretos, red de salida y servicios previstos. |
| Firmas y autorización | Firma Ed25519 del paquete; pin SHA-256 de la clave; documentos separados y firmados para release, restauración, aprobación y recuperación, con vigencia acotada y vínculo al hash de política. |
| Compatibilidad | Fuente B23 steady, 23 checksums exactos; destino B30, 30 checksums exactos. Rechaza downgrade y referencias de imagen no fijadas por digest GHCR. |
| Journal y ledger | Journal root persistente, bloqueo exclusivo, aprobación de un uso, fases de drenaje/mantenimiento/migración/recuperación. Verifica ledger PostgreSQL antes y después de migrar. |
| Health y recuperación | Detiene API/Web antes de cerrar gate. No arranca B30 hasta que la recuperación supervisada abra el gate y exista evento de auditoría con el mismo nonce. Verifica IDs de imagen, salud y secretos. Permite restablecer B23 solo antes de migrar o tras una restauración supervisada del esquema 23. |

La nueva ruta B30 usa el controlador v2 únicamente para verificar B23 antes del comienzo. La regla sudo v2 se suspende al iniciar la promoción; no puede operar silenciosamente contra esquema 30. La guardia B30 limita los comandos y valida el paquete antes de delegar. `B30_STAGING_PREPARED` concede solo `doctor`; `B30_STAGING_READY` requiere clave pública revisada, digests GHCR publicados y fuente B23 fijada. El instalador no modifica servicios ni base de datos.

## Identidad del candidato y artefactos locales

La API de recuperación estaba limitada a 23 migraciones. Se amplió el catálogo y las comprobaciones estructurales hasta 30 en el commit local `2f89b87f1f636feb7e21d7e09af03959ee95f68d`, sin modificar migraciones históricas. La prueba de recuperación B23→B30 sobre PostGIS descartable pasó: preservó datos B23, rechazó un índice B30 ausente con el gate cerrado, validó la recuperación con dos custodios, abrió el gate, registró el evento de auditoría y rechazó una repetición.

El nuevo inventario de aplicación `b30-staging-candidate.json` cubre **239 archivos** del commit y tiene SHA-256 `3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b`. Fija el prefijo B23 `90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d` y las 30 migraciones B30 `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`. El constructor rechaza deriva de código de aplicación respecto del commit.

Paquete local preparado **sin firma de staging**: `artifacts/b30-packaging/controller-b30-staging-controller-prepared.tar.gz`, **64 453 bytes**, SHA-256 `8d36ff5b48553c396673a8bd6bc779f7f2806afbb0fb6553db13c5d5f08aec54`, 20 miembros. Dos construcciones independientes produjeron bytes idénticos. Su política tiene `activation=DISABLED`, `publicationReady=false`, clave/firma pendientes y referencias de registro nulas. El paquete preparado anterior permanece solo como evidencia histórica; no es el controlador adaptado.

Imágenes **locales**, sin digest de registro:

| Imagen | ID local | Comprobación |
| --- | --- | --- |
| API `geops-b30-staging-api:2f89b87` | `sha256:37f9e5488f73230304adf8de90bfefff997391abb57299c92e5eca06b77b830f` | Revisión, variante, etiqueta `recovery.max_schema=30`, binario compilado de recuperación B30 y 30 SQL. |
| Web `geops-b30-staging-web:2f89b87` | `sha256:59c8175259358dc3335eb153c6697730fdf1e2faf8f2577362dae1cff2424522` | Revisión, variante y MDM habilitado. |

Estos IDs locales **no** sustituyen `RepoDigests` de GHCR. El controlador exige referencias `ghcr.io/kmena/geops-api|web@sha256:…`, `RepoDigests` coincidentes, etiquetas de revisión/variante, 30 SQL y código de recuperación B30 dentro de la imagen API. No se generó un manifiesto de publicación definitivo.

## Validación ejecutada en esta ejecución

| Procedimiento / entorno | Resultado | Límite |
| --- | --- | --- |
| `candidate.py verify` contra Git | PASS; 239 archivos, hash indicado | Fuente local del commit. |
| Construcción local API y Web con `docker build --pull=false` | PASS; IDs indicados | Sin push ni digest GHCR. |
| Inspección de imágenes locales y contenido API | PASS; recuperación 30 y 30 SQL | No prueba carga desde registro. |
| `docker compose config` staging con overlays MDM, digest y migración | PASS; 6 servicios | Referencias y secretos sintéticos, sin levantar servicios. |
| `test_linux.py` en Linux root, `--network none` | **16/16 PASS** sobre paquete preparado final | Clave Ed25519 efímera de laboratorio; `from-b23` sintético. |
| `test_ready_linux.py` en Linux root, `--network none` | **9/9 PASS**; instalación `READY` desde B23, `visudo`, `sudo doctor`, shell/comando desconocido bloqueados, idempotencia | Digests y clave sintéticos; no es un bundle publicable. |
| `test_controller_linux.py` en Linux root, `--network none` | **13/13 PASS**; firma, contexto/Compose, prefijo parcial de migraciones, transición 23→30, journal, gate, auditoría, recuperación e idempotencia | Runner Docker simulado; no ejecuta contenedores de staging. |
| `maintenance-recovery-b30.integration.mjs` en PostGIS descartable | PASS; 23→30 y recuperación supervisada | Evidencia de DB/API, independiente del controlador. |
| Build API, lint dirigido y sintaxis Python | PASS | No se repitieron suites funcionales SPEC-03, por alcance de esta etapa. |

Los recursos PostGIS descartables y la clave privada sintética se retiraron tras probar. No se usaron secretos reales. La API y Web de staging no fueron detenidas ni modificadas.

## Procedimiento supervisado futuro — no ejecutado

1. **Puerta de identidad.** El operador verifica por canal independiente la clave pública Ed25519 aprobada y el estado B23 real: hashes del wrapper/política, perfil steady, `verify`, gate abierto, 23 checksums, backup y prueba de restauración. Cualquier diferencia bloquea la instalación.
2. **Puerta de publicación.** Con autorización específica, publicar las imágenes del commit `2f89b87` en GHCR y registrar sus `RepoDigests` inmutables. Construir una política `B30_STAGING_READY` con esos digests, clave pública revisada, región MDM y hashes B23 observados. Revisar el tar byte a byte, firmar su hash con la clave autorizada y comprobar la firma por separado. Nunca usar la clave efímera de laboratorio.
3. **Autorización de instalación.** Obtener aprobación independiente para acceder e instalar en staging. Copiar instalador, paquete, firma y clave a rutas root protegidas. Comparar SHA-256 dentro y fuera del servidor. Ejecutar manualmente `install.py from-b23` con el SHA del paquete, SHA de clave y hashes B23 aprobados. Confirmar journal, `visudo -c` y `geops-b30-staging doctor`. La instalación no inicia una promoción.
4. **Autorización de actualización.** Con una ventana y aprobación nuevas, firmar los documentos de release, restauración y aprobación ligados al estado actual. Ejecutar secuencialmente `prepare <release-id>`, `begin <release-id> <approval-id> <restore-id>` y `migrate`. Si se corta antes de migrar, `recover` puede regresar a B23; tras migrar, no forzar un downgrade.
5. **Recuperación supervisada.** Con API/Web detenidas, dos custodios autorizan el procedimiento de recuperación B30 y verifican el gate, 30 checksums y el evento `maintenance.recovery.validated`. Firmar la atestación de recuperación vinculada al nonce, ledger y auditoría. Ejecutar `recover <recovery-id>` y `verify`. Confirmar salud y hashes de secretos sin imprimirlos. Un fallo conserva el journal y exige intervención supervisada.

Ningún paso remoto o de publicación está automatizado por esta entrega.

## Decisión de cierre

La adaptación de código, instalador, paquete reproducible, imágenes locales y recuperación B30 están verificadas. **No se declara `B30_STAGING_CONTROLLER_TECHNICAL_PASS` todavía** porque la suite del controlador usa un runner Docker simulado y no hay una actualización completa B23→B30 con este controlador contra contenedores y PostgreSQL de una réplica aislada de staging. Tampoco existen la clave pública aprobada ni digests GHCR; esas dos decisiones tienen puertas independientes y no autorizan instalación.

La condición técnica restante para PASS es ejecutar el controlador instalado por `sudo` en una réplica Linux aislada de la topología staging, con B23 real, imágenes B30 locales referenciadas mediante un registro de laboratorio con digest, `geops-migrate`, recuperación supervisada, health checks y dos inyecciones de fallo. Registrar el journal, ledger y gate antes/después. La verificación final de clave, publicación GHCR e instalación en staging siguen siendo autorizaciones independientes.
