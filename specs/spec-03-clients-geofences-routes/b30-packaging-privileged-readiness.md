# B30 — Packaging & Privileged Controller Readiness

**Corte local:** 2026-10-26 (America/Guatemala). **Estado:** `B30_PACKAGING_READINESS_PARTIAL`.

`GATE_A_PRIVILEGED_LAB = PASS` · `GATE_B_VERIFIABLE_PUBLICATION = PARTIAL` · `STAGING_READY = NO`

`STAGING_CHANGED = NO` · `GHCR_PUBLISHED = NO` · `PUSHED = NO` · `MERGED = NO`

## 1. Aislamiento y alcance

La rama aislada `codex/b30-packaging-readiness` parte de `b717005fc893c7e5683e02b2cd4e915889de75e5`, el commit del laboratorio B30. No se modificaron SPEC-03, GPS, MDM, Android, migraciones SQL ni el candidato original. El código nuevo está en `scripts/deploy/b30-packaging/`. Los artefactos binarios locales están en `artifacts/b30-packaging/`, ignorado por Git; la evidencia pública está en `b30-packaging-publication-evidence.json`.

La cadena remota existente sigue siendo v2/B23: política de perfiles hasta 23, instalador `install-v2.py`, firmador v2 y controlador `geops_deploy_v2.py`. Sus rutas y el `sudoers` de staging no fueron reemplazados. El paquete creado aquí se identifica de forma inequívoca como `B30_PRIVILEGED_LAB_ONLY`, exige claves efímeras sintéticas y **no puede activarse como controlador de staging**.

## 2. Puerta A — laboratorio privilegiado

Se implementó un empaquetador determinista de 215 archivos: controlador B30 del laboratorio, supervisor, Compose, manifiesto fuente, instalador, lanzador privilegiado, reglas sudo y dependencias Node necesarias para `pg` y `argon2`. La política incluye hashes de cada archivo, fuente `15f77a0d1904b77833972d8e2fd628a6cb97678f`, prefijo B23 de 23 migraciones y destino B30 de 30. El constructor rechaza cambios comprometidos o pendientes en API/Web/contratos/Dockerfiles respecto del commit revisado. La primera prueba real detectó la falta de `argon2`; se corrigió el inventario y se reconstruyó antes del cierre.

`install.py` exige root Linux, paquete y clave pública en rutas protegidas, SHA-256 revisado y firma Ed25519. Comprueba inventario tar, tipos de archivo, hashes y su propio código firmado. Copia archivos a `/opt/geops-b30-lab` con propiedad root, fija el hash de la política, instala `/usr/local/sbin/geops-b30-lab`, valida `visudo` y activa `/etc/sudoers.d/geops-b30-lab` **al final**. El journal permite repetir la misma instalación después de un corte. En modo `from-b23` contrasta hashes revisados del controlador/política v2, estado B23 steady, regla sudo v2 exacta y `verify` del controlador anterior; preserva los archivos y permisos v2. Este modo se probó con una fixture sintética que ejecutó un verificador B23 controlado.

`privileged.py` acepta únicamente `doctor`, `init`, `status`, `verify`, `upgrade` y `recover`, con directorio de laboratorio fijo. Antes de delegar valida propiedad root, modos, ausencia de symlinks, hash fijado de la política y todos los archivos del bundle. `init` queda reservado al operador root; `sudoers` permite al usuario `abi` solamente `doctor`, `status`, `verify`, `upgrade` y `recover`. Usa argumentos fijos y entorno saneado.

El paquete final `artifacts/b30-packaging/controller-b30-lab.tar.gz` mide **560 449 bytes**, SHA-256 `895c12fa18045027cf1a876bca931a84ec7deb576740e98a3d6f59b5e8895468`. Una segunda construcción produjo bytes idénticos. Se verificó su firma Ed25519 después de eliminar la clave privada efímera. La firma y clave pública de esta construcción están en el directorio local ignorado `artifacts/b30-packaging/`.

Prueba real en contenedor Linux descartable, `--network none`, con root, `visudo` y `sudo`:

| Control | Resultado |
| --- | --- |
| Firma válida; firma falsa; SHA incorrecto | 3/3 PASS |
| Instalación limpia como root y `visudo -c` | 2/2 PASS |
| `abi` ejecuta `doctor` por sudo; `init` y shell arbitrario rechazados | 2/2 PASS |
| Reinstalación idéntica; política instalada manipulada rechazada | 2/2 PASS |
| Interrupción después del bundle y después de sudoers; reanudación | 2/2 PASS |
| Bundle instalado alterado rechazado | 1/1 PASS |
| Fuente B23 preservada; cambio de su sudoers rechazado | 2/2 PASS |

**Suite de instalación: 14/14 PASS** con el paquete corregido. La suite Linux preexistente del instalador v2 pasó 14 pruebas y omitió 1 caso condicionado por su harness; la suite Python del controlador v2 pasó 26/26 y el supervisor B23→B30 pasó 20/20 en la ejecución anterior. Esas suites previas no se cuentan como regresiones repetidas en este corte.

### Ejecución privilegiada real en Linux aislado

Se inició `docker:27-dind` con `--network none`, sin socket Docker del host ni listener TCP. Un runner Linux con `sudo`, Node y Docker CLI compartió únicamente el socket Unix y `/opt` con ese daemon. Se cargaron cinco imágenes locales: API/Web B23 y B30 y PostGIS. Se instaló el paquete firmado como root, `visudo -c` pasó y el usuario `abi` ejecutó `doctor`, `status`, `verify`, `upgrade` y `recover` por la regla sudoers exacta. `abi` no pudo ejecutar `init` por sudo.

La primera inicialización detectó un segundo defecto: el gate creado con modo `0600` impedía a la API Linux leerlo y readiness devolvía 503. Cambiar temporalmente el modo a `0644` produjo HTTP 200. La prueba adicional con `umask 077` detectó que el directorio gate también necesitaba modo `0755`. El controlador fija ambos modos explícitamente; con `umask 077`, API/Web pasaron salud y se repitieron actualización y recuperación con el paquete final.

| Prueba | Evidencia observada | Resultado |
| --- | --- | --- |
| Instalación limpia y firma | Paquete SHA-256 `895c12fa…895468`; `visudo -c` y `doctor` | PASS |
| Permisos con umask restrictivo | `umask 077`; gate directorio `0755`, archivo `0644`; API/Web saludables | PASS |
| Línea base B23 | 23 migraciones, hash `90ae7681…9022d`, API/Web B23, gate abierto | PASS |
| `abi` → `sudo upgrade` | Journal `complete`, 30 migraciones, hash `64e38eec…dfa7f6`, API/Web B30, gate abierto | PASS |
| Reintento de `upgrade` | Segundo `UPGRADE_PASS` con journal y estado B30 idénticos | PASS |
| Fallo `before-migrate` | `INJECTED_FAILURE`; `abi` → `sudo recover` devolvió `RESTORE_B23`, esquema 23 y API/Web B23 | PASS |
| Fallo `after-migrate` | `INJECTED_FAILURE`; `abi` → `sudo recover` devolvió `FORWARD_B30`, esquema 30 y API/Web B30 | PASS |
| Permisos | `abi` → `sudo init` pidió contraseña; comando no autorizado | PASS |

La inyección de fallos fue realizada por root directamente sobre el controlador de laboratorio; **la recuperación** se ejecutó por el wrapper instalado y autorizado en sudoers. `from-b23` del instalador se validó con un estado y verificador v2 sintéticos en la suite 14/14, preservando sus archivos. La compatibilidad con un controlador v2 real en un servidor seguirá pendiente de una inspección autorizada del servidor; no forma parte del PASS **del laboratorio aislado**. La Puerta A acredita la ejecución privilegiada local B23→B30 y sus dos rutas de recuperación.

## 3. Puerta B — paquete e imágenes

Se construyeron imágenes locales desde la aplicación sin cambios del commit `15f77a0`, con `--pull=false`, fuente OCI `https://github.com/Kmena/Geops`, revisión exacta y variante `B30-integrated`. Web se compiló con MDM habilitado. La API contiene 30 SQL con hash de lista `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`; Web contiene `index.html` y assets. Se registraron Dockerfiles, `package-lock.json` y IDs de las imágenes base en la evidencia pública.

| Imagen | ID local | Archivo Docker save, SHA-256 | Capas verificadas |
| --- | --- | --- | ---: |
| API `geops-b30-packaging-api:15f77a0` | `sha256:de7b3f5ed3203f1e17b5b885f9ecee48fcc16347cee0e1547118c52dd1077d8e` | `api-b30.tar`: `50c8c05fc143b691a5193e582646a10f8fd5d586b7c8d1f6ad13f773d6a86e55` | 14/14 |
| Web `geops-b30-packaging-web:15f77a0` | `sha256:d9e6d51e49946f1fd71710d22a0e0bb3487b791ec6a8d33dda9da0a70c1df432` | `web-b30.tar`: `303f57fb5eef1a62d563007942f8e2cea939d37b04b0789d56b5d6654bf7fce8` | 11/11 |

`verify-image-archive.py` verificó tag, arquitectura `amd64`, SHA-256 del JSON de configuración contra el ID inspeccionado y SHA-256 de **cada capa** contra `rootfs.diff_ids`. Un ID incorrecto se rechazó. `verify-publication.mjs` vuelve a contrastar archivos tar, etiquetas OCI, esquema, SQL, assets y hashes. El borrador público tiene SHA-256 `ad8d2f2f073644b2ceba4cd874c34c657529afcac92b33ebc779b419b82b098e`; `publishable` lo rechaza, como corresponde, porque el controlador es `LAB_ONLY`, `RepoDigests` está vacío y no hay digests GHCR.

En el primer corte se intentó un registro temporal sobre el loopback de Windows; el daemon de Docker Desktop no pudo alcanzarlo. La revisión automática rechazó exponerlo con `--network host`; esa alternativa no se utilizó. En este corte se creó un registro **dentro del daemon Docker aislado, cuyo contenedor exterior no tiene red externa ni puertos publicados en el host**. Se subieron allí las imágenes API/Web del laboratorio y se retiraron sus tags temporales; después se descargaron por digest desde el registro local. Los IDs recuperados coincidieron exactamente con los originales:

| Imagen | Digest del registro local | ID tras pull por digest |
| --- | --- | --- |
| API | `sha256:aaa74ab639c57f8f579de91b688518335cca903437097463aebfd824f94e1a6f` | `sha256:76747ce96729cc8c37eea2b3075cc88a0ee0597877421098c9a5542132cc7922` |
| Web | `sha256:b082028d6573cfb00413ba16af089ab24f5ee1df7f30c7b7fa058c87e6dc68f3` | `sha256:39528488d65a148b23126686910283bf147884262930503cea020813bb6df436` |

Se repitió el push, retiro de tag y pull por digest con las **imágenes candidatas de publicación** de los archivos `api-b30.tar` y `web-b30.tar`:

| Candidato | Digest del registro local | ID tras pull por digest |
| --- | --- | --- |
| API | `sha256:ac47790a71778dbff640edfc189d7cbd942a1ad1d22aa44f628f14cb702ce03b` | `sha256:de7b3f5ed3203f1e17b5b885f9ecee48fcc16347cee0e1547118c52dd1077d8e` |
| Web | `sha256:b57aaeb6a14a3d21aba62b28390f58dff45807cb5ecf2292df726f2c9081fe6e` | `sha256:d9e6d51e49946f1fd71710d22a0e0bb3487b791ec6a8d33dda9da0a70c1df432` |

Todos estos son **digests del registro local efímero**, no digests GHCR. La prueba valida la mecánica de push/pull por digest y coteja procedencia local sin publicar remotamente.

**Pendiente para cerrar B:** terminar y probar el paquete del controlador de staging, obtener digests reales de las imágenes candidatas API/Web en el registro de destino, cotejarlos mediante pull por digest y firmar un manifiesto publicable. El paquete actual es `LAB_ONLY` y el digest local de laboratorio no se puede sustituir por uno GHCR. Publicar en GHCR requiere autorización específica; no se solicitó ni efectuó en esta etapa. Por ello B permanece `PARTIAL`.

## 4. Resultado y recomendación

`GATE_A_PRIVILEGED_LAB = PASS`; `GATE_B_VERIFIABLE_PUBLICATION = PARTIAL`; estado global `B30_PACKAGING_READINESS_PARTIAL`. La actualización B23→B30 y la recuperación ya se ejecutaron mediante el controlador privilegiado en laboratorio Linux aislado. No hay instalación de controlador en staging ni digests GHCR. La Puerta B debe preparar el bundle publicable y cotejar digests del registro; la publicación en GHCR requiere autorización específica. Después de ambas puertas, la inspección y futura instalación en staging requieren autorización independiente.
