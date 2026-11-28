# W6-R1 — Plan de release staging, sin autorización de despliegue

La candidata de fuente se prepara en `codex/mdm-diagnostics-wave0`, sin modificar `main`. El SHA exacto, hashes SQL e IDs de imágenes construidas localmente se consignan en `output/spec05-wave6-r1/candidate-manifest.json` al cerrar el árbol. **Un ID local `sha256:` de Docker no es un digest de registro GHCR** y no sirve como referencia de promoción en el controlador. No se publica ninguna imagen ni se actualiza staging en W6-R1.

## Flujo reproducible

1. Fijar commit completo con Waves 1–5, workflow `.github/workflows/spec05-staging-candidate.yml` y los documentos de W6-R1. Comprobar que el árbol de **fuente** coincide con ese commit y ejecutar `npm ci --ignore-scripts`, `npm run security:scan`, `npm run staging:check`, `npm run contracts:check`, `npm run typecheck`, `npm run lint`, `npm test`, `VITE_MDM_ENABLED=true npm run build`, integración PostGIS y E2E Chrome. No incluir secretos ni APK de producción.
2. El workflow manual `Validate SPEC-05 staging candidate` exige el `candidate_sha` idéntico al SHA del checkout y construye API/Web con labels `org.opencontainers.image.revision`, `GEOPS_API_VARIANT=SPEC05-W6-R1`, `GEOPS_WEB_BASE=/`, `MDM_ENABLED=true`, zona GPS `America/Costa_Rica`. No tiene `push`, login de registro, SSH ni despliegue. La rama deberá publicarse y el run CI ejecutarse **solo tras autorización de publicación de fuente**; la prueba local no se presenta como run CI.
3. Registrar imágenes locales por ID de contenido y, tras aprobación separada para publicar, producir referencias `ghcr.io/kmena/geops-{api,web}@sha256:<digest>` y un manifiesto de release firmado/revisado compatible con el controlador. No sustituir esos digests con tags mutables o IDs locales. La publicación de imágenes y la promoción staging son gates diferentes.
4. Antes de promoción, confirmar labels de imagen activa, ledger fila por fila, Compose/proxy efectivo, MDM deshabilitado por defecto, permisos RBAC y `mdm_write_disabled`. Registrar health, conteos GPS/diagnóstico, gate, imágenes estables, recursos y ventana. El controlador `geops-staging-simple` se observó con un despliegue 0040→0040; **no se ha probado** para 0040→0042. La ejecución de migración requiere runbook/controlador supervisado específico, no invocar `deploy` de forma optimista.
5. Respaldar staging y demostrar restauración aislada conforme a [evidencia y procedimiento](WAVE6-R1-BACKUP-RESTORE-EVIDENCE.md). Comparar 40 checksums aplicados con los primeros 40 de la candidata; aplicar 0041/0042 solo en réplica de restore y ensayar API candidata, GPS v2, diagnósticos y rollback/forward recovery. Medir tiempos reales. Pedir aprobación final con digest, respaldo y plan exactos.

## Secuencia futura propuesta, sujeta a autorización

Durante ventana aprobada: cerrar el gate y drenar ingestión; tomar respaldo fresco y validar checksum; detener API/Web según controlador; aplicar 0041/0042 de forma controlada; iniciar API y Web por digests fijados; verificar `/health/ready` **desde la red de API** (no el fallback público), login admin, PoP técnico, diagnóstico, recepción/ACK GPS v2, workspace/timeline, aislamiento tenant y `mdm_write_disabled`; abrir gate solo tras aprobar los checks. No usar datos reales de ubicación para un smoke sintético sin autorización.

Ante fallo antes de migrar, conservar DB y volver a imágenes previas por digest bajo controlador autorizado. Tras migrar, no asumir que las imágenes 0040 pueden arrancar sobre 0042: mantener gate cerrado, recuperar hacia adelante con candidato corregido o restaurar el dump verificado con el procedimiento de epoch/gate y ventana de datos explicitada. No ejecutar downgrade SQL automático, `down`, `prune`, borrado de volumen ni cambio de secreto. Guardar imágenes previas y sus digests hasta cerrar la ventana de recuperación.

## Solicitud de promoción que se preparará

| Campo | Valor actual |
| --- | --- |
| API/Web/DB estables | Digests y salud en [inventario](WAVE6-R1-STAGING-INVENTORY.md); esquema 0040. |
| Candidato | SHA local y IDs locales en manifiesto; digests GHCR y CI remoto **pendientes**. |
| Migración | 0041 y 0042; prefijo 0001–0040 coincide; ledger de 42 esperado en [compatibilidad](WAVE6-R1-STAGING-COMPATIBILITY.md). |
| Respaldo/restauración | Dump real, checksum y restore aislado **pendientes**. |
| Riesgos | Esquema nuevo no reversible automáticamente, MDM real sin validar, APK instalada desconocida, 404 actuales, disco host 9.7 GB libre, controlador simple sin ensayo de migración. |
| Indisponibilidad | Por medir en ensayo 0040→0042 con backup/restore real; no inventar minutos. |
| Pruebas posteriores | Health API/DB, login, GPS v2/ACK/idempotencia, diagnóstico PoP, workspace, RBAC/tenant, Android anterior, `mdm_write_disabled`, monitorización de errores. |

**Estado:** candidata local en preparación; promoción y autorización de promoción `BLOCKED/NOT_RUN`. Solicitar aprobación de staging solo cuando haya digests de registro, CI SHA exacto, restore real y controlador de migración probado. La instalación del Moto G06 es una autorización posterior separada.
