# B30 — Finalización de confianza y publicación

Fecha local: 2026-10-27. Publicación GHCR y firma completadas; staging no se modificó.

## A. Fuente

- Rama aislada: `codex/b30-packaging-readiness`; HEAD al construir: `7d59d558f172cf1c918275e28600a019a619b140`.
- Commit de aplicación fijado por el controlador: `2f89b87f1f636feb7e21d7e09af03959ee95f68d`. `git diff` entre este commit y HEAD sobre API, Web, contratos, Dockerfiles, lockfile y `.dockerignore` no mostró cambios.
- `git archive HEAD` dio un contexto limpio de 761 archivos, SHA-256 `499341e53e7fe2df25030fdd5f5492fee32a77f4760e5847f274aadbb95910bb`; se conservó como `artifacts/b30-packaging/b30-source-7d59d55.tar`. No incluyó archivos `.pem`, `.key`, `.p12` ni `.pfx`.
- Dockerfiles API/Web: SHA-256 `c3f9f22ce30c12a155b5de1f2534e5890a21b9d726fec2bab7558e0d2dff39d1` / `f3498a680f575c60d4883cac4b3d716f7c83ad1dd7b24684f49994bde817504d`. `package-lock.json`: `7cfc1b07976515308adf1ef208d087b136b1f3fc6c97076f67e7bbc80f4e30fa`.

## B. Confianza

Se localizó la clave pública operacional v2 en el almacén local protegido de GEOPS; su SHA-256 es `d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27`, idéntico al pin del procedimiento histórico `run-update-v2.ps1`. El usuario aprobó expresamente reutilizar **esta identidad** para el bundle B30 y como futura clave de confianza del controlador B30. La aprobación no autoriza instalarlo ni actualizar staging.

El directorio de firma tiene ACL protegida con acceso de `SYSTEM` y del usuario propietario. La clave pública pasó el verificador Ed25519; una firma de reto aleatorio creada en memoria con la clave privada local verificó contra esa pública. No se imprimió ni copió la clave privada, no se generó otra identidad y no se configuró confianza en staging.

## C. GHCR

El primer token OAuth de Docker Windows carecía de `write:packages` y GHCR rechazó el push sin crear manifiesto. El operador reemplazó esa sesión por un PAT clásico; una consulta de scopes sin mostrar el token confirmó `repo, write:packages`. Después, `docker push` publicó API y Web bajo la etiqueta específica `b30-spec03-7d59d558f172cf1c918275e28600a019a619b140`. No se usó `latest` ni se sobrescribió una etiqueta existente.

| Imagen | ID local | Arquitectura | Digest GHCR verificado |
| --- | --- | --- | --- |
| API B30 | `sha256:322eb6e8bae3f974c246b226db5161153c12ea11ccef26ff9625d1b0934b7515` | `amd64` | `ghcr.io/kmena/geops-api@sha256:42c1eeb392f8e8b23199a2536724910dc32721074c9c0784a3fcb9207a9ffe9d` |
| Web B30 MDM | `sha256:c0ce64b98edc1f8789b34ee0137dbcd5a29cb6f66436c7f856f94616d53dfe7d` | `amd64` | `ghcr.io/kmena/geops-web@sha256:2b59828bf0d50c29eaf87bb2f7fa3499e03da814d66ca56dd76971adb1a15483` |

`docker buildx imagetools inspect` confirmó ambos digests, tanto por etiqueta como por referencia inmutable. Los pulls por digest pasaron tras un timeout de red inicial y devolvieron los mismos IDs locales, etiquetas `B30-integrated`, revisión de aplicación y arquitectura `amd64`. El contenedor API descargado contiene 30 migraciones y recuperación hasta esquema 30; Web contiene los assets compilados.

## D. Bundle

El paquete `artifacts/b30-packaging/controller-b30-staging-ready.tar.gz` es `B30_STAGING_READY`, `activation=READY`, mide **65 507 bytes** y tiene SHA-256 `e3d46085cd0abe99133f7e818dd040385df3cb2e0dcacdcaca8fa1d5eda30151`. Contiene 22 miembros: controlador, guardia, instalador, sudoers, Compose, manifiesto candidato, clave pública aprobada y política con digests reales. El parser del instalador aceptó el inventario y todos sus hashes. La segunda construcción produjo exactamente el mismo SHA-256.

`b30-staging-candidate.json` conserva su estado histórico de borrador y su hash, porque el empaquetador lo usa como ancla de la fuente revisada. El manifiesto definitivo `b30-final-publication-manifest.json` registra la publicación y enlaza ese candidato, los digests, el paquete y la firma; la política `READY` incluida en el tar contiene los digests reales.

El operador proporcionó por consulta de solo lectura los hashes del B23 instalado: wrapper `070a2e7f058d75a601f4d3cc0f021f46c3d854066272a161822b7e0121a23ad2` y política `b6c04a11c5bd6a8503f4670eb470223c82b3272213658d7f92acc35a691b6311`, fijados en el paquete. Confirmó también que `mdm.region` es `com`. El instalador volverá a comparar esos valores en el host antes de cualquier instalación.

El firmador offline generó `controller-b30-staging-ready.sig`, 64 bytes, SHA-256 `aa52a8e55f9d581d0be1389dad3157adc3ea9cf463fca3b7ca0ce9b648f02667`. La verificación independiente con la clave pública aprobada pasó sobre el mensaje `GEOPS-B30-STAGING-PACKAGE-SHA256\n<hash-del-paquete>\n`; un mensaje alterado fue rechazado. La clave pública exportada `controller-b30-staging-approved-public.pem` tiene SHA-256 `d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27`. La clave privada permanece en el almacén local protegido y fuera de Git.

OpenSSL 3.3.3, ejecutado en un contenedor Linux descartable sin red y con los artefactos montados en solo lectura, devolvió `Signature Verified Successfully` usando `pkeyutl -verify -pubin -rawin`, el mismo mecanismo del instalador.

## E. Controlador

El bundle incluye `controller.py`, `guard.py`, `install.py`, `sudoers-ready` y la política de compatibilidad B23→B30. El controlador exige las referencias GHCR por digest, etiquetas OCI de la revisión de aplicación, variante `B30-integrated`, Web con MDM y recuperación máxima de esquema 30. No se modificó su lógica en esta ejecución. El render de Compose con los digests reales confirmó API, Web y `geops-migrate` en sus referencias correctas, con MDM habilitado; no se iniciaron servicios.

## F. Migraciones

La imagen API descargada de GHCR por digest contiene 30 archivos SQL con hash de lista `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6` y recuperación supervisada a esquema 30. El candidato B30 incluido en el bundle identifica individualmente las migraciones 0001–0030 y fija el prefijo B23 de 23 migraciones `90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d`. No se aplicó ninguna migración.

## G. Validaciones

- Build API/Web desde archivo Git limpio: PASS; capas cacheadas, IDs arriba.
- Inspección de arquitectura, etiquetas B30 y variables de entorno: PASS; no se observaron secretos en `Config.Env`.
- Push API/Web GHCR: PASS, dos digests reales. `imagetools inspect` por etiqueta y digest: PASS 2/2.
- Pull por digest: PASS 2/2; IDs `sha256:322e…b7515` y `sha256:c0ce…fe7d` iguales a los locales. El primer intento paralelo tuvo timeout de red; reintento secuencial pasó.
- Inventario SQL dentro de la API descargada: 30/30, hash B30 y recuperación 30 PASS. Assets Web descargados: PASS.
- Clave pública Ed25519 y correspondencia de la privada local: PASS.
- Firma de un paquete `PREPARED`: rechazo esperado, sin archivo de firma.
- `sign-package.test.mjs`: PASS 1/1; firma verificable de paquete `READY` sintético con clave efímera y rechazo de contenido alterado.
- Bundle `READY`: parser del instalador PASS con 22 miembros, dos referencias GHCR por digest, clave aprobada, hashes B23 y política 23→30.
- Reproducción del bundle: PASS; dos construcciones con SHA-256 `e3d46085cd0abe99133f7e818dd040385df3cb2e0dcacdcaca8fa1d5eda30151`.
- Firma Ed25519 real: PASS; verificación independiente y rechazo de mensaje alterado.
- Verificación OpenSSL Linux del paquete y firma reales: PASS.
- Compose con digests API/Web/migrador y MDM: PASS; solo render de configuración.
- Manifiesto final `b30-final-publication-manifest.json`: SHA-256 `8dd00bea95c993ad094798d548fc2f6384110c412704765ffd5afbb63a47de56`; registra commits, procedencia, hashes, digests, firma y compatibilidad. `verify-final-publication.mjs` contrastó sus valores con la fuente archivada, el tar firmado, los 22 miembros y las imágenes descargadas: PASS.

## H. Seguridad

No se imprimieron credenciales ni claves privadas. La construcción usó únicamente archivos seguidos por Git y el contexto no contenía formatos de clave privada. Las imágenes se etiquetaron con revisión de aplicación, variante y esquema, y se comprobó que no incorporan secretos en variables de entorno. El bundle no incluye clave privada y su firma queda fuera del tar. Los intentos iniciales de publicación con token sin alcance no dejaron manifiesto; la publicación efectiva usó el PAT clásico en Docker Credential Store. El bundle fija digests reales y evita depender de la mutabilidad de etiquetas. No se instaló software ni se cambió staging.

## I. Pendientes reales

No hay bloqueos pendientes para la publicación B30. La instalación del controlador y la actualización supervisada en staging requieren autorizaciones independientes, comprobación del estado vivo, respaldo y ventana operativa. La validación física de SPEC-03 permanece pendiente.

## J. Estado final

`B30_PUBLICATION_READY = YES`

`GHCR_PUBLISHED = YES`

`B30_BUNDLE_SIGNED = YES`

`STAGING_CHANGED = NO`

`STAGING_DEPLOYMENT_PENDING`

`SPEC03_OPERATIONAL_PASS = NO`
