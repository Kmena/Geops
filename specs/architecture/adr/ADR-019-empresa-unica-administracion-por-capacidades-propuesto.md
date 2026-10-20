# ADR-019 — Empresa única y administración de capacidades por usuario

**Fecha:** 2026-10-19. **Estado:** decisión de negocio recibida; contrato de seguridad propuesto para revisión independiente. **Ámbito:** GEOPS SPEC-01/02 sintético. No autoriza MDM, teléfonos ni datos reales.

## Contexto

El bootstrap SPEC-01 crea una sola cuenta sin capacidades. ADR-015 decidió capacidades explícitas por usuario, pero dejó la concesión operativa bajo doble persona. ADR-018 propuso dos administradores para cada concesión tenant. La decisión de negocio actual establece **una empresa** con **múltiples usuarios y conjuntos de capacidades diferentes**. Crear y configurar políticas, dispositivos, puntos o rutas ordinarias no requiere un segundo administrador.

## Decisión propuesta

1. `admin_user` y `admin_permission` siguen siendo el único modelo de cuentas y capacidades; no se añaden roles de negocio. Una cuenta puede tener varias concesiones activas. La ausencia de concesión deniega la operación en backend.
2. La ceremonia local inicial, con contraseña del administrador principal, dos custodios independientes y gate abierto, concede el conjunto GPS inicial y la capacidad nueva `gps.user.manage`. Esta última no se delega ni revoca desde la API ordinaria. La ceremonia separada `establish-tenant` registra una sola empresa sintética (`synthetic`) y concede explícitamente al principal acceso a datos y salud. Ambas ceremonias quedan auditadas y no son endpoints HTTP.
3. El principal puede crear otras cuentas `LOCKED` desde una sesión con Origin/CSRF. Cada cuenta recibe una invitación de 256 bits, válida 24 horas, almacenada solo como hash, con cinco intentos fallidos permitidos y consumo único. El token aparece una vez para entrega por canal autorizado. La persona invitada define su propia contraseña; no hereda capacidades ni acceso tenant.
4. `gps.user.manage` permite conceder/revocar **subconjuntos** de las nueve capacidades GPS delegables y acceso al único tenant mediante operaciones separadas, con motivo, UUID idempotente, transacción y auditoría. La lectura de ubicación conserva `gps.location.read`, motivo de consulta y tenant concedido. La cuenta gestora no puede modificarse a sí misma desde esta API.
5. La revocación de usuario invalida sesiones, capacidades, acceso tenant, invitaciones y recuperación pendiente. Las cuentas revocadas no se reactivan por recuperación. La recuperación crítica y la ceremonia inicial conservan dos custodios; transferencias y excepciones mantienen sus gates existentes.
6. Las rutas de propuesta/aprobación tenant de ADR-018 se conservan por compatibilidad, pero el nuevo flujo de empresa única no depende de ellas. Una vez establecido el tenant, esas rutas rechazan otro tenant. El comando heredado que copiaba todos los permisos a admin2 deja de exponerse para altas ordinarias.

## Consecuencias y límites

La migración 0015 amplía el CHECK de `admin_permission` y añade registro singleton, invitaciones y cambios idempotentes. No otorga permisos automáticamente. El contrato `GET /v1/admin/gps-capabilities` agrega `tenant_ids`, preservando `capabilities`. La Web muestra permisos efectivos y permite al principal administrar cuentas; el backend sigue siendo autoridad.

La invitación se entrega manualmente porque no hay transporte de correo aprobado. La cuenta gestora podría usar un token antes de su destinatario; la custodia del canal y la identidad de la persona invitada requieren procedimiento organizativo. Dos cuentas de custodio no demuestran por sí solas dos personas. El modo de mantenimiento de gate preserva epoch y exige marcador de base posterior al cierre; su ensayo local no sustituye revisión independiente ni una ventana de Staging aprobada. El tenant literal `synthetic` es solo para pruebas; la identidad de la empresa operativa requerirá una decisión y migración posteriores.

## Revisión de release, 2026-10-20

La auditoría local añadió invalidación de invitaciones y concesiones a la cuarentena de backups, y conservó el nonce en el gate abierto tras la migración. [Ensayo y evidencia](../../spec-02-android-agent-wave-1/w1-e2-single-tenant-release-readiness-2026-10-20.md). **ADR permanece propuesto:** Seguridad debe aprobar la identidad de custodios, entrega de invitaciones y un procedimiento de rollback supervisado. Un fallo de 0015 deja 0014 con gate cerrado; una 0015 exitosa impide volver al binario anterior sin una transición explícita del gate. No se autoriza actualización de Staging ni uso físico con este ADR pendiente.

### Propuesta de recuperación de 0015

Se implementó localmente una [recuperación hacia adelante supervisada](../../spec-02-android-agent-wave-1/migration-0015-safe-recovery-2026-10-20.md): principal y dos custodios autentican el reintento; gate, epoch, nonce, OID de la base, checksums y objetos 0015 deben coincidir. La versión nueva sirve como puente para gates heredados; no se habilita el binario anterior sobre 0015 ni un downgrade automático. Restaurar un backup requiere otra base, cuarentena y nuevas credenciales. **Pendiente de decisión de Seguridad:** aceptar indisponibilidad hasta reparar hacia adelante, validar custodia real y prohibición verificable de restore in situ; la implementación local no aprueba aún el ADR ni Staging.

El [gate final de release](../../spec-02-android-agent-wave-1/migration-0015-final-release-gate-2026-10-20.md) añade un ensayo Ubuntu sin conexión a Staging: dump privado aportado por un operador, red Docker interna, base temporal, comprobación de 0014→0015, cuarentena y evidencia agregada. La firma de Seguridad debe revisar expresamente la custodia del dump, el caso de restore *in situ* y el digest de imagen antes de publicar; este ensayo tampoco cambia el estado **propuesto** del ADR.
