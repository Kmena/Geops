# GEOPS — B30: laboratorio de actualización y recuperación supervisada

**Fecha local:** 2026-10-26 (America/Guatemala). **Estado:** `B30_LAB_DEPLOYMENT_PARTIAL`.

`STAGING_DEPLOYMENT_PENDING` · `PHYSICAL_VALIDATION_PENDING` · `SPEC03_OPERATIONAL_PASS = NO`

`DEPLOYED = NO` · `PUSHED = NO` · `MERGED_TO_MAIN = NO` · `MERGED_TO_STAGING = NO`

## A. Git y aislamiento

Se creó el worktree `C:/Users/kmena/.codex/worktrees/b30-deployment-lab/Geops` y la rama `codex/b30-deployment-lab` desde el HEAD limpio `15f77a0d1904b77833972d8e2fd628a6cb97678f` de `codex/spec03-release-candidate`. El candidato original y el checkout principal no se editaron. La fuente B23 se extrajo mediante `git archive` del commit `f1b0aa8d3662c25634820ba5b9bf762433580a77`; contiene exactamente 23 migraciones. El manifiesto fuente B30 verificó 612 archivos y 30 migraciones con SHA-256 `02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f`. No se modificaron migraciones históricas.

## B. Imágenes locales

Las imágenes se construyeron con `docker build --pull=false`, sin publicación. Todas son Linux `amd64` y se inspeccionaron con `docker image inspect`. El Dockerfile API tiene SHA-256 `c3f9f22ce30c12a155b5de1f2534e5890a21b9d726fec2bab7558e0d2dff39d1`; el Web, `f3498a680f575c60d4883cac4b3d716f7c83ad1dd7b24684f49994bde817504d`. Dependencias fijadas por `package-lock.json`, Node 24.16.0 y Nginx unprivileged 1.27 Alpine.

| Imagen local | Fuente | ID local | Creada UTC |
| --- | --- | --- | --- |
| `geops-b30-lab-api:b23` | `f1b0aa8` | `sha256:27b9b28a1ee98e6ca1eb6dfc1a276827c10f42972bbd7ababdd3c06eee187932` | 2026-10-26 21:52:44 |
| `geops-b30-lab-web:b23` | `f1b0aa8` | `sha256:3d542d9571faa7bd60865f8675f48aeb48c339920157d7f51bc98de545a84db6` | 2026-10-26 21:52:10 |
| `geops-b30-lab-api:15f77a0` | `15f77a0` | `sha256:76747ce96729cc8c37eea2b3075cc88a0ee0597877421098c9a5542132cc7922` | 2026-10-26 21:51:47 |
| `geops-b30-lab-web:15f77a0` | `15f77a0` | `sha256:39528488d65a148b23126686910283bf147884262930503cea020813bb6df436` | 2026-10-26 21:49:31 |

El controlador ejecutó las imágenes API sin red para comprobar que contienen el listado SQL completo: B23 `90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d` y B30 `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`. Web B30 contiene `index.html` y assets. Los IDs son hashes **locales de imagen**, no digests GHCR.

## C. Manifiesto y política

El laboratorio introdujo un manifiesto **v3 local** con proyecto Compose, commit fuente, SHA-256 del candidato, hashes B23/B30, IDs locales y vencimiento. Se firma con Ed25519 efímero; el controlador verifica bytes, firma, vigencia, imágenes y compatibilidad. La copia pública verificable está en `b30-lab-manifest-evidence.json`. El manifiesto primario tiene SHA-256 `827aad52dad5cdb34e26778b9dada56e667cc994768c31f03fb8833fbd207aef`; la clave pública tiene SHA-256 `f3b15c58120d39be28c3e545953ab6b53201f2dabbc65bd20c98421dd95d9e5d`. La clave privada efímera se eliminó de las instancias iniciales y las nuevas no la escriben en disco. Los secretos sintéticos de ejecución se retiran al desmontar los proyectos; los journals y manifiestos públicos quedan en `artifacts/`, fuera de Git.

La política y firmador remotos v2 siguen siendo B23 y **no aceptan este v3 ni B30**. El manifiesto local demuestra integridad en el laboratorio, pero no reemplaza un bundle de publicación firmado ni autoriza staging.

## D. Controlador

`scripts/deploy/b30-lab/controller.mjs` es un adaptador real de laboratorio para el motor de transición SPEC-03. Controla Docker Compose, consulta el ledger PostgreSQL, verifica imágenes y firma, escribe un journal atómico, toma `pg_dump`, cierra el gate, detiene Web/API, migra dentro de la imagen B30, sustituye los contenedores, abre el gate y exige health checks antes de confirmar. Los proyectos y volúmenes se limitan a `geops-b30lab-*`; los puertos PostgreSQL se asignan al loopback. `clone` restaura una copia B23 verificando SHA-256; `down` elimina solo el proyecto/volumen asociado. El controlador rechaza iniciar o confirmar una API B23 sobre esquema B30 y nunca hace downgrade SQL.

Se corrigieron dos hallazgos reales del entorno: Compose detectaba listo el PostgreSQL temporal de inicialización antes del reinicio final, y Nginx requería el alias DNS `geops-api`. Los proyectos fallidos se desmontaron con `docker compose down --volumes` acotado y se reintentaron desde bases descartables nuevas. `install-controller.mjs` instaló un lanzador **local**, con manifiesto Ed25519 y hashes fijados del controlador, supervisor, seed, Compose, lockfile y manifiesto candidato. Su SHA-256 de manifiesto es `8bf10a82b5729115e8393c996f9b05033a02b98c5518de4195eea5c9c06352d1`; se usó en una actualización completa. **No se instaló ni probó como controlador privilegiado remoto**; sudoers/instalador v2 no se actualizaron.

## E. Migraciones y conservación

El proyecto primario arrancó B23 con 23 migraciones verificadas, API/Web B23 saludables y registros sintéticos de usuario, tenant, integración MDM, dispositivo, binding e instalación GPS. El backup previo a migrar tiene SHA-256 `538dadac09595da571306d08e84b7819b8a76a156d87dee4c9f1c71893c29601`. B30 aplicó 0024–0030 en PostGIS 18-3.6. El ledger final contiene 30 versiones y el hash de lista B30 esperado. El controlador verificó que las cinco identidades/datos sintéticos B23 permanecían después de la migración y de la recuperación. Un segundo laboratorio se restauró desde ese backup, preservó el ledger B23 y reejecutó la transición. No se aplicaron migraciones a bases persistentes.

## F. Actualización real

Comando: `node scripts/deploy/b30-lab/controller.mjs init artifacts/b30-lab-primary`, seguido de `upgrade` sobre el mismo directorio. Resultado: `B23_BASELINE_PASS`, luego `UPGRADE_PASS`; estado observado final `schema=30`, hash B30 correcto, `api=B30`, `web=B30`, `gate=open`. API y Web quedaron saludables en los contenedores de la actualización. `container-smoke.mjs` pasó 13 comprobaciones API sobre esos contenedores: login, capacidades, catálogos, calendario, dashboard, creación/lectura de cliente, creación de ruta/agente y rechazo 401 de GPS sin autenticación. Web sirvió su HTML/assets. Se ejecutó `upgrade` otra vez y mantuvo el estado B30 sin aplicar migraciones adicionales.

La corrida de medición repitió la restauración B23 y el upgrade completo **desde el lanzador local instalado** (`node artifacts/b30-controller-install-primary/launcher.mjs ...`): `UPGRADE_PASS`, 30 migraciones, API/Web B30 saludables, gate abierto, datos B23 conservados y 13/13 comprobaciones API + Web PASS. El journal completo y `events.jsonl` quedan en `artifacts/b30-lab-measured/` hasta la limpieza de contenedores.

Al finalizar, `controller.mjs down` desmontó solamente los tres proyectos todavía activos (`geops-b30lab-892d5a74`, `geops-b30lab-43cd6703` y `geops-b30lab-31d3d9b1`) y sus volúmenes descartables. Los proyectos de la matriz y del fallo de health ya estaban desmontados. `docker ps` confirmó **0 contenedores `geops-b30lab-*` activos**. Se retiraron 23 archivos locales `.env`/`lab-private.pem` con secretos sintéticos y la extracción temporal de B23. Permanecen los journals, manifiestos públicos, resúmenes y backups de laboratorio ignorados por Git para auditoría.

## G. Recuperación

Una copia B23 verificable se interrumpió **antes** de migrar: journal `migrate`, ledger B23, gate cerrado, API/Web detenidos; `recover` volvió a B23 saludable, abrió gate y preservó datos. Sobre ese B23 recuperado se reintentó con fallo **después** de migrar: ledger B30, API/Web detenidos, gate cerrado; `recover` avanzó a API/Web B30 sin downgrade, abrió gate, pasó health y conservó datos. La reejecución de `recover` y `upgrade` fue idempotente. El smoke de 13 comprobaciones API y Web pasó también después de la recuperación B30.

La matriz adicional ejecutó **11/11 escenarios en Docker/PostGIS real**, cada uno desde una restauración B23 independiente, con fallo inyectado, recuperación y reejecución. El resumen completo está en `artifacts/b30-lab-matrix-summary.json` y su copia pública en `b30-lab-fault-matrix-evidence.json`.

| Punto inducido | Esquema al fallar | Recuperación | Duración del caso |
| --- | ---: | --- | ---: |
| Antes de preflight | 23 | B23 PASS | 85,702 s |
| Antes de preparar bundle | 23 | B23 PASS | 97,660 s |
| Después de backup | 23 | B23 PASS | 82,547 s |
| Antes de API | 30 | B30 PASS | 75,663 s |
| Después de API | 30 | B30 PASS | 75,100 s |
| Antes de Web | 30 | B30 PASS | 80,004 s |
| Después de Web | 30 | B30 PASS | 79,301 s |
| Antes de health | 30 | B30 PASS | 95,323 s |
| Después de health | 30 | B30 PASS | 88,598 s |
| Antes de confirmar ledger | 30 | B30 PASS | 104,528 s |
| Durante recuperación | 30 | B30 PASS | 89,251 s |

Se ejecutaron además dos transiciones manuales: antes de migrar → B23 y después de migrar → B30, ambas PASS. Una prueba adicional inyectó `during-health` entre los probes de API y Web mediante el lanzador local instalado: esquema 30, gate cerrado y journal en `health` al fallar; `recover` avanzó a B30 con ambos servicios saludables, gate abierto y ledger íntegro. Resultado **PASS**.

## H. Seguridad

`security-check.mjs` rechazó siete controles inducidos: manifiesto manipulado, firma inválida, ID de imagen inesperado, secreto sintético ausente, journal incompleto, checksum de ledger alterado y comando de downgrade. Restauró los bytes/checksum originales tras cada caso; luego `upgrade` volvió a verificar B30 completo. El gate permaneció cerrado mientras se migraba. La revisión de permisos Linux, sudoers, instalador privilegiado, aprobación firmada de uso único y protección de secretos en el controlador **remoto** sigue pendiente.

## I. Regresiones ejecutadas ahora

| Procedimiento | Entorno | Resultado |
| --- | --- | --- |
| `npm test` | fuente, Node local | PASS, exit 0 |
| `npm run build`, `npm run typecheck` | fuente, Node local | PASS / PASS |
| `npx biome check scripts/deploy/b30-lab/*.mjs` | archivos nuevos | PASS, 0 diagnósticos |
| `run-spec03-wave5-integration.ps1` | PostGIS descartable | Wave 1 57/57, Wave 2 76/76, Wave 3 70/70, Wave 4A 40/40, Wave 4B 53/53, Wave 5 72/72; 0027→0030 PASS |
| `run-spec03-mdm-integration.ps1` | PostGIS descartable | 16/16 scripts; GPS eventos 69, mixed 64, continuidad 50, scheduler 4, capability 19, tenant 43, usuarios 42 |
| `run-spec03-wave5-browser-e2e.ps1` | Chrome escritorio/390 px | Wave 1 15/15, Wave 2 14/14, Wave 3 20/20, Wave 5 21/21; GPS policy 48, health 37, operaciones 58 |
| `spec03-upgrade-supervisor.test.mjs` | motor fuente | 20/20 |
| `test_geops_deploy_v2.py` | controlador v2 fuente | 26/26 |
| `container-smoke.mjs` | **contenedores B30 actualizados** | API 13/13, Web HTML/assets PASS; repetido tras recuperación B30 |
| `security-check.mjs` | controlador/ledger local | 7/7 rechazados como se esperaba |
| `fault-matrix.mjs` | 11 proyectos Docker/PostGIS descartables | 11/11 recuperación y reintento PASS |
| `during-health` adicional | lanzador local instalado, Docker/PostGIS | recuperación hacia B30 PASS |
| `metrics.mjs` | contenedores B30 actualizados | 10/10 probes API y 10/10 Web |

Las integraciones y E2E ejercitan el código fuente en sus propios runners, mientras `container-smoke.mjs` ejercita los contenedores efectivamente promovidos. Las pruebas de GPS v2 y MDM no utilizaron dispositivos ni credenciales reales. No se ejecutó una regresión HTTP completa de todos los flujos SPEC-03 sobre los contenedores promovidos.

## J. Rendimiento y estabilidad

`metrics.mjs` midió en la corrida completa del controlador local instalado: **32,267 s** desde preflight hasta journal completo; ventana desde inicio de `drain` hasta confirmación **26,931 s** (cota de indisponibilidad, no medición externa de tráfico); migración **3,137 s**; preparación/arranque de API **3,260 s** y Web **3,150 s**; probes previos a abrir gate **2,072 s**. Las 10 muestras de health guardadas en la evidencia oscilaron entre **15,323 y 72,765 ms** para API y entre **0,579 y 9,463 ms** para Web. Reintentos de migración en esta corrida: **0**. En el fallo previo a migrar, recuperación B23 9,2 s; en el posterior, recuperación B30 10,1 s. `docker stats --no-stream` del proyecto B30 primario mostró Web 0,82 % CPU / 6,94 MiB, API 0,01 % / 42,49 MiB y PostGIS 0,03 % / 81,8 MiB (muestras instantáneas). Son medidas de Docker Desktop local, no SLA ni predicción de staging.

## K. Riesgos y diferencias con staging

El laboratorio corre en Windows/Docker Desktop con PostGIS local, claves efímeras, imágenes por ID local y datos sintéticos. Staging usa controlador v2, sudoers, gate y secretos protegidos, firmas/aprobaciones y digests de registro. La política v2 solo reconoce B23. La adaptación local no prueba instalación privilegiada, manifest de publicación, pull por digest, rutas reales de Nginx/SSH, backup de staging ni límites operativos del host. Tampoco hay evidencia física GPS/MDM ni calibración. Por tanto no se recomienda autorizar staging a partir de este ensayo.

## L. Estado final

`B30_LAB_DEPLOYMENT_PARTIAL`: B23→B30 real, recuperación antes y después de la migración, datos, checksums, contenedores, firma local, matriz de fallos y regresiones han pasado. Falta instalar/probar un controlador **remoto privilegiado** B30 compatible con la política/firmador existentes, sus aprobaciones de un solo uso y el bundle de publicación por digest. El lanzador local no demuestra ese límite de privilegios. `STAGING_READY = NO`.
