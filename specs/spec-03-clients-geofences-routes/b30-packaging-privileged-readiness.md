# B30 — Packaging & Privileged Controller Readiness

**Corte local:** 2026-10-26 (America/Guatemala). **Estado:** `B30_PACKAGING_READINESS_PARTIAL`.

`GATE_A_PRIVILEGED_LAB = PARTIAL` · `GATE_B_VERIFIABLE_PUBLICATION = PARTIAL` · `STAGING_READY = NO`

`STAGING_CHANGED = NO` · `GHCR_PUBLISHED = NO` · `PUSHED = NO` · `MERGED = NO`

## 1. Aislamiento y alcance

La rama aislada `codex/b30-packaging-readiness` parte de `b717005fc893c7e5683e02b2cd4e915889de75e5`, el commit del laboratorio B30. No se modificaron SPEC-03, GPS, MDM, Android, migraciones SQL ni el candidato original. El código nuevo está en `scripts/deploy/b30-packaging/`. Los artefactos binarios locales están en `artifacts/b30-packaging/`, ignorado por Git; la evidencia pública está en `b30-packaging-publication-evidence.json`.

La cadena remota existente sigue siendo v2/B23: política de perfiles hasta 23, instalador `install-v2.py`, firmador v2 y controlador `geops_deploy_v2.py`. Sus rutas y el `sudoers` de staging no fueron reemplazados. El paquete creado aquí se identifica de forma inequívoca como `B30_PRIVILEGED_LAB_ONLY`, exige claves efímeras sintéticas y **no puede activarse como controlador de staging**.

## 2. Puerta A — laboratorio privilegiado

Se implementó un empaquetador determinista de 151 archivos: controlador B30 del laboratorio, supervisor, Compose, manifiesto fuente, instalador, lanzador privilegiado, reglas sudo y cierre local de 14 paquetes Node necesarios para `pg`. La política incluye hashes de cada archivo, fuente `15f77a0d1904b77833972d8e2fd628a6cb97678f`, prefijo B23 de 23 migraciones y destino B30 de 30. El constructor rechaza cambios comprometidos o pendientes en API/Web/contratos/Dockerfiles respecto del commit revisado.

`install.py` exige root Linux, paquete y clave pública en rutas protegidas, SHA-256 revisado y firma Ed25519. Comprueba inventario tar, tipos de archivo, hashes y su propio código firmado. Copia archivos a `/opt/geops-b30-lab` con propiedad root, fija el hash de la política, instala `/usr/local/sbin/geops-b30-lab`, valida `visudo` y activa `/etc/sudoers.d/geops-b30-lab` **al final**. El journal permite repetir la misma instalación después de un corte. En modo `from-b23` contrasta hashes revisados del controlador/política v2, estado B23 steady, regla sudo v2 exacta y `verify` del controlador anterior; preserva los archivos y permisos v2. Este modo se probó con una fixture sintética que ejecutó un verificador B23 controlado.

`privileged.py` acepta únicamente `doctor`, `init`, `status`, `verify`, `upgrade` y `recover`, con directorio de laboratorio fijo. Antes de delegar valida propiedad root, modos, ausencia de symlinks, hash fijado de la política y todos los archivos del bundle. `init` queda reservado al operador root; `sudoers` permite al usuario `abi` solamente `doctor`, `status`, `verify`, `upgrade` y `recover`. Usa argumentos fijos y entorno saneado.

El paquete final `artifacts/b30-packaging/controller-b30-lab.tar.gz` mide **175 037 bytes**, SHA-256 `2e3f3cd8d3f7bf104bf44693564975365bd70593b7b1a72c7cc09fb69987bc4b`. Una segunda construcción produjo bytes idénticos. La firma Ed25519 de laboratorio tiene SHA-256 `03926d80087506c23cdb74b3e4da047f0593ca392ef2758a03c977b578efd54e`; la clave pública tiene SHA-256 `301b62f0424b2bb47842a96d38f649e10f667b598208189fa94473009c236c05`. La firma se volvió a verificar después de eliminar la clave privada efímera.

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

**Total nuevo: 14/14 PASS.** La suite Linux preexistente del instalador v2 pasó 14 pruebas y omitió 1 caso condicionado por su harness; la suite Python del controlador v2 pasó 26/26 y el supervisor B23→B30 pasó 20/20. El laboratorio B30 anterior había ejecutado B23→B30 y recuperación en contenedores, pero ese resultado **no** se reutiliza para declarar que el nuevo lanzador privilegiado hizo dicha transición.

**Pendiente para cerrar A:** ejecutar B23→B30 y sus fallos inducidos a través del controlador instalado por sudo contra un Docker/PostGIS Linux aislado; luego adaptar el controlador y el instalador **de staging** para B30 y comprobar su compatibilidad con el v2 instalado. La prueba actual de `from-b23` usa un verificador sintético; no observa un servidor real ni demuestra un cambio de controlador remoto. Por ello A permanece `PARTIAL`.

## 3. Puerta B — paquete e imágenes

Se construyeron imágenes locales desde la aplicación sin cambios del commit `15f77a0`, con `--pull=false`, fuente OCI `https://github.com/Kmena/Geops`, revisión exacta y variante `B30-integrated`. Web se compiló con MDM habilitado. La API contiene 30 SQL con hash de lista `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`; Web contiene `index.html` y assets. Se registraron Dockerfiles, `package-lock.json` y IDs de las imágenes base en la evidencia pública.

| Imagen | ID local | Archivo Docker save, SHA-256 | Capas verificadas |
| --- | --- | --- | ---: |
| API `geops-b30-packaging-api:15f77a0` | `sha256:de7b3f5ed3203f1e17b5b885f9ecee48fcc16347cee0e1547118c52dd1077d8e` | `api-b30.tar`: `50c8c05fc143b691a5193e582646a10f8fd5d586b7c8d1f6ad13f773d6a86e55` | 14/14 |
| Web `geops-b30-packaging-web:15f77a0` | `sha256:d9e6d51e49946f1fd71710d22a0e0bb3487b791ec6a8d33dda9da0a70c1df432` | `web-b30.tar`: `303f57fb5eef1a62d563007942f8e2cea939d37b04b0789d56b5d6654bf7fce8` | 11/11 |

`verify-image-archive.py` verificó tag, arquitectura `amd64`, SHA-256 del JSON de configuración contra el ID inspeccionado y SHA-256 de **cada capa** contra `rootfs.diff_ids`. Un ID incorrecto se rechazó. `verify-publication.mjs` vuelve a contrastar archivos tar, etiquetas OCI, esquema, SQL, assets y hashes. El borrador público tiene SHA-256 `ad8d2f2f073644b2ceba4cd874c34c657529afcac92b33ebc779b419b82b098e`; `publishable` lo rechaza, como corresponde, porque el controlador es `LAB_ONLY`, `RepoDigests` está vacío y no hay digests GHCR.

Se intentó usar un registro Docker descartable limitado a `127.0.0.1` para comprobar también un pull por digest de registro. La API HTTP local respondió 200 desde Windows, pero el daemon de Docker Desktop no pudo llegar a ese loopback y rechazó el push. La revisión automática rechazó cambiarlo a `--network host` por riesgo de exponer el registro en otras interfaces; **no se intentó eludir ese rechazo**. El contenedor de registro se retiró de forma acotada. La verificación de ID de configuración y capas sí pasó, pero no equivale a un digest de GHCR ni a un pull por digest desde un registro.

**Pendiente para cerrar B:** terminar y probar el paquete del controlador de staging, obtener digests reales de API/Web en un registro autorizado, cotejar ambos mediante pull por digest y firmar un manifiesto publicable. Publicar en GHCR requiere autorización específica; no se solicitó ni efectuó en esta etapa. Por ello B permanece `PARTIAL`.

## 4. Resultado y recomendación

`B30_PACKAGING_READINESS_PARTIAL`. La instalación y seguridad de un controlador **privilegiado de laboratorio** y la integridad offline de las imágenes están demostradas. No hay evidencia de actualización B23→B30 ejecutada por ese controlador privilegiado, instalación de un controlador remoto compatible con B30, ni digests GHCR. No se autoriza staging con estos resultados. La siguiente ejecución debe concentrarse en esos tres puntos, sin repetir el desarrollo de SPEC-03. Después de pasar A y B, corresponde inspeccionar el estado real del servidor y preparar una actualización supervisada con autorización separada.
