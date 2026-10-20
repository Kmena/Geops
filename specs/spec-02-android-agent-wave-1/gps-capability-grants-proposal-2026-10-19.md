# SPEC-02 — Diagnóstico y ceremonia inicial de capacidades GPS

**Estado:** implementación sintética local, propuesta de ejecución pendiente de aprobación de seguridad y negocio; no se han concedido permisos. **Entorno observado:** Staging `ce0866a`.

## Evidencia del incidente

- El administrador obtiene `200` de `/v1/admin/auth/me`.
- Una consulta autenticada directa de `/v1/admin/gps-capabilities` devolvió `{"capabilities":[]}` según la comprobación del operador. Esto confirma que la cuenta no tiene concesiones GPS vigentes; no es un `403` de ese endpoint.
- La API registra la ruta en `gps-administration.ts` y consulta `admin_permission`. Las migraciones 0009 y 0013 no conceden capacidades automáticamente. `gps.policy.read` y `gps.policy.write` se exigen por separado en el backend.
- La Web de `ce0866a` ejecutaba una segunda lectura de `/auth/me` antes de capacidades. La vista inicializaba la lista a `[]`, de modo que mostraba «0 capacidades» incluso si todavía no se había obtenido la respuesta; una excepción previa se mostraba como error genérico. El `403` de `/v1/admin/enrollment/devices` comunicado en Console pertenece a Inventario y no demuestra un fallo de políticas.

La corrección Web consulta capacidades desde la sesión ya validada por `AuthProvider`, representa por separado el estado sin confirmar y la lista vacía confirmada, y distingue red, respuesta inválida, `403` y errores del servidor. Las pruebas locales demuestran la secuencia y la recuperación; el comportamiento del navegador contra Staging debe comprobarse después de actualizar la Web. No se declara identificada la excepción exacta que interrumpía la segunda lectura de `/auth/me` en la versión desplegada porque no hay traza de esa excepción.

## Procedimiento inicial implementado, aún no aprobado para ejecutar

ADR-015 exige capacidades explícitas, auditoría y doble control para concesión/revocación reales. El bootstrap de SPEC-01 crea una identidad administrativa, sin capacidades GPS. La ceremonia local ahora puede concederlas bajo doble custodia; la Web por sí sola no habilita lectura o edición de políticas. El [runbook de bootstrap administrativo y tenant](admin-tenant-bootstrap-runbook-2026-10-19.md) completa la secuencia sintética, sujeta a aprobación de Seguridad.

El comando local `admin:gps-capabilities` es una ceremonia separada del servidor HTTP. No introduce endpoints, roles, migraciones ni concesiones automáticas. Reutiliza `recovery_custodian` de SPEC-01, por lo que no crea otra autoridad de personas. Para `grant-initial` exige:

1. Ejecución interactiva local, `GEOPS_DATA_MODE=synthetic`, flag explícito `GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES` y gate externo abierto con epoch coincidente. No se aceptan contraseñas por argumento, variable de entorno ni HTTP.
2. Identificador UUID de solicitud, correo exacto del administrador inicial y motivo de 8–240 caracteres. Debe existir exactamente una cuenta administrativa, activa y creada por `admin.bootstrap`; cualquier segunda cuenta cierra este camino inicial.
3. Contraseña vigente de ese administrador y contraseñas de dos custodios de recuperación activos con correos distintos entre sí y del administrador. La elegibilidad de esas personas y la entrega de credenciales requieren ceremonia fuera de banda previamente aprobada. Los custodios de prueba de `registerSyntheticCustodian` no acreditan esa aprobación.
4. Con lock transaccional y bajo gate abierto, la primera ejecución inserta exactamente las nueve capacidades GPS aceptadas/propuestas por ADR-015/018 en `admin_permission`, con `granted_by` igual al administrador autenticado y auditoría con ID de solicitud y los dos IDs de custodio. Toda fila histórica de `admin_permission`, incluso revocada, cierra permanentemente este bootstrap. Un UUID de solicitud rechazado tampoco puede reutilizarse: se requiere nueva revisión y nuevo UUID. Se rechazan reintentos y carreras; las denegaciones con UUID válido se auditan cuando el gate permite tráfico.
5. `revoke` exige los mismos dos custodios activos, nuevo UUID y motivo; retira todas las capacidades activas del administrador en una transacción y deja auditoría. No necesita su contraseña, para permitir revocación ante compromiso. Tras revocar no se puede repetir `grant-initial`.

El conjunto cerrado incluye `gps.policy.read`, `gps.policy.write`, `gps.policy.assign`, `gps.policy.activate`, `gps.session.read`, `gps.location.read`, `gps.audit.read`, `gps.installation.manage` y `gps.tenant.grant`. Representa el acceso completo GPS solicitado por negocio, **pero la capacidad no reemplaza una concesión de tenant**. `gps-devices`, salud, sesiones y ubicaciones siguen filtrados por `gps_data_tenant_access` / `gps_health_tenant_access`. El alta secundaria bloqueada, la activación mediante recuperación supervisada y la propuesta/aprobación tenant entre dos administradores ya están implementadas localmente; la autorización organizativa sigue pendiente.

## Decisiones pendientes para Staging

- Seguridad debe aprobar la identidad, independencia, custodia, rotación y revocación de los dos custodios. La consola única verifica cuentas distintas, pero no prueba por sí sola dos operadores humanos independientes.
- Negocio/seguridad deben ratificar las dos capacidades de ADR-018 para el conjunto inicial y el alcance tenant exacto. No usar una concesión global por defecto.
- Debe aprobarse el alta del segundo administrador, su identidad individual y la ceremonia de activación supervisada. El primer tenant usa el flujo de dos administradores de ADR-018; no hay concesión tenant automática.
- Operaciones debe verificar backup, gate/epoch, migraciones existentes y ventana antes de cualquier ejecución. No usar SQL manual, `gate init` ni permisos por sesión.

## Contrato y evidencia local

`grant-initial|revoke <admin-email> <custodian-1-email> <custodian-2-email> <request-uuid> <reason...>`; las tres contraseñas se piden en TTY (solo dos en revocación). El comando no emite secretos. Los modos `add-secondary`, `activate-secondary` y `revoke-secondary` añaden el correo de admin2 antes del motivo y también mantienen secretos fuera de argumentos; la activación exige la contraseña de admin1 además de las dos de custodios. `GET /v1/admin/gps-capabilities` sigue devolviendo las concesiones vigentes; políticas y registro exigen sus capacidades específicas. Las suites locales `gps:capability:integration` (19) y `admin:tenant:integration` (41) pasaron en PostGIS desechable con 14 migraciones. La corrección Web local consulta capacidades después de la sesión y diferencia lista vacía de error. No existe evidencia de ejecución contra Staging ni revisión de seguridad independiente.

## Secuencia de actualización y operación propuesta

1. Publicar la imagen revisada en una ventana autorizada, conservando el volumen PostGIS, el gate y su epoch. Verificar backup, checksum de las 14 migraciones y `GET /health/ready`; no ejecutar `migrate` ni `gate init`. La corrección Web se publica junto a la API.
2. Obtener aprobación documentada de seguridad y negocio para dos custodios **humanos** independientes, sus cuentas, custodia de contraseñas y las nueve capacidades. Si no existen custodios ya aprobados, el comando `geops-api recovery provision <correo>` con `GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES` existe solo para datos sintéticos; su ejecución requiere esa aprobación previa. No usar cuentas de fixture ni compartir contraseñas.
3. En consola local interactiva del contenedor de mantenimiento, ejecutar una sola vez `geops-api gps-capabilities grant-initial <admin> <custodio1> <custodio2> <UUID> <motivo>` con `GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES`. En Compose, usar `docker compose ... run --rm -it -e GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES geops-api gps-capabilities ...`; la configuración del servicio ya monta los secretos y el gate en solo lectura. Nadie introduce contraseñas en la línea de comandos ni las registra en tickets.
4. Iniciar sesión de nuevo, comprobar `GET /v1/admin/gps-capabilities` con exactamente el conjunto autorizado y `GET /v1/admin/gps-policies` con 200. Verificar que escritura sin capacidad no se habilita por la Web y que la API conserva sus controles de CSRF/Origin. Registrar UUID, motivo, dos custodios y evento de auditoría; no publicar políticas por esta prueba.
5. Completar la [secuencia de segundo administrador y primer tenant sintético](admin-tenant-bootstrap-runbook-2026-10-19.md). Si se revoca la decisión, usar los comandos locales de revocación y la propuesta/aprobación tenant entre dos administradores; comprobar sesiones invalidadas, lista vacía y auditoría. No intentar repetir el bootstrap ni usar SQL manual.

No se ejecutó ninguna de estas operaciones en Staging durante esta tarea.

**Sin migraciones nuevas.** No se ha aplicado ninguna concesión ni cambio de datos a Staging.
