# B30 — Validación integral del controlador en réplica aislada de staging

**Ejecución local:** 2026-10-27. **Rama:** `codex/b30-packaging-readiness`. **Base:** `83a75e2d35b284cfdee19716cf617a77d348a2b4`.

`B30_STAGING_CONTROLLER_TECHNICAL_PASS = YES`

`STAGING_ED25519_TRUST_KEY = PENDING_OPERATOR_VERIFICATION`

`STAGING_BUNDLE_SIGNATURE = PENDING`

`GHCR_PUBLISHED = NO`

`STAGING_CHANGED = NO`

## Entorno y alcance

Se ejecutó el controlador B30 instalado por el instalador real de Linux, con `sudo` y `visudo`, contra servicios reales en `docker:27-dind`. El daemon estuvo en un contenedor `--privileged --network none`, accesible solo por un socket Unix compartido con un runner Linux sin red. No se montó el socket Docker del host ni se contactó GHCR, staging o producción. El daemon, runner, volúmenes y archivos de imagen tuvieron nombres exclusivos `geops-b30-replica-20261027-a-*`.

La topología interna usó los archivos Compose y overlays MDM/digest/migración de staging, el proyecto `geops-spec02-staging`, PostGIS 18-3.6, gate, secretos sintéticos, API/Web B23 y las imágenes B30 del commit de aplicación `2f89b87f1f636feb7e21d7e09af03959ee95f68d`. El wrapper B23 fue una fixture de laboratorio que ejecutó comprobaciones reales de ledger 23 y salud API/Web; su política, estado y sudoers imitaron los contratos revisados B23. El controlador B30 y su instalador **no** fueron sustituidos.

GHCR sigue sin publicación autorizada. Un adaptador **LAB_ONLY** sustituyó exclusivamente dos referencias GHCR sintéticas por las imágenes locales al ejecutar Docker y devolvió esas referencias al inspeccionar `RepoDigests`. Las operaciones `compose`, `run`, `exec`, `inspect`, migración, gate y arranque se realizaron sobre el daemon real. Los digests sintéticos no acreditan procedencia ni contenido del registro; esa puerta sigue pendiente. El adaptador también indujo un fallo de comando de un solo uso en cada punto especificado.

## Instalación y corrección detectada

Se partió de 23 migraciones, gate abierto y API/Web B23 saludables. Se sembraron un administrador, dos custodios, un dispositivo, un binding MDM y una instalación GPS sintéticos. El instalador verificó SHA-256, pin de clave pública, firma Ed25519 de laboratorio, política B23, `visudo` y `sudo doctor`. El paquete `READY` de laboratorio tuvo SHA-256 `2a048ef7ba9f2afbfff07f3f00c8fe47f1292e8cd55e2ea1e2c523b8162a3013`. La clave privada efímera se eliminó al terminar la ejecución. Esta firma no es la de staging.

La primera prueba real detectó que `verify_compose` esperaba la imagen API B30 para `geops-migrate`, mientras el render normal omitía `compose.staging.migrate.digest.override.yaml` y conservaba B23. Se corrigió `controller.py` para incluir ese overlay en todas las operaciones B30 y se reconstruyó el paquete. La corrida limpia posterior pasó. Los tropiezos iniciales de la fixture —clave base64url no canónica y sudoers con CRLF— se corrigieron en el harness; no se cambió el contrato de staging para ocultarlos.

Paquete preparado corregido, local y **sin firma de staging**: `artifacts/b30-packaging/controller-b30-staging-controller-prepared.tar.gz`, 64 450 bytes, SHA-256 `82880dfbd1f8e44fee2aab95aa009844cf8609d409e13586789febd37d28390f`. Una segunda construcción produjo exactamente el mismo hash. La política preparada mantiene `activation=DISABLED`, firma pendiente y digests nulos.

## Matriz de ejecución real

La corrida limpia `run_replica.py` terminó con **13/13 controles PASS**:

| Control | Evidencia observada |
| --- | --- |
| Línea base B23 | API/Web/PostGIS saludables, 23 migraciones y gate abierto. |
| Datos sintéticos MDM/GPS | Un `mdm_binding` y una `gps_device_installation`; persistieron tras B30. |
| Instalación privilegiada | `install.py from-b23`, paquete firmado con clave LAB_ONLY, `visudo`, `sudo doctor` y comandos B30 por `sudo` del usuario `abi`. |
| Drenaje y gate | `prepare` y `begin` detuvieron API/Web y cerraron gate antes de migrar. |
| Fallo antes de migrar | El adaptador hizo fallar una vez `compose run geops-migrate`; ledger quedó en 23. Recuperación supervisada B23 abrió gate y el controlador reinició API/Web B23 saludables. |
| Actualización B23→B30 | Nueva aprobación firmada; el controlador aplicó siete migraciones y obtuvo ledger de 30 con hash `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`. |
| Bloqueo B23 | La regla sudo v2 quedó deshabilitada en esquema 30. La función de readiness de la imagen API B23 devolvió `false` contra ese esquema. |
| Fallo después de migrar | El adaptador hizo fallar una vez el arranque B30 tras abrir el gate mediante recuperación supervisada. El ledger permaneció en 30; el journal quedó apto para reintentar. |
| Recuperación e idempotencia | `recover` reanudó API/Web B30; `verify` pasó; repetir `recover` devolvió `ALREADY_COMPLETE`. |
| Estado final | Gate `open`, journal `complete`, API/Web/PostGIS `healthy`. MDM habilitado con región `com`; binding y activación GPS presentes. |

La recuperación de gate en ambos escenarios se ejecutó con el motor real de la API correspondiente y tres identidades sintéticas: administrador y dos custodios. El controlador exigió el evento de auditoría de recuperación, el mismo nonce y el ledger exacto antes de iniciar servicios. No se forzó rollback de una base en esquema 30.

**Identidad final de imágenes locales:** API `sha256:37f9e5488f73230304adf8de90bfefff997391abb57299c92e5eca06b77b830f`; Web `sha256:59c8175259358dc3335eb153c6697730fdf1e2faf8f2577362dae1cff2424522`; PostGIS `sha256:fcc669d633929455d7c1d4af5c5752459a078559992905fce3c1c1936112cefa`. El hash final del ledger fue `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`. La prueba MDM/GPS aquí es de configuración y persistencia, no una repetición del protocolo GPS ni de las suites funcionales completas.

## Comprobaciones dirigidas y limpieza

- `test_linux.py` contra el paquete corregido: **16/16 PASS** (firma, permisos, instalación, sudoers, interrupción e idempotencia).
- `test_controller_linux.py` contra el controlador corregido: **13/13 PASS** (contratos, prefijo parcial, firma, gate, recuperación y reintentos).
- `run_replica.py` contra Docker y PostGIS reales: **13/13 PASS** con dos fallos de comando inducidos.
- Sintaxis Python: **11 archivos PASS**. Se conservó la prueba PostGIS previa de recuperación 23→30 y no se repitieron suites completas SPEC-03 por el alcance solicitado.

Se ejecutó `docker compose down --volumes` dentro del daemon descartable, se retiró la red externa exclusiva de la réplica y se comprobaron **0 contenedores y 0 volúmenes internos**. Después se eliminaron únicamente el runner, daemon, tres volúmenes externos dedicados, imagen de runner y exportación temporal de cinco imágenes. Verificación final: **0 contenedores, 0 volúmenes, 0 imágenes de runner y sin tar temporal** con esos nombres. Se conservaron las imágenes locales preexistentes y todos los worktrees.

## Cierre y puertas independientes

La compatibilidad técnica del controlador B30 con la topología de staging quedó demostrada en Linux aislado con servicios reales y fallos recuperables: `B30_STAGING_CONTROLLER_TECHNICAL_PASS`. El adaptador de digest y la clave LAB_ONLY limitan esta conclusión al laboratorio. Quedan tres autorizaciones independientes: verificar la clave Ed25519 y firmar el bundle definitivo; publicar API/Web B30 en GHCR y comprobar sus digests reales; instalar el controlador y actualizar staging de forma supervisada. Esta ejecución no realizó ninguna de ellas.
