# MDM: inscripción administrada y captura GPS continua

Estado: implementación local en `codex/mdm-auto-continuous-gps`; sin despliegue ni prueba física.

## Comportamiento

Un administrador vincula previamente un dispositivo Android que el inventario de ManageEngine confirma como `managed` a un dispositivo GEOPS. Ese vínculo crea una autorización GPS continua exclusiva para el equipo, con intervalos predeterminados de captura 60 s, sincronización 300 s, alerta de latido 900 s y salud 300 s. La política cubre los siete días de 00:00 a 00:00 UTC. El cliente Android mantiene registrado el proveedor de ubicación al cambiar la sesión civil a medianoche. La desvinculación o una sincronización que marque explícitamente el equipo como retirado/no administrado revoca la autorización y restaura la evaluación de políticas ordinarias. Una página incompleta del inventario no se interpreta como baja.

La política tiene una fecha técnica máxima de 9999 y se revoca por estado MDM, evitando un corte arbitrario al día 30. La autorización local sin conexión conserva el límite existente de 12 horas desde la última configuración autenticada. Android puede suspender o impedir un servicio de ubicación por permisos, batería, reinicio, cierre forzado u otras restricciones del sistema; esta implementación no constituye una garantía física de muestras ininterrumpidas.

## Una APK, configuración por dispositivo

La APK declara restricciones administradas para `geops_device_id`, `mdm_device_id`, `invitation_id`, `invitation_secret` y `expires_at`. El administrador crea una invitación con `delivery_mode=managed_configuration` **después** de confirmar el vínculo MDM. La API devuelve `managed_configuration` para cargarla en la configuración de esa instalación MDM. La invitación dura hasta 24 horas, se consume una sola vez y está ligada al equipo GEOPS y al identificador del inventario MDM. La APK, en su primer inicio visible con la configuración presente, genera una clave propia en Android Keystore, reclama la invitación, firma el desafío y recibe `key_id` e `installation_id`. No hay una confirmación administrativa posterior. El inicio de GPS solicita los permisos Android que falten; MDM debe preconcederlos si se pretende evitar intervención en el teléfono.

La invitación administrada no sustituye la inscripción QR supervisada. El backend sigue exigiendo vínculo MDM vigente, coincidencia del equipo y prueba de posesión de la clave; rechaza reuso y revocación entre la reclamación y la prueba. La configuración y el secreto son específicos de cada equipo aunque la APK sea la misma. Un secreto extraído y copiado antes de su primer uso podría ganar la carrera de inscripción: la unicidad del token no demuestra por sí sola identidad física. Se necesita validación con ManageEngine y dispositivos reales antes de habilitar este flujo operacionalmente. Una reinstalación que pierda la clave requiere una invitación nueva.

## Compatibilidad y despliegue futuro

- Migración `0032_mdm_continuous_capture.sql`: bandera de política, CHECK de jornada completa solo para MDM, historial de autorizaciones y expiración de invitaciones administradas. No altera archivos de migraciones anteriores.
- La configuración GPS v2 entrega `mdm_continuous=true` solo para políticas administradas. La configuración v1 entrega estado inactivo para ese modo.
- La APK candidata aumenta a versión 9 (`0.1.8-enterprise-candidate`). La APK actualmente instalada no entiende la bandera nueva; actualizar la APK antes de vincular el equipo a captura continua.
- El controlador privilegiado, manifiesto y proceso de publicación B31 no incluyen todavía la migración 0032 ni esta APK. Preparar un release supervisado separado; no aplicar SQL directamente en staging.
- No se han modificado la ingesta GPS v2, los ACK, la autenticación PoP, servidores, staging, GHCR ni el MDM remoto.

## Validación local

PostGIS descartable: 32 migraciones aplicadas; integración de inventario y revocación MDM; integración de inscripción administrada, reuso, desvinculación y entrega GPS v1/v2. Regresiones: inscripción QR supervisada, políticas GPS de jornada (48 aserciones), configuración GPS (24) e ingestión GPS (69). Las suites unitarias API pasan 67 pruebas y las ventanas MDM 2 pruebas adicionales. El agente Android pasó 55 pruebas sintéticas, incluido el cambio de medianoche sin desregistrar el GPS. La APK debug versión 8 compilada en la etapa anterior tiene SHA-256 `20a69eef8d7432edb4d59e08b2c8cb020367707485d949c02aeb2b55544a75cd`; no es el candidato nuevo. Ver [preparación Android Enterprise](android-enterprise-mdm-readiness.md) para el estado de build y firma de versión 9. No hay validación con un POCO real, permisos MDM, batería, reinicio ni captura 24/7 observada.

Estado: `LOCAL_TECHNICAL_PASS`; `PHYSICAL_VALIDATION=PENDING`; `DEPLOYED=NO`; `PUSHED=NO`.
