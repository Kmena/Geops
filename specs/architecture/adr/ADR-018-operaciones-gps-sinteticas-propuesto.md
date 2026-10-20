# ADR-018 — Operaciones administrativas GPS y scheduler sintético

**Enmienda propuesta ADR-019 (decisión de negocio posterior):** el tenant único `synthetic` se establece por ceremonia local auditada; el principal concede acceso tenant por usuario bajo `gps.user.manage` sin segundo administrador para operaciones ordinarias. Las rutas antiguas de propuesta/aprobación permanecen por compatibilidad y se limitan al tenant establecido. El resto del contrato de identidad, PoP, scheduler y retención no cambia. Revisión independiente pendiente.

**Enmienda propuesta 2026-10-19:** el [bootstrap del primer tenant sintético](../../spec-02-android-agent-wave-1/admin-tenant-bootstrap-runbook-2026-10-19.md) conserva propuesta y aprobación por administradores distintos. Únicamente un binding `provider=fake`, `customer_id=synthetic`, `state=PENDING` puede demostrar existencia del tenant antes de la inscripción; los demás tenants siguen requiriendo binding `ACTIVE`. No hay concesión automática por bootstrap de cuenta o creación de DRAFT. Esta enmienda permanece pendiente de aprobación SDD y Seguridad.

**Fecha:** 2026-10-19. **Estado:** propuesto para revisión de seguridad y aprobación SDD; implementado solo en entorno sintético W1-E1 Corte 3. No autoriza activación real ni cambia las siete capacidades iniciales aprobadas en ADR-015 para operación.

## Contexto

W1-E1 Corte 2 dependía de instalaciones y concesiones tenant introducidas por fixtures SQL. Las ventanas se materializaban al publicar, pero no se reponían; el vencimiento temporal no avanzaba la versión del dispositivo. La Web conservaba fixtures y un adaptador de lectura sin conexión a las pantallas.

## Propuesta de contrato

1. Añadir **dos capacidades nuevas, sin concesión automática**: `gps.installation.manage` para activar/retirar instalaciones y `gps.tenant.grant` para proponer/aprobar concesiones de lectura tenant. `gps.policy.activate` conserva exclusivamente su alcance de políticas. La tabla `admin_permission` acepta estos valores desde 0013; solo fixtures explícitos los otorgan durante pruebas.
2. Activar una instalación únicamente para un dispositivo activo con **un solo** binding MDM activo. El UUID de instalación lo genera el servidor y se liga al par binding/tenant vigente (0014). Una transferencia invalida la instalación anterior hasta retiro y nueva activación. La sesión y PoP SPEC-01 siguen obligatorios para configuración e ingesta. No se crea clave de dispositivo ni identidad en este flujo.
3. Conceder o revocar lectura tenant mediante solicitud UUID idempotente y aprobación por **otro administrador autenticado** que posea `gps.tenant.grant`. La aprobación vence a las 24 horas y cambia en una transacción `gps_data_tenant_access` y `gps_health_tenant_access`. Autenticación, Origin y CSRF son obligatorios en cada mutación. La revocación de la capacidad invalida la siguiente solicitud y se comprueba bajo lock.
4. Un tick periódico adquiere un advisory lock global, avanza `assignment_version` en límites temporales, repone un horizonte máximo de siete días con zona IANA, marca como `MISSED` ventanas vencidas sin STARTED y deja sesiones abiertas vencidas en `UNKNOWN_END` sin `stopped_at` inventado. Un STARTED válido que llega tarde corrige la inferencia de MISSED. El scheduler no genera STARTED ni posiciones.
5. La misma ejecución invoca purga de posiciones y salud a 90 días, borra ciphertext de dependencias vencidas a siete días y preserva `audit_event`. No hay plazo de eliminación de auditoría aprobado para esta wave; su política definitiva y backups se mantienen como gate de privacidad/operaciones.
6. Web lee capacidades vigentes del servidor y usa cookie administrativa; consultas de salud/ubicación exigen motivo, y ubicación limita período a 24 horas con filtros por dispositivo y sesión. Las mutaciones Web permanecen deshabilitadas hasta revisión de seguridad y gates operativos.

## Consecuencias y límites

Las migraciones 0013–0014, las rutas y las pruebas solo sirven al backend sintético. La migración 0014 deja instalaciones anteriores sin par binding/tenant en estado **fail closed** para configuración e ingesta; deben reactivarse administrativamente en un plan de migración aprobado. Un administrador con la nueva capacidad de concesión todavía tiene alcance tenant amplio: la política de elegibilidad por organización, alta/revocación de capacidades, doble control operativo y revisión independiente siguen pendientes. Los tests de cliente Web contra API autenticada no sustituyen un E2E de navegador. Tampoco se ha validado Android físico ni retención de backups.
