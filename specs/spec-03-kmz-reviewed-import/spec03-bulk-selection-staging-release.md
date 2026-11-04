# SPEC-03 — Puntos sin conflicto y selección masiva en staging

**Estado:** `SPEC03_STAGING_DEPLOY_PASS`

**Fecha:** 2026-11-04 19:56:12 UTC

**Entorno:** `geops-spec02-staging`

**Operador:** `scripts/deploy/simple/geops.ps1 deploy staging -Manifest <manifiesto>` → `/usr/local/sbin/geops-staging-simple`

## Release instalado

| Elemento | Valor |
| --- | --- |
| Commit de código y promoción | `c99f6981796fc0d1000f075bba68bb05e697a352` |
| Rama publicada | `codex/spec03-kmz-bulk-selection` |
| API | `ghcr.io/kmena/geops-api@sha256:d78bcce6d6f1b33e5d777a48d232af317035f5b57617f92f94f55e2f7b8bbc6d` |
| Web | `ghcr.io/kmena/geops-web@sha256:a855c0447210d486ace7b4c7fda7dccf281206f9a00f3f6e3c629bf12a32592b` |
| Manifiesto | `spec03-bulk-selection-staging-release.json` |
| SHA-256 del manifiesto entregado | `4185eb00dec58df607903ba948d1b8240552e28eb86325e6f97a9a46c8de10a3` |
| Ledger | 40 migraciones, `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf` |

Las etiquetas de GHCR se verificaron por digest remoto. Ambas imágenes son `linux/amd64` y llevan la revisión exacta del commit. La imagen API contiene las mismas 40 migraciones y el mismo hash del ledger de staging. No se modificó ninguna migración.

## Validación previa

- Lint dirigido, typecheck, build Web, 61 pruebas Web, escaneo de secretos y detector Impeccable: PASS.
- E2E SPEC-03 sobre PostGIS descartable: PASS. La prueba nueva verificó que `READY_POINT` incluye el punto nuevo válido y lo excluye después de guardar su decisión. El laboratorio fue retirado.
- Preflight del operador simple: API/Web/DB saludables, gate abierto, esquema 0040, 10 GB disponibles, sin errores recientes ni despliegue concurrente.

## Resultado y smoke

El operador simple validó los digests y el catálogo SQL, actualizó API/Web y emitió `deployment.success` con 40 migraciones. El estado posterior confirmó los digests anteriores, los tres servicios `healthy`, gate `open` y ausencia de errores recientes. No hubo migraciones ni respaldo de esquema (`backup: null`).

Pruebas HTTP sin sesión: `/` y `/health` devolvieron 200; KMZ, GPS, rutas y MDM devolvieron 401. El bundle Web servido contiene “Puntos nuevos sin conflicto”, “Seleccionar esta página”, “Seleccionar todos los resultados” y el límite de 100 registros por lote. Una carga sintética sin credenciales de 2 MiB devolvió 401 en vez de 413. No se importaron ni confirmaron clientes reales.

## Uso y límites

En **Importaciones KMZ → Revisar registros**, seleccionar **Puntos nuevos sin conflicto**. La vista contiene puntos nuevos con nombre y coordenadas válidos, sin coincidencias, conflictos ni advertencias, aún pendientes de decisión. Para coincidencias con clientes existentes, usar **Coincidencias con cliente** y revisar el vínculo individualmente. Elegir **Seleccionar todos los resultados** si son 100 o menos; si son más, **Seleccionar esta página** y procesar por lotes. La acción queda en precarga y requiere vista previa y confirmación administrativa final.

No se probó visualmente con una sesión administrativa real después del despliegue. Producción no fue modificada.
