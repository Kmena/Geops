# ADR-015 — Capacidades administrativas GPS

**Enmienda propuesta ADR-019 (decisión de negocio posterior):** se conserva `admin_permission` y la denegación por defecto. Para una empresa y usuarios con permisos distintos, la concesión/revocación ordinaria puede realizarla el principal con `gps.user.manage`, motivo, sesión, CSRF y auditoría; ya no depende de un segundo administrador. El bootstrap y la recuperación crítica mantienen doble custodia. La redacción histórica de doble persona abajo documenta la decisión anterior hasta aprobación SDD/Seguridad.

**Nota W1-E1 Corte 3:** [ADR-018 propuesto](ADR-018-operaciones-gps-sinteticas-propuesto.md) documenta dos capacidades adicionales implementadas solo para activación/concesión sintéticas. El conjunto inicial aprobado en este ADR se conserva; la extensión requiere revisión SDD y seguridad antes de uso operativo.

**Nota de implementación 2026-10-19:** la [ceremonia inicial sintética propuesta](../../spec-02-android-agent-wave-1/gps-capability-grants-proposal-2026-10-19.md) usa los dos custodios de recuperación existentes, contraseña del administrador y auditoría transaccional; no cambia la decisión aprobada ni autoriza todavía una concesión real.

**Extensión sintética propuesta:** un [segundo administrador](../../spec-02-android-agent-wave-1/admin-tenant-bootstrap-runbook-2026-10-19.md) puede crearse `LOCKED` bajo la misma doble custodia y activarse mediante recuperación supervisada, sin compartir contraseña ni crear rol de negocio. Su conjunto GPS sigue separado de concesiones tenant. Revisión independiente pendiente.

**Fecha:** 2026-10-19. **Estado:** aceptado como contrato de diseño para implementación sintética W1-B; ejecución de middleware y concesión real pendientes. **Ámbito:** SPEC-02. Complementa [SPEC-01](../../spec-01-foundation-wave-0a/api-contracts.md); no cambia su autenticación.

## Contexto

SPEC-01 autentica administradores con cookie segura, Origin y CSRF, pero `admin_user` no tiene roles ni permisos finos. SPEC-02 separa lectura sensible de configuración y modificación. Todos los usuarios autorizados siguen siendo administradores GEOPS; no se crean roles de negocio.

## Decisión

Autorizar cada operación en el backend mediante **capacidades explícitas por administrador**, nunca solo por presencia de sesión ni por controles ocultos en Web. `admin_permission(admin_id, permission, granted_by, granted_at, revoked_at, reason)` guarda concesiones auditadas. El conjunto cerrado inicial es:

| Capacidad | Operaciones |
| --- | --- |
| `gps.policy.read` | Consultar política, asignación y versión. |
| `gps.policy.write` | Crear/editar borrador; no publicar. |
| `gps.policy.assign` | Cambiar dispositivo/grupo asignado; no activar. |
| `gps.policy.activate` | Publicar, reanudar, pausar y revocar; exige también `gps.policy.write` y, si cambia asignación, `gps.policy.assign`. |
| `gps.session.read` | Consultar sesiones y estado/alertas sin coordenadas. |
| `gps.location.read` | Consultar ubicaciones; además exige motivo de acceso, límite/paginación y evento de auditoría por consulta. |
| `gps.audit.read` | Consultar historial de cambios GPS; no concede lectura de coordenadas. |

Concesión/revocación de capacidades es una operación administrativa separada de SPEC-02, con control de doble persona y revisión de seguridad antes de uso real. W1-B puede usar fixtures sintéticos que ya contengan concesiones; **ninguna migración concede automáticamente nuevas capacidades a administradores existentes**. Denegación por defecto y 403 estable. Los permisos se consultan en servidor por solicitud; revocarlos invalida autorización de la siguiente solicitud, sin confiar en caché del navegador. `gps.policy.activate` no permite activar identidad de dispositivo (endpoint de ADR-012). Se conserva la autenticación/CSRF/Origin/rate limit de SPEC-01 y se auditan éxitos y denegaciones sensibles.

## Consecuencias

W1-B necesita una migración y middleware de autorización probados; W1-D refleja capacidades únicamente para UX. El modelo inicial sigue siendo un conjunto de administradores, sin jerarquía de cargos. La asignación real de permisos y el procedimiento de doble control son gates operativos, no una suposición de W1-A. Una sesión de SPEC-01 válida sin capacidad GPS obtiene 403.

La [revisión cruzada W1-A](../../spec-02-android-agent-wave-1/contract-review-2026-10-19.md) fijó que la autorización vigente se comprueba también **antes** de reproducir un resultado idempotente; un administrador al que se revocó capacidad no obtiene el cuerpo de un éxito anterior.
