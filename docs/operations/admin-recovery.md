# Administración local sintética — Wave 0A

Esta guía aplica solo a GEOPS en desarrollo con datos ficticios. La API no ofrece registro público ni recuperación web.

## Bootstrap inicial

1. Comprobar que el operador está en el host GEOPS autorizado, que Compose apunta a la base sintética y que el archivo local ignorado contiene las claves generadas por `node scripts/create-local-compose-env.mjs`.
2. Abrir una consola interactiva local dentro de `geops-wave0a-api` y ejecutar `node /work/apps/api/dist/admin-auth/bootstrap.js <correo-ficticio>`. El comando pide la contraseña dos veces sin eco. No pasarla como argumento, variable de entorno, archivo versionable ni comando registrado.
3. Verificar que la operación terminó correctamente. El backend permite crear un solo admin inicial; repetir el bootstrap falla. No hay contraseña predeterminada.

## Recuperación con dos custodios

El procedimiento requiere dos custodios humanos distintos con acceso operativo autorizado. Antes de emitir un código, ambos verifican presencialmente la solicitud, la identidad del solicitante y el entorno sintético; registran la aprobación fuera de Git. Los nombres proporcionados al comando son referencias de auditoría, no prueban por sí solos la presencia física.

1. En consola interactiva local, ejecutar `node /work/apps/api/dist/admin-auth/recovery.js issue <correo-ficticio> <custodio-a> <custodio-b>`. El código aleatorio se muestra una vez al operador supervisado y vence a los 10 minutos. No copiarlo a tickets, chat, logs ni archivos.
2. El operador ejecuta `node /work/apps/api/dist/admin-auth/recovery.js consume` en consola local. Introduce código y contraseña nueva sin eco.
3. Confirmar que la sesión anterior dejó de funcionar y que el código usado/expirado no se acepta de nuevo. La transacción revoca todas las sesiones previas.

Si faltan los dos custodios o el control presencial, no emitir código. El procedimiento no es aprobación operativa para cuentas reales o producción; requiere revisión de seguridad y política de operación antes de ese uso.

## Credenciales y aislamiento

Las claves `GEOPS_ADMIN_SESSION_KEY`, `GEOPS_ADMIN_CSRF_KEY`, `GEOPS_INVITATION_HMAC_KEY` y `GEOPS_MDM_GRANT_KEY` son sintéticas y se generan en `infrastructure/compose/.env.local`, ignorado por Git. No cargar `apps/api/.env.local` del diagnóstico OAuth. El proxy de desarrollo usa HTTP solo en loopback; producción exigirá TLS y cookie Secure. Los datos de las pruebas integradas se crean en una base GEOPS desechable separada.