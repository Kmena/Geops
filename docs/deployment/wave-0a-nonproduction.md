# GEOPS Wave 0A: ejecución local, sin despliegue

Esta configuración es solo de desarrollo con datos sintéticos. No constituye procedimiento de producción ni autorización para exponer API/Web fuera del host. SPEC-01 conserva `READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING` y SPEC-00 sigue BLOCKED.

Compose publica API `127.0.0.1:3500` y Web `127.0.0.1:3501`; PostgreSQL 5432 solo está en `geops_wave0a_internal`. Usa contenedores, red y volumen con prefijo GEOPS. El job de migración termina antes de arrancar API; `/health/ready` comprueba DB, PostGIS y checksums. El archivo `infrastructure/compose/.env.local` contiene claves sintéticas, está ignorado y no debe copiarse a un despliegue.

La API rechaza `MDM_CLIENT_ID`, `MDM_CLIENT_SECRET`, access/refresh tokens y otros valores OAuth en su entorno. En Wave 0A siempre usa proveedor fake. Las credenciales reales del diagnóstico independiente no se montan en Compose.

Antes de iniciar o reiniciar, comprobar 3500/3501 y el proyecto Compose exacto. Para detener GEOPS, usar `docker compose ... down` sin `-v` para conservar el volumen. No ejecutar `down -v` ni modificar recursos de otros proyectos. Ver [desarrollo local](../development/wave-0a-local.md) y [backup/restore](../operations/backup-restore-synthetic.md).

La entrada a un despliegue futuro requiere revisión de seguridad W0A-E2, P01–P25, Q1–Q5, política de secretos/backup, validación ManageEngine Free, dos Android y aprobación de privacidad/operaciones. Ninguno está implícito en un Compose local sano.
