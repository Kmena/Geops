# SPEC-03 — Integration & Release Readiness

**Corte local:** 2026-10-26. **Estado:** `RELEASE_CANDIDATE_PARTIAL`.

`STAGING_DEPLOYMENT_PENDING` · `PHYSICAL_VALIDATION_PENDING` · `SPEC03_OPERATIONAL_PASS = NO`

`DEPLOYED = NO` · `PUSHED = NO` · `MERGED_TO_MAIN = NO` · `MERGED_TO_STAGING = NO`

## A. Estado Git y respaldo

La rama candidata aislada es `codex/spec03-release-candidate` en `C:/Users/kmena/.codex/worktrees/spec03-release-candidate/Geops`. Parte de `79a8a1cb6c1fc7751ea29c1ad18846d1456edfbf` (`codex/spec03-mdm-integration`), que ya incluía Waves 1–4A y MDM. Se copiaron con verificación SHA-256 los 55 archivos modificados/sin seguimiento de `codex/spec03-wave5`, que contenían Wave 4B y Wave 5. El commit local de integración es `9ff905fbf02c41bb952104b1da17f70f103219ba`. Los worktrees Wave 1, Wave 4B y Wave 5 originales no se editaron; el checkout principal `codex/spec-02-wave-1` tenía cambios ajenos y tampoco se editó.

Antes de crear la candidata se respaldaron 155 archivos: 59 de Wave 1, 41 de Wave 4B y 55 de Wave 5. Cada entrada lleva ruta, rama, HEAD, estado, tamaño y SHA-256. La copia del respaldo está en `artifacts/spec03-release-backup-20261026-150736/` dentro del worktree candidato, ignorada por Git. `manifest.json` tiene SHA-256 `6840a528f7a9faec3353c59e421ce2ed6016414082e39ef21befa21a112916e1`; los 155 hashes coincidieron con las copias y con los archivos de origen al verificar. Reconstrucción: checkout del HEAD registrado para cada worktree y superposición de los archivos del subdirectorio correspondiente. No se usó reset/clean ni se eliminaron worktrees.

## B. Inventario consolidado

El commit contiene clientes, sedes y geozonas circulares; rutas publicadas versionadas; agentes, asignaciones, snapshots, recurrencias y calendario; vínculos temporales agente–dispositivo; atribución de GPS persistido; motor de permanencia y evaluación; dashboard e historial; y las rutas MDM/GPS existentes. La candidata añade continuidad GPS para dispositivos GEOPS sin binding MDM. El manifiesto local inventaría **612 archivos** de fuente/documentación y sus SHA-256; las salidas `dist`, `node_modules`, respaldos y secretos no forman parte del candidato. Android, protocolo GPS v2 y ACK no se modificaron.

## C. Migraciones y datos

| Versión | SHA-256 SQL |
| --- | --- |
| 0023 MDM OAuth client | `ec991513e907488543dc2442329a6f823a944bc6f10386318c7d8082607f88e9` |
| 0024 clientes/geozonas | `5b2a1cdfc479cf63057fc1081b81d76133d4e0fbcf10308170d3514168a573be` |
| 0025 rutas | `8e53fb4beddafe36be9a192221f4c324be18b0317fce7f339730a604566b4a06` |
| 0026 agentes/asignaciones | `02d793841115f23da07fc0d43a71729415b57369996dc728663b84d9b84ea115` |
| 0027 permanencia | `ebc405d652b8e902e4031d49fb5ad8d1630d12a4d5b76be662840f7e9fc23898` |
| 0028 vínculos temporales | `fec1d922f7c8e79a2cebab75153ac94467f5cfa683154ceb27b0f9a0679a5c80` |
| 0029 identidad GPS GEOPS | `1f818a9362905b1ab27e8a4aab2aaa7a171335116132134c83a171a35906e5e3` |
| 0030 continuidad GEOPS sin MDM | `ee9f644c0026874fc6fac3ace7410bf44ba45b2d9672a4dc844c058fe6b614ba` |

0030 fue autorizado expresamente después de detectar que `gps_continuity_alert.mdm_binding_id` era obligatorio. Es aditivo; 0023–0029 no se reescribieron. El hash del prefijo B23 es `90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d`; el de 0029 es `67d2bc473b90f5d3f4ccdb09c98bfb25b60b0626f438752ffa795da8b10627c0`; el listado final B30 es `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`.

En Docker Compose con PostGIS 18-3.6 descartable pasaron: instalación 0001→0030, B23→B30, 0027→B30 y reejecución sin nuevas operaciones. La fixture B23 conservó usuario/permiso, integración MDM, binding, instalación, sesión y posición GPS; los catálogos SPEC-03 aparecen después de B23 y se cubrieron en la instalación nueva y suites de Waves. La migración 0016→0030 conservó alertas históricas; B22→B30 y 0015→0030 pasaron en la regresión MDM. No se aplicaron migraciones a bases persistentes. No hay downgrade SQL automático: si se interrumpe tras 0030, se debe recuperar hacia API B30 compatible.

## D. Manifiesto

[`release-candidate-manifest.json`](release-candidate-manifest.json) es una **revisión local**, no un manifiesto de publicación firmado. Identidad `spec03-b30-7927fd2070465362ca49`; SHA-256 del manifiesto `02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f`. Declara esquema fuente mínimo 23, objetivo 30, hashes de fuentes/migraciones, orden de aplicación, aplicaciones detenidas durante el cambio y recuperación sin downgrade. `verify` pasó tras el commit y rechazó un hash de archivo alterado. Los digests API/Web, CI de publicación y firma están `null/PENDING` porque no se construyeron ni publicaron imágenes GHCR; no se inventaron referencias.

## E. Controlador y recuperación

El controlador remoto v2 y su política/firmador/instalador siguen limitados a B23. Sus 26 pruebas locales pasan, pero **no aceptan B30**. `scripts/deploy/spec03-upgrade-supervisor.mjs` es un supervisor de laboratorio con journal por fase y regla de seguridad: detener Web/API y cerrar gate antes de migrar; una vez en B30, no arrancar B23; recuperación previa a la migración hacia B23 y posterior hacia B30. Pasó **20/20 pruebas** de secuencia, interrupción y fallo durante/después de nueve fases, recuperación desde copia del journal y rechazo de ledger alterado. La prueba usa un adaptador simulado para API/Web; no constituye adaptación ni instalación del controlador remoto. La actualización supervisada completa y sus firmas siguen pendientes.

## F. Laboratorio

El proyecto Compose `compose.spec03-release-lab.yaml` inicia solo PostgreSQL/PostGIS local con credenciales sintéticas y se elimina con sus volúmenes al terminar. La matriz incluye la prueba de continuidad POCO: **50/50 comprobaciones** de alerta sin binding, idempotencia, permisos/tenant, health, posiciones y resolución. Las pruebas de Waves y Web usaron sus runners locales con bases descartables. Se indujeron fallos en cada fase del supervisor simulado; no se ejecutó una actualización real de contenedores API/Web B30 ni del controlador remoto. Por eso la simulación de despliegue extremo a extremo solicitada permanece `NOT_RUN`.

## G. Regresiones ejecutadas en esta rama

| Suite | Resultado |
| --- | --- |
| Wave 1 clientes/geozonas | 57/57 |
| Wave 2 rutas | 76/76 |
| Wave 3 agentes/calendario | 70/70 |
| Wave 4A permanencia | 40/40 |
| Wave 4B identidad/GPS | 53/53 |
| Wave 5 dashboard | 72/72 |
| Suite MDM/GPS en PostGIS | 16/16 scripts |
| GPS política / health / operaciones | 48/48, 37/37, 58/58 |
| Chrome Waves 1, 2, 3, 5 en escritorio y 390 px | 15/15, 14/14, 20/20, 21/21 |
| Supervisor B30 / controlador v2 | 20/20, 26/26 |
| `npm test`, build, typecheck | PASS / PASS / PASS |
| Biome dirigido (14 archivos JS/TS), `git diff --check` | PASS, 0 diagnósticos / PASS |

La suite MDM/GPS inicial detectó una fixture POCO con tenant inválido; se corrigió y se ejecutó completa de nuevo: 16/16 PASS. Los primeros intentos de los runners sin dependencias compiladas no cuentan como regresión; se instaló desde el lockfile y se repitieron. El lint global conserva la deuda externa de 12 advertencias indicada en Wave 5; no se usó como evidencia de lint limpio. Las latencias sintéticas del dashboard bajo suites concurrentes no son un umbral operativo.

## H. Seguridad

La autorización administrativa y el aislamiento por tenant fueron cubiertos por las suites SPEC-03, GPS y MDM. Para continuidad sin binding, el trigger SQL exige `geops_device_tenant`, la FK MDM continúa para valores no nulos, `NULLS NOT DISTINCT` impide duplicar una alerta abierta y la consulta administrativa exige dos permisos más concesiones de datos/health. No se añadieron coordenadas al dashboard ni secretos al manifiesto. Un ledger diferente, una API vieja sobre B30 o una combinación incompleta bloquean la transición de laboratorio. La revisión de seguridad de un controlador remoto B30 y del paquete firmado está pendiente.

## I. Pendientes y decisión

1. Implementar y probar controlador remoto B30, política, firmador, instalador, preflight real, journal persistente y recuperación con imágenes API/Web B30. El v2 no debe operar sobre B30.
2. Construir imágenes locales desde el commit exacto, verificar compatibilidad API/DB y Web/API, ensayar update/health/reintento/fallos con Docker Compose y recién entonces obtener digests reales y CI de publicación.
3. Aprobar retención de posiciones, evidencia derivada, historial de evaluaciones y auditoría, incluida purga y capacidad de reprocesar.
4. Calibrar físicamente precisión, permanencia, huecos máximos e histéresis; completar protocolo con y sin MDM sobre dispositivos autorizados.
5. Obtener autorización específica antes de cualquier staging. No se recomienda autorizarlo todavía.

## J. Estado final

`RELEASE_CANDIDATE_PARTIAL`: fuentes consolidadas, commit local, respaldo y hashes verificables, migraciones y regresiones locales en PASS. Faltan el controlador remoto compatible y una actualización supervisada real con imágenes B30, por lo que no se satisfacen los criterios de `RELEASE_CANDIDATE_TECHNICAL_PASS`. La validación física y operación continúan pendientes de forma independiente.
