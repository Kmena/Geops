# B30 — Clave de confianza y preparación GHCR

Fecha de comprobación local: 2026-10-27. Rama aislada: `codex/b30-packaging-readiness`.

`B30_STAGING_CONTROLLER_TECHNICAL_PASS` (evidencia previa en `b30-staging-controller-replica-validation.md`)

`B30_PUBLICATION_READINESS = PARTIAL`

`STAGING_ED25519_TRUST_KEY = PENDING_OPERATOR_VERIFICATION`

`STAGING_BUNDLE_SIGNATURE = PENDING`

`GHCR_PUBLISHED = NO`

`STAGING_CHANGED = NO`

`SPEC03_OPERATIONAL_PASS = NO`

## Clave Ed25519

La búsqueda local de archivos `*public*.pem`, `*trust*.pem`, `*.pub` y `*key*.pem` en `scripts`, `infrastructure`, `specs` y `artifacts` encontró solamente `artifacts/b30-packaging/lab-public.pem`. Su SHA-256 es `1c67f9d01fde7228edc10ccc2c421d34bce85f8ad7bb088de80e465506d33051`, identificado en la evidencia histórica como `LAB_ONLY`. El repositorio y los procedimientos v2 describen `/opt/geops-deploy/public.pem` y una clave pública controlada por el operador, pero no aportan una clave pública de staging aprobada ni su huella comprobada por un canal independiente. No se consultó ningún servidor ni secreto privado.

La revisión posterior de todo el worktree, incluidos archivos ignorados, confirmó que ese es el único archivo de clave pública local. El procedimiento histórico `scripts/deploy/remote/run-update-v2.ps1` referencia `output/mdm-oauth-release-20261025/controller-v2-operational-public.pem` y fija el SHA-256 `d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27`; ese archivo **no está presente** en el worktree. La referencia corresponde a una actualización puntual v2 y no demuestra que la identidad instalada actualmente coincida ni que el operador la haya aprobado para B30. El instalador v2 exige continuidad de su clave operacional; el paquete B30 requerirá la decisión y verificación independientes del operador sobre la clave pública a usar.

Se añadió `verify-trust-key.mjs`. Para un futuro paquete `READY` exige archivo regular, PEM de clave pública Ed25519, SHA-256 exacto aprobado por el operador y rechazo explícito de la clave `LAB_ONLY` conocida. `package.py --ready` ahora exige esa huella como argumento y ejecuta el verificador antes de construir. El valor aprobado debe llegar por un canal independiente del archivo que se verifica; el programa no puede certificar esa aprobación por sí mismo. No se creó ni sustituyó una clave definitiva.

El paquete local `artifacts/b30-packaging/controller-b30-staging-prepared-key-gated.tar.gz` mide **65 160 bytes** y tiene SHA-256 `bc69f81b2a9b11c19e821ce2abea902fea3d9f6ea01f7787d0ce46b6a16eb205`. Su inventario incluye 20 archivos con hashes coincidentes y el verificador nuevo. La política conserva `B30_STAGING_PREPARED`, `activation=DISABLED`, `publicationReady=false`, firma pendiente y digests nulos. Es un artefacto **sin firma de staging**; no es instalable como paquete `READY`.

`b30-ghcr-publication-intent.json` registra el candidato, los IDs locales y los repositorios de destino sin inventar digests. Las tres autorizaciones están en `false`.

## Imágenes y compatibilidad

El manifiesto de aplicación `b30-staging-candidate.json` se verificó contra el commit `2f89b87f1f636feb7e21d7e09af03959ee95f68d`, SHA-256 del manifiesto `3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b`. Fija 23 migraciones fuente, 30 destino y hash de lista B30 `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`. La política prohíbe downgrade de base y limita el controlador legado a B23.

| Imagen local | ID inspeccionado | Arquitectura | Etiquetas B30 | Digest GHCR |
| --- | --- | --- | --- | --- |
| `geops-b30-staging-api:2f89b87` | `sha256:37f9e5488f73230304adf8de90bfefff997391abb57299c92e5eca06b77b830f` | `amd64` | `B30-integrated`, recuperación máxima 30, revisión de aplicación fijada | Pendiente |
| `geops-b30-staging-web:2f89b87` | `sha256:59c8175259358dc3335eb153c6697730fdf1e2faf8f2577362dae1cff2424522` | `amd64` | `B30-integrated`, MDM habilitado, revisión de aplicación fijada | Pendiente |

`RepoDigests` fue `[]` para ambas imágenes. Los IDs locales identifican contenido en este daemon; **no** son digests inmutables de GHCR. Las referencias esperadas para el paquete final son `ghcr.io/kmena/geops-api@sha256:<digest>` y `ghcr.io/kmena/geops-web@sha256:<digest>`, todavía sin valores reales. El borrador anterior `b30-packaging-publication-evidence.json` corresponde al commit de aplicación `15f77a0...` y al controlador `LAB_ONLY`; se conserva como evidencia histórica y no se usa para publicar este candidato.

La publicación GHCR existente es manual y su `publication-gate.mjs` exige `workflow_dispatch`, `PUBLISH=true`, commit completo aprobado y `refs/heads/main`. No permite publicar directamente la rama aislada actual. Antes de autorizar una publicación B30 se deberá revisar una vía de publicación específica que preserve esas garantías, el commit de aplicación fijado y la variante MDM de Web. Ningún workflow se ejecutó y no se hizo push.

## Verificaciones dirigidas de esta etapa

| Comprobación | Resultado |
| --- | --- |
| `candidate.py verify` sobre el manifiesto B30 | PASS; 239 archivos, 30 migraciones y SHA-256 del manifiesto coincidente. |
| `docker image inspect` local | PASS; dos IDs, arquitectura `amd64` y etiquetas esperadas; `RepoDigests=[]`. |
| `verify-trust-key.test.mjs` | PASS 1/1; acepta una clave sintética Ed25519 con huella exacta, rechaza huella incorrecta y RSA. |
| Verificador contra `lab-public.pem` y su huella real | Rechazo esperado; la clave `LAB_ONLY` no puede habilitar staging. |
| `package.py --ready` con la clave `LAB_ONLY` | Rechazo esperado antes de crear archivo, incluso con referencias sintéticas de formato válido. |
| Inventario del paquete preparado | PASS; 20/20 hashes, política deshabilitada y sin referencias GHCR. |
| Firma de staging y pull por digest GHCR | NOT_RUN; faltan clave aprobada, autorización de publicación y digests reales. |

No se repitieron suites funcionales ni se accedió a staging.

## Tres autorizaciones independientes

1. **Publicación de imágenes:** autorizar de forma explícita la vía GHCR para los dos artefactos revisados. Tras publicar, registrar los dos digests reales, hacer `pull` por digest e inspeccionar arquitectura, etiquetas y contenido. La publicación no autoriza instalar nada.
2. **Instalación del controlador:** el operador verifica por canal independiente la huella de la clave pública Ed25519, fija los hashes del controlador B23 instalado y firma el paquete `READY` definitivo fuera de staging. La instalación requiere una autorización separada y una ventana supervisada.
3. **Actualización de staging:** requiere autorización propia, revisión del estado real del servidor, backups, manifest/digests firmados y procedimiento supervisado. Instalar el controlador no autoriza iniciar B23→B30.

Hasta completar esas puertas, el manifiesto B30 definitivo y el bundle firmado permanecen pendientes. `B30_PUBLICATION_READINESS = PARTIAL`.
