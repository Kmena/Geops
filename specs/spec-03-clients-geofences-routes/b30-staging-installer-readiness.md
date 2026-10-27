# B30 — preparación del instalador privilegiado para staging

**Actualización posterior:** la adaptación de controlador y la nueva evidencia están en `b30-staging-controller-readiness.md`. Este informe conserva el corte inicial y su paquete preparado anterior como evidencia histórica.

**Corte:** 2026-10-27. **Rama:** `codex/b30-packaging-readiness`. **HEAD inicial:** `30d9ba2485205b9bb4d1a7fe412fdeb0ee5a96fd`.

`B30_STAGING_INSTALLER_TECHNICAL_PASS = NO` · `B30_STAGING_INSTALLER_TECHNICAL_PARTIAL = YES`

`STAGING_ED25519_TRUST_KEY = PENDING_OPERATOR_VERIFICATION` · `STAGING_BUNDLE_SIGNATURE = PENDING`

`GHCR_PUBLISHED = NO` · `STAGING_CHANGED = NO`

## Alcance implementado

Se añadió `scripts/deploy/b30-staging/` sin alterar el instalador v2, su política, su regla sudo ni el controlador B30 de laboratorio. `package.py` construye de forma determinista un archivo tar que contiene el controlador B30 probado en el laboratorio, supervisor, fuentes del controlador v2, Compose de staging, manifiesto candidato, dependencias y scripts de instalación. Excluye el instalador y sudoers privilegiados `LAB_ONLY`. La política `B30_STAGING_PREPARED` fija 217 archivos con SHA-256, la procedencia de la aplicación y la compatibilidad de migraciones B23 (23, hash `90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d`) a B30 (30, hash `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`). Declara `activation=DISABLED`, `publicationReady=false`, clave de confianza pendiente, firma definitiva pendiente y digests GHCR nulos.

`install.py` requiere root Linux, directorios administrativos protegidos, hash del paquete revisado, pin SHA-256 de la clave pública y firma Ed25519 sobre `GEOPS-B30-STAGING-PACKAGE-SHA256\n<digest>\n`. Rechaza symlinks, miembros tar ajenos o duplicados, cambios de checksums, inventario inesperado y una regla sudo distinta de la regla de solo lectura revisada. Comprueba que el propio instalador coincide con el archivo firmado. Para `from-b23` requiere hashes revisados del wrapper y la política v2, estado B23 steady, regla sudo v2 exacta y `verify` del controlador anterior; deja los archivos B23 intactos. El modo `clean` rechaza un controlador B23 existente.

La instalación escribe `/opt/geops-b30-staging` y su pin de política, `/usr/local/sbin/geops-b30-staging`, journal y una regla nueva en `/etc/sudoers.d/geops-b30-staging`. Valida `visudo` antes de instalar la regla. El journal y la comparación de bytes permiten repetir la misma operación tras una interrupción. La regla concede al usuario `abi` únicamente `geops-b30-staging doctor`; `upgrade`, `recover`, `init` y comandos arbitrarios permanecen denegados. `doctor` verifica la propiedad root, los modos, el pin de política y todos los archivos. Esta preparación no cambia servicios ni base de datos.

## Artefacto y pruebas locales

Paquete local **sin firma de staging**: `artifacts/b30-packaging/controller-b30-staging-prepared.tar.gz` (directorio ignorado por Git), **578 372 bytes**, SHA-256 `fca3abfc161bca4a212a12ba6940176ee4ddfd371c1ed046f1a12c77270ebce1`. Dos construcciones independientes produjeron el mismo hash. La validación sintáctica de los cuatro archivos Python pasó y `git diff --check` no reportó errores.

Prueba ejecutada con `docker run --rm --network none` y la imagen local `geops-v2-installer-lab:20261024`, sin socket Docker del host montado. `test_linux.py` generó una clave Ed25519 **efímera exclusivamente dentro del contenedor**, firmó el paquete para la prueba y eliminó la clave privada antes de la instalación. Esa firma no es la firma de staging ni se conserva como artefacto publicable.

**Resultado: 16/16 PASS**: firma válida; firma falsa, hash de paquete y pin de clave incorrectos rechazados; instalación limpia root; `visudo` real; `sudo doctor`; `sudo upgrade` y shell rechazados; reinstalación idempotente; alteración de política detectada; reanudación tras interrupción después de copiar el bundle y después de instalar sudoers; bundle alterado rechazado; fuente B23 preservada; modo limpio sobre B23 rechazado; deriva de permisos B23 rechazada. El escenario `from-b23` usó una fixture v2 sintética con `verify` ejecutable. No es evidencia de instalación sobre el controlador v2 real de staging.

El laboratorio privilegiado anterior ya demostró el controlador B30 y la actualización B23→B30 con recuperación, según `b30-packaging-privileged-readiness.md`. Esa ejecución corresponde al proyecto Docker y la política **LAB_ONLY**. No se reutiliza como prueba de activación en staging.

## Límite técnico para el PASS solicitado

El controlador B30 ejercitado en laboratorio fija `synthetic-b30-local`, imágenes `geops-b30-lab-*`, Compose de laboratorio y su propio proyecto Docker. El controlador v2 y su sudoers operativos de staging reconocen perfiles hasta B23. El paquete preparado conserva ambos códigos para revisión, pero la guardia instalada **no puede realizar una actualización operativa B23→B30 en staging**. Activarla como si fuera el controlador de staging pondría en riesgo el aislamiento de servicios y la política de permisos. Por esa razón no se declara `B30_STAGING_INSTALLER_TECHNICAL_PASS`.

Para cerrar el PASS falta una adaptación acotada del controlador a los recursos reales de staging y una prueba Linux aislada de instalación/actualización **con ese controlador** y recuperación, usando política de compatibilidad firmada. La firma definitiva depende de que el operador confirme la clave pública Ed25519 autorizada. Los digests inmutables de GHCR siguen pendientes de publicación autorizada; los IDs e imágenes locales del laboratorio no los sustituyen. Ninguno de estos pendientes autoriza cambiar staging.

## Procedimiento supervisado futuro — no ejecutado

1. Aprobar la versión de controlador que opere exclusivamente sobre el proyecto, rutas, gate, volúmenes y servicios de staging; comprobar `upgrade`, recuperación, journal y restricción sudo en Linux aislado.
2. Confirmar por canal operativo la clave pública Ed25519 de staging y su hash SHA-256. Revisar el paquete exacto, el instalador incluido, el manifiesto de migraciones y los digests de imagen. Firmar **los bytes definitivos** del paquete con la clave de firma autorizada; nunca con la clave sintética del laboratorio.
3. Antes de intervenir un servidor, obtener autorización independiente para inspección e instalación. En la ventana aprobada, registrar estado B23, hashes del wrapper y política v2, `verify`, salud de API/Web, ledger y respaldo comprobable.
4. Copiar paquete, firma, clave pública y el instalador revisado a rutas root protegidas. Cotejar hashes fuera y dentro del servidor. Ejecutar manualmente el instalador `from-b23` con el digest del paquete, el pin de clave y los hashes B23 revisados; registrar journal y `visudo -c`. No automatizar este paso desde CI ni al publicar imágenes.
5. Revisar `doctor` y sudoers antes de habilitar cualquier comando operativo. La promoción B30 y la actualización de servicios requieren una etapa y autorización separadas, con comprobaciones de recuperación y prohibición de downgrade incompatible.

**No se ha ejecutado ninguno de los pasos remotos.** El paquete actual solo permite la preparación y la verificación de integridad; no debe instalarse en staging como controlador operativo.
