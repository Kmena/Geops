# Wave 2 — actualización controlada de API y Web en Staging

Este procedimiento es una preparación. No autoriza despliegue. Requiere un SHA aprobado después de revisión y pruebas, y un operador autorizado en el host de Staging. No cambia Android, PoC, Inventori, Billing, PostgreSQL, Caddy ni datos de los cinco dispositivos existentes.

1. Registrar el SHA aprobado, los tags e IDs de los contenedores `geops-api`, `geops-web` y `geops-db`, las imágenes anteriores y el checkout anterior. Conservar el archivo privado de variables fuera del repositorio. Confirmar gate y epoch y que PostgreSQL tiene 15 migraciones.
2. Descargar exactamente el SHA aprobado en el checkout de despliegue. Usar el archivo privado existente. Conservar `GEOPS_STAGE_IMAGE_TAG` para los componentes de mantenimiento; definir `GEOPS_STAGE_API_IMAGE_TAG` y `GEOPS_STAGE_WEB_IMAGE_TAG` al nuevo SHA solo en los overrides. Revisar `docker compose config` con `compose.staging.yaml`, `compose.staging.api-only.override.yaml` y `compose.staging.web-only.override.yaml`. Confirmar que solo las imágenes de `geops-api` y `geops-web` cambiarán.
3. Construir `geops-api` y `geops-web` usando esos tres archivos Compose y el mismo archivo privado de variables. No ejecutar migrador ni comandos de gate. Esta Wave no añade migraciones.
4. Recrear primero solo `geops-api` y luego solo `geops-web` mediante `docker compose ... up -d --no-deps geops-api` y `docker compose ... up -d --no-deps geops-web`. Mantener PostgreSQL, gate y epoch intactos.
5. Comprobar health, HTTPS y sesión administrativa. Con un administrador autorizado y los cinco dispositivos de prueba, verificar que aparecen con sus nombres en Inventario y GPS. **No accionar** suspensión, revocación, retirada o parada sobre esos cinco dispositivos durante la comprobación. Probar mutaciones solo sobre un dispositivo sintético creado para la prueba, con consentimiento operativo y registro de motivo. Verificar que un administrador sin `gps.installation.manage` o sin acceso tenant recibe 403, y que los retirados permanecen en Inventario.
6. Registrar evidencia: SHA, tags, IDs de contenedores, respuesta de health, estado de migraciones, gate/epoch y resultados de navegación. No declarar Staging PASS sin comprobación autenticada de acciones y estados.

Los comandos Compose concretos, incluida la combinación de los tres archivos y el archivo privado de variables, están en [gps-device-names-api-web-staging.md](gps-device-names-api-web-staging.md). En esta Wave se sustituyen únicamente los tags aprobados de API y Web; no se reutilizan los SHA de aquella entrega como destino nuevo.

## Rollback

Restaurar los tags anteriores de API y Web en los overrides y recrear únicamente `geops-api` y `geops-web` con `--no-deps`, API primero. Conservar las imágenes nuevas para diagnóstico. Verificar health, sesión, nombres y GPS; confirmar los mismos IDs de PostgreSQL, gate y epoch. Las transiciones que un administrador haya ejecutado sobre datos de Staging no se revierten al restaurar imágenes: tratar su recuperación como operación de negocio auditada, nunca mediante SQL ad hoc.
