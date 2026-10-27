# GEOPS B31 — Cierre de despliegue staging

Fecha: 2026-10-27 (UTC). Entorno: `geops-spec02-staging`.

## Estado Git y alcance

- Rama candidata aislada: `codex/b31-staging-candidate`.
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

Release B31 firmado y transferido al área de preparación de staging: SHA-256 `36c1d239b6b62f8af7ddf6ff21d13fc08ee8351be862dcf7c3166fa72799658c`, firma `d35bdf8fc1412d9a498c47ca99ddca04eff49fc980fdec014cc49cb5d54b3497`. El script de instalación y `prepare` de solo lectura está transferido y verificado (SHA-256 `6bb91d358355dcd19064880e9020f5f1ee57ade8f661e7604c84cbef78ac403c`). Espera ejecución por operador; no se han ejecutado `begin` ni `migrate`. El script de recuperación B31 está preparado y transferido (SHA-256 `8929dbf2fb0e10dd287e474f28e16dcb620a95fa3070d8c7b9267d32e92f2148`).

## Verificación posterior y continuidad

Pendiente registrar: datos conservados, API/Web B31, MDM, GPS, SPEC-03, Nominatim, gate, ledger, respuesta de health y cualquier backlog. No se afirmará cero pérdida ni validación física GPS sin evidencia.

## Tiempos

Pendiente medir: inicio de mantenimiento, duración de migración, cambio API/Web, restablecimiento de health, reapertura del gate y tiempo efectivo sin servicio. El tiempo total del proceso se separará de la interrupción real.

## Estado final

`B31_STAGING_DEPLOYMENT_PARTIAL` hasta completar la promoción y verificación posteriores.

`SPEC03_OPERATIONAL_PASS = NO`.