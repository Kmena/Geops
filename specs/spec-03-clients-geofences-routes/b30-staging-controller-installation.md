# B30 — Instalación supervisada del controlador en staging

Fecha: 2026-10-27 (UTC). Entorno verificado: geops-spec02-staging en ip-172-31-17-155.ec2.internal. Acceso SSH: usuario abi; la operación privilegiada fue ejecutada por el operador en su terminal root. No se registraron contraseñas ni secretos.

## Estado final

B30_STAGING_CONTROLLER_INSTALLED_PASS

APPLICATION_VERSION = B23
DATABASE_SCHEMA = B23
B30_APPLICATION_DEPLOYED = NO
SPEC03_OPERATIONAL_PASS = NO

La instalación del controlador B30 terminó. Esta autorización no incluyó la promoción B23→B30, y no se ejecutaron comandos prepare, begin, migrate o recover del controlador B30.

## A. Git y artefactos

- Worktree: C:/Users/kmena/.codex/worktrees/b30-packaging-readiness/Geops.
- Rama: codex/b30-packaging-readiness; HEAD inicial: c4b69074d792af8076b1955f7a685514565e204f; árbol limpio al iniciar.
- Bundle transferido: controller-b30-staging-ready.tar.gz, SHA-256 e3d46085cd0abe99133f7e818dd040385df3cb2e0dcacdcaca8fa1d5eda30151.
- Firma separada: controller-b30-staging-ready.sig, SHA-256 aa52a8e55f9d581d0be1389dad3157adc3ea9cf463fca3b7ca0ce9b648f02667.
- Clave pública aprobada: SHA-256 d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27.
- El verificador local scripts/deploy/b30-staging/verify-final-publication.mjs devolvió B30_FINAL_PUBLICATION_VERIFIED para el bundle, la firma, el manifiesto y las dos imágenes publicadas. En staging, sha256sum confirmó los tres archivos transferidos y OpenSSL devolvió Signature Verified Successfully con el dominio GEOPS-B30-STAGING-PACKAGE-SHA256.
- La política extraída del bundle es B30_STAGING_READY, activation READY, environment geops-spec02-staging. No es LAB_ONLY.
- Referencias B30 publicadas y fijadas, sin desplegar en esta operación: API ghcr.io/kmena/geops-api@sha256:42c1eeb392f8e8b23199a2536724910dc32721074c9c0784a3fcb9207a9ffe9d; Web ghcr.io/kmena/geops-web@sha256:2b59828bf0d50c29eaf87bb2f7fa3499e03da814d66ca56dd76971adb1a15483.

## B. Preflight de staging

- B23 instalado: /usr/local/sbin/geops-deploy-v2, SHA-256 070a2e7f058d75a601f4d3cc0f021f46c3d854066272a161822b7e0121a23ad2.
- Política B23: /etc/geops-deploy-v2/policy.json, SHA-256 b6c04a11c5bd6a8503f4670eb470223c82b3272213658d7f92acc35a691b6311. Su región MDM com ya había sido confirmada por el operador.
- Clave de confianza B23 instalada: /etc/geops-deploy-v2/public.pem, SHA-256 d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27; coincide con la identidad Ed25519 aprobada para B30. No se sustituyó la clave B23.
- Regla sudoers B23: SHA-256 e975a492f6e09f9019d35984b1081410db727803ff5de61a874909b275caf57f; coincide con la regla canónica LF que exige el instalador. El checkout Windows usa finales de línea distintos.
- El primer comando B23 verify falló por Invalid or stale backup. El último dump anterior era del 2026-10-26 14:53 UTC y superaba la ventana de la política.
- El operador ejecutó el servicio ya aprobado geops-backup desde el bundle B23, sin reiniciar servicios ni modificar PostgreSQL. Produjo un dump nuevo el 2026-10-27 16:33:11 UTC. Tras ello, B23 verify devolvió VERIFIED, perfil B23-mdm; inspect-evidence validó el respaldo (1 905 582 bytes, SHA-256 f41a61c174cc847196071a8b35bd92af78bc25962d16ea42597f54e659ffb51b).
- Baseline antes de instalar: fase steady, sin transición pendiente, gate open, API/Web/DB healthy, imageMatch true, ledger 23 migraciones con hash 90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d. Espacio libre observado: aproximadamente 10.7 GB en /.

## C. Respaldo del controlador

El operador creó /root/geops-b23-controller-20261027-z8Y7I0/controller-b23.tar.gz antes de instalar. Incluye ejecutable B23, árbol de configuración y confianza, política, instalador alojado en ese árbol, sudoers, estado/journals y auditoría. Se archivaron propietarios, permisos, ACL y xattrs; el directorio es root:root 0700 y el tar root:root 0600. Tamaño: 348 987 bytes. SHA-256: 105f0a29d440dd6e42f0ba689ec859f1d1f6bbeb185b7157ae16b6370a46d474. sha256sum -c devolvió OK y tar -tzf terminó sin error. No se borraron respaldos anteriores.

Restauración, solo si fuese necesaria y tras revisión operativa: detener cualquier promoción; comprobar el SHA-256 y el inventario del tar; restaurar únicamente las rutas B23 incluidas preservando propietarios, ACL y xattrs; validar visudo -c y geops-deploy-v2 verify. No se hizo restauración ni rollback de la aplicación.

## D. Instalación

Los artefactos se transfirieron a /home/abi/geops-b30-install-e3d46085-20261027 y se volvieron a verificar allí. El operador copió el bundle, la firma y la clave a /root/geops-b30-install-20261027-dB5sBx con permisos restrictivos, extrajo install.py del bundle firmado y ejecutó el modo from-b23 con los SHA-256 fijados de paquete, clave, wrapper y política B23.

El instalador devolvió B30_STAGING_PACKAGE_READY, activation READY, publicationReady true, source from-b23 y previous.activeProfile B23-mdm. La operación no llama al migrador ni cambia servicios de aplicación. El controlador B23 se preservó.

## E. Permisos, hashes y diagnóstico

| Ruta instalada | Propietario | Modo | SHA-256 |
|---|---|---:|---|
| /opt/geops-b30-staging | root:root | 0700 | directorio |
| /opt/geops-b30-staging/policy.json | root:root | 0444 | bc0fb2bb357101a8ac2a174aa00d7db03b66a5ddbc76ba02cff604ef3ced8041 |
| /opt/geops-b30-staging/public.pem | root:root | 0444 | d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27 |
| /usr/local/sbin/geops-b30-staging | root:root | 0500 | acc2d33361a27ba30f2639e0cb9c21f0b65bd0601d0cbef22300e439a21c9136 |
| /etc/sudoers.d/geops-b30-staging | root:root | 0440 | 8a2d91529d51f4291829456c34a8ff89b43e82b8de4c4ebb4f04e59065642a43 |
| /var/lib/geops-b30-staging/install.json | root:root | 0600 | journal |

Los hashes de política, clave, wrapper y sudoers coinciden con el bundle firmado o la regla canónica LF. visudo -c declaró válidos los archivos de sudoers. Como abi, sudo -n geops-b30-staging doctor devolvió B30_STAGING_PACKAGE_VERIFIED, activation READY, publicationReady true, files 21; un comando root arbitrario sin contraseña fue rechazado. El journal de instalación indica phase prepared-complete, packageSha256 esperado y source from-b23. El journal de promoción B30 es null.

B30 status devolvió ledger count 23, hash B23 y gate open. B23 verify posterior devolvió VERIFIED. B23 status posterior sigue en steady, B23-mdm, imageMatch true, webTrafficClosed false. La compatibilidad del instalador B23→B30 quedó demostrada por el modo from-b23 y la política READY; no se probó una promoción real.

## F. Servicios y base después de instalar

La segunda lectura B23 inspect-evidence mostró los mismos IDs y referencias API/Web que antes de instalar, ambas healthy, DB healthy, gate open, ledger 23 y sin transición. API: ghcr.io/kmena/geops-api@sha256:0cf114560f896e4be5889e32eba3d1dd730f711a20973b457490ace3904737fc. Web: ghcr.io/kmena/geops-web@sha256:aecbf48584bdee5ce2a52f8eebaad33fad155cf5b8c3cc9f47666b01c5ef3aa5.

Las horas de arranque siguen siendo API 2026-10-26 18:19:18 UTC, Web 2026-10-26 18:19:29 UTC y DB 2026-10-22 04:07:58 UTC; son anteriores a esta instalación. No se observó reinicio. No se aplicaron migraciones 0024–0030 y no se cambió Compose ni las imágenes operativas.

## G. Incidentes, límites y siguiente autorización

- El respaldo B23 inicial había vencido; se generó uno nuevo con el servicio aprobado y verify pasó antes de transferir el bundle.
- Una primera prueba OpenSSL con /dev/stdin no pudo procesar una entrada de tamaño cero; la repetición con archivo de mensaje temporal verificó la firma correctamente. El instalador la verificó otra vez.
- No se ensayó la actualización B23→B30 en staging, por prohibición expresa. La validación de SPEC-03 sobre la aplicación B30 y la validación física siguen pendientes.
- El próximo cambio requiere autorización independiente para iniciar la actualización supervisada B23→B30. Se debe repetir preflight, respaldo vigente, gate, estado de servicios, ledger y prueba de recuperación según el procedimiento aprobado antes de esa operación. Este informe no la autoriza.

STAGING_CONTROLLER_CHANGED = YES
APPLICATION_VERSION = B23
DATABASE_SCHEMA = B23
B30_APPLICATION_DEPLOYED = NO
SPEC03_OPERATIONAL_PASS = NO
PUSHED = NO
MERGED = NO
