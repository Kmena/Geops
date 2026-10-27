# GEOPS B31 — Cierre de despliegue staging

Fecha: 2026-10-27 (UTC). Entorno: `geops-spec02-staging`.

## Estado Git y alcance

- Rama candidata aislada: `codex/b31-staging-candidate`.
- Reparación aislada del controlador: `codex/b31-controller-recovery-fix`, commits locales `f9719d5` y `f50dd3a`.
- Fuente de aplicación B31: `eba9b3ba3cf1927dcbf032070322fa32dbfe4db3`, basada en los cambios de `8ce7b9f7bacae7344f962d2b59cae511f016d378`.
- Controlador e instalador B31: commits locales `21541ef42b871d46c9697adcebfe5b9a293342e5` y `f965b82aa6454ac2e376265da40fe654038e100c`.
- Se preservó el worktree B30 con sus cambios sin commit. Sin push ni merge a ramas compartidas.
- Producción y APK Android: sin cambios.

## Publicación y confianza

| Artefacto | Identidad verificada |
| --- | --- |
| API B31 | `ghcr.io/kmena/geops-api@sha256:14e004b341ba6a4173a66ffe506fa8d2d7ca4f22dc5a033248f7af775f38c17c`; ID `sha256:e7d55b182906623813ba6f0978198af18e8afd75900f8ea59768ae7857c98ba1` |
| Web B31 | `ghcr.io/kmena/geops-web@sha256:6467721d823c142257205927d2ab6d31d916ac941c15645815db692a2f524ff8`; ID `sha256:86db6993530167e2640bb0f1aea9ba71d46a2f7d54e05d9925dcc4e965dea74b` |
| Bundle B31 v3 | SHA-256 `b510ecb71b6b79cbc46fb1e2f1dd5a2985cf0edc1c04899042dd754f79deba03`; 17 miembros |
| Firma Ed25519 v3 | SHA-256 `324523ddaf8f76febccb350c8d2c33b040a3d8e75e5e540f93a4f5c333e2813f` |
| Clave pública aprobada | SHA-256 `d01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27` |
| Política B31 | SHA-256 `75bbaf0a2cb9a57a4aecd05ea00ae46b96430a6d2f24f39e2baae6262be931a0` |
| Manifiesto candidato | SHA-256 `2cebd7f253f87efbc936d1ae08b429de0b5ddbd3a6d44d243d3520a99aae7061` |

Ambas imágenes se construyeron desde la fuente B31 fijada, se publicaron bajo etiquetas específicas, se consultaron por digest en GHCR y se descargaron por digest. Arquitectura `amd64`, revisión `eba9b3b...`, variantes `B31-integrated`; Web MDM habilitado. La API publicada contiene 31 SQL, ledger `17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0` y recuperación supervisada a esquema 31.

El bundle anterior v2, que falló antes de instalar por un error de conteo de argumentos CLI, quedó obsoleto. El v3 corrigió la CLI, se reconstruyó exactamente desde el commit local y se firmó de nuevo. No se reutilizó firma anterior ni clave LAB_ONLY.

## Migración y compatibilidad

La migración `0031_agent_responsibility_geocoding.sql` agrega tablas de identidad operacional, responsabilidad temporal y caché de geocodificación. No modifica migraciones 0001–0030 ni elimina tablas o datos. El prefijo B30 conserva el ledger `64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6`. Los siete archivos Compose/Nginx/entrypoint del nuevo paquete coincidieron byte a byte con el bundle B30 final, incluido Nginx LF. El empaquetador fija esos hashes y rechaza CRLF en Nginx.

## Respaldo y preflight

- B30 previo: controlador verificado, gate abierto, journal `complete`, 30 migraciones, API/Web saludables.
- Espacio de disco antes de operar: 10 638 280 KiB disponibles en `/` a las 19:58:24 UTC.
- Respaldo B30 creado mediante el servicio `geops-backup`: `geops-stage-20261027T195947Z.dump`, SHA-256 `f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705`.
- Ensayo de restauración en PostGIS descartable sin red: PASS, 30 migraciones, ledger B30 exacto. Evidencia `/root/geops-b31-restore-evidence-H6EDph/restore-evidence.json`, SHA-256 `45ffd1e232b8bdecc08c10698f726401f3d720fc763b1d6db516b716730f0bcc`.
- Controlador B31 v3 instalado en staging mediante instalador firmado; `doctor`, `visudo -c` y `status` PASS. Después de instalar, B30 `verify` siguió pasando; gate abierto, journal B31 nulo y 30 migraciones. Instalación sin reinicio de API/Web ni migración.

## Ensayos locales de este candidato

- `npm run build` API/Web/contratos: PASS.
- `npm run typecheck`: PASS.
- Lint dirigido de `maintenance-recovery.ts` y prueba B31: PASS.
- Recuperación B30→B31 sobre PostGIS descartable: PASS.
- Controlador Linux aislado: 11 controles PASS para aprobación, mantenimiento, migración y recuperación.
- Bundle firmado: parser Linux PASS, firma Ed25519 PASS y firma alterada rechazada.
- Instalador Linux descartable: CLI PASS, firma, `visudo` e idempotencia PASS.
- Imagen API publicada por digest: 31 SQL y recuperación 31 PASS.
- Validaciones B31 de aplicación anteriores al empaquetado: 130 controles `npm test`, 88 controles Chrome y 143 aserciones GPS (evidencia del trabajo de aplicación, no repetidas aquí).

## Promoción y recuperación

El release B31 firmado (SHA-256 `36c1d239b6b62f8af7ddf6ff21d13fc08ee8351be862dcf7c3166fa72799658c`) y los documentos de restauración y aprobación nuevos se instalaron con firmas y vínculos exactos verificados. `prepare` pasó: sourceStateSha256 `297753232179b61b04b80f13ddd7e429aea782f6469949071459c57d7d7536d3`, fuente B30 y destino B31 por digest.

`begin` consumió la aprobación, detuvo API/Web B30 y falló antes de cerrar el gate. El journal B31 quedó en `draining`; gate abierto y ledger de 30 migraciones. **No se ejecutó `migrate` ni la migración 0031.** La recuperación original falló: copió al journal el nonce de la puerta B30 abierta y exigió por error una atestación de recuperación de una fase de mantenimiento que nunca comenzó.

Se recuperaron exclusivamente los contenedores API/Web B30 existentes mediante `docker start`, bajo autorización específica, tras verificar sus IDs por digest, gate abierto, ledger30 y ausencia de contenedores de migración. El script SHA-256 `d827709784ae55ac2f8e1edda5e0e8481fc0d81bd37d488ea92cbf3a65164e78` devolvió `B30_SERVICES_EMERGENCY_RESTORED_B31_JOURNAL_PRESERVED` y el controlador B30 devolvió `B30_STAGING_VERIFIED`.

La causa más probable de `maintenance-start` es una sesión `psql` inactiva abierta desde 18:39:31 UTC (PID 565488); `maintenance-gate.ts` exige cero sesiones ajenas. La salida interna fue descartada por el controlador, por lo que esta causa es una inferencia sustentada por la sesión observada y la precondición del código, sin mensaje de error interno que la confirme. No se alteró ni cerró la sesión.

En `codex/b31-controller-recovery-fix`, commit `f9719d5cab7222f6cb5c9481ed52ead004c513db`, `recover` compara primero el nonce de la puerta abierta con el journal B30 fijado por SHA-256 y permite abortar el intento antes de mantenimiento sin atestación ficticia. Rechaza nonce o journal distintos y sigue exigiendo atestación para recuperación posterior a migración.

El bundle de reparación v4 se instaló con firma y preflight válidos, SHA-256 `6129476fc396978e1429b36011f98a964ae3702034cfd31391c1bc796b611853`. Conservó v3 y devolvió `B31_NONCE_REPAIR_DIAGNOSTICS_PASS_B30_UNCHANGED`. Una revisión posterior detectó que el journal B31 conserva el hash de política v3: la validación global del controlador v4 bloquearía `recover` antes de alcanzar la nueva rama del nonce. No se ejecutó `recover` en staging.

La corrección completa v5 acepta ese hash antiguo **solo** para `recover` con journal `draining` o `aborted`, gate abierto y ledger30; sigue bloqueando migraciones y otros estados con política distinta. El bundle v5 SHA-256 `a062af6ca121471b307ae9272eea2f715b3d4891f5db6f7a71ae8fdca167af7d`, política `89b5de6f15cc547244982fb1af250fa6dc9fff3a12ce1b0b2298de64401dc3eb`, firma `9368b6c9e0900679f4c1f84e5bcf5eefe2f301ad5cb9d05380c342a1e641fada`, es reproducible desde `f50dd3aea68b096b2a5db9e992c244122147034f`. Solo cambian `controller.py` y `policy.json` frente a v4. El instalador v4→v5 también está firmado (SHA-256 `9285c0cd771d4fbd3a8aeb5d912490d2ccb1ad37ebc01be092ec22012651d6a0`), conserva el bundle previo y no ejecuta `recover`, `begin` ni migraciones.

El operador instaló v5 con el procedimiento SHA-256 `2923e2b4110a598a30729282450ed4f548a24e1616c491a446fb574ad9bff6d2`. Ambas firmas pasaron; el instalador devolvió `B31_CONTROLLER_NONCE_REPAIR_INSTALLED`, conservó el bundle v4 y después `B31_NONCE_REPAIR_DIAGNOSTICS_PASS_B30_UNCHANGED`. Una consulta SSH independiente confirmó `B31_STAGING_PACKAGE_VERIFIED`, gate abierto, ledger30 y journal `draining`. No se ejecutó `recover` en staging porque reiniciaría API/Web B30; tampoco se inició una nueva promoción B31.

## Verificación posterior y continuidad

Tras restaurar B30: Web `/` 200; `/api/health/live` y `/api/health/ready` 200; MDM `/v1/admin/mdm/status`, GPS `/v1/admin/gps-capabilities`, clientes `/v1/admin/client-capabilities` y cumplimiento `/v1/admin/compliance` responden 401 sin sesión (sin 5xx). El gate permanece abierto, el ledger en 30 y el journal B31 en `draining`. No se afirma validación funcional autenticada ni GPS físico.

Laboratorio aislado de la reparación v5: máquina de estados B31, 25 controles PASS, incluidos fallo de `begin`, nonce heredado, rechazo de nonce distinto, aceptación limitada de política v3 y rechazo de una política desconocida; delta firmado solo controlador/política PASS; firma Ed25519 y alteración rechazada PASS; instalador Linux descartable PASS, conserva v4 e idempotencia PASS. API/Web y PostgreSQL de staging no se tocaron durante estas pruebas.

## Tiempos

Pendiente medir: inicio de mantenimiento, duración de migración, cambio API/Web, restablecimiento de health, reapertura del gate y tiempo efectivo sin servicio. El tiempo total del proceso se separará de la interrupción real.

## Estado final

`B31_STAGING_DEPLOYMENT_BLOCKED`: B30 está operativo, pero B31 no fue promovido. El controlador reparado quedó instalado y diagnosticado; no se autoriza reintentar B31 con la aprobación consumida ni con la sesión `psql` abierta.

`B31_STAGING_CONTROLLER_NONCE_REPAIR_TECHNICAL_PASS`: bundle v5 firmado instalado, `doctor` y diagnósticos de solo lectura PASS; pruebas de recuperación reales en staging no ejecutadas por el límite de no reiniciar API/Web.

Antes de un nuevo intento se requiere una ventana separada para cerrar la sesión `psql` ajena, archivar el intento B31 `draining` mediante un procedimiento firmado y autorizado, restaurar la regla sudoers B30 y emitir documentos nuevos con respaldo vigente. La ruta local reparada de `recover` está probada en Linux aislado, pero su ejecución en staging se pospuso para respetar la restricción de no tocar servicios durante esta reparación.

`SPEC03_OPERATIONAL_PASS = NO`.
