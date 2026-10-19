# W1-E1 Corte 3 — scheduler, activación y Web sintéticos (2026-10-19)

**Estado: implementado y verificado en entorno sintético; W1-E1 sigue BLOCKED para cierre y operación.** Rama `codex/spec-02-wave-1`, HEAD inicial `d72cdb49d95915f8772ffcb6818698e4439c1a57`. Se preservaron los cambios anteriores. No se consultó GPS real ni se modificaron teléfonos, ManageEngine, la PoC desplegada, Inventori, Billing o bases compartidas. No hubo despliegue, commit, push ni merge.

## Cambios y contrato

| Componente | Resultado sintético | Límite |
| --- | --- | --- |
| Scheduler | Tick con advisory lock global; avanza `assignment_version` al cruzar límites de asignación, repone hasta siete días de ventanas UTC con zona IANA y excepciones, marca `MISSED` si vence una ventana sin inicio y `UNKNOWN_END` si vence una sesión iniciada sin fin confirmado. Auditoría y registro por corrida. | Nunca genera `STARTED` ni inventa `stopped_at`. Un `STARTED` válido tardío corrige `MISSED`. La cadencia operativa y ventanas tras inactividad prolongada requieren revisión. |
| Retención | Tick llama purga de posiciones y telemetría a 90 días, recibos/cuotas vencidos y ciphertext de dependencias a siete días. Conserva `audit_event`. | Los plazos finales, auditoría, backup y borrado de copias requieren decisión de privacidad/operaciones; no se modificó la PoC. |
| Activación | `POST /v1/admin/gps-installations` y `/:id/retire`: cookie administrativa, Origin/CSRF, capacidad `gps.installation.manage`, dispositivo activo, un binding activo, instalación ligada al binding/tenant y auditoría. Duplicados y transferencia se rechazan. | No crea identidad ni clave PoP. La migración 0014 deja instalaciones antiguas sin binding/tenant **fail closed**; reactivación requiere plan aprobado. |
| Concesión tenant | `POST /v1/admin/gps-tenant-grants/proposals` y `/{id}/approve`: capacidad nueva `gps.tenant.grant`, solicitud idempotente, aprobación de otro administrador dentro de 24 h y transacción conjunta para salud/posiciones; revocación por el mismo flujo. | Las nuevas capacidades solo están propuestas en [ADR-018](../architecture/adr/ADR-018-operaciones-gps-sinteticas-propuesto.md); alta y elegibilidad operativas pendientes. Ningún permiso se concede al migrar. |
| Web | `GpsWorkspace` usa por defecto cliente `GpsRemote` con cookie de sesión y capacidades del backend; políticas, dispositivos, sesiones, salud y posiciones con motivo, filtros por dispositivo/sesión/período, paginación y estados carga/error. Vista de fixtures explícita separada. | Acciones de escritura permanecen deshabilitadas. La prueba autenticada cliente/API no equivale a E2E de navegador. |

Las nuevas rutas de lectura `GET /v1/admin/gps-capabilities` y `GET /v1/admin/gps-devices` requieren sesión administrativa; dispositivos se filtran por tenant y `gps.session.read`. `GET /v1/admin/devices/{id}/locations` acepta `session_id` además de período UTC máximo de 24 h y motivo auditado. API de salud/configuración/ingesta conserva identidad y PoP de SPEC-01; las instalaciones transferidas se rechazan. OpenAPI de diseño y copia del paquete se actualizaron para todas las rutas y respuestas, incluido `410` de propuesta vencida.

## Migraciones y archivos principales

- [0013](../../apps/api/src/db/migrations/0013_gps_operations.sql): capacidades adicionales de conjunto cerrado, solicitudes de concesión y corridas del scheduler; ninguna concesión automática.
- [0014](../../apps/api/src/db/migrations/0014_gps_installation_binding.sql): ancla de instalación a binding/tenant mediante FK compuesta y cierre por defecto de instalaciones previas.
- Backend: `gps-scheduler.ts`, `gps-administration.ts`, `gps-event-service.ts`, `gps-health-service.ts`, `gps-device-config.ts`, `app.ts` y `main.ts`.
- Web: `GpsLiveWorkspace.tsx`, `GpsWorkspace.tsx`, `remote.ts`, estilos y pruebas del cliente.
- Contrato: `openapi.design.yaml`, copia en `packages/api-contracts`, verificador y [ADR-018 propuesto](../architecture/adr/ADR-018-operaciones-gps-sinteticas-propuesto.md).

## Evidencia

PostgreSQL/PostGIS **desechable**, base `geops_verify_20261019`, recibió migraciones 0001–0014. Pasaron integración de políticas (44 aserciones), configuración PoP (24), salud (37), eventos/sesiones/posiciones (69 con filtro de sesión), operaciones/scheduler/Web cliente (40), y carga acotada (25 dispositivos, 175 ventanas, ticks concurrentes e idempotencia, cuatro aserciones en 2259 ms en la repetición final). La prueba de operaciones cubre activación, doble control, revocación, expiración, CSRF/anónimo, transferencia, purga y lectura Web autenticada. `GpsRemote` ejerció la API HTTP autenticada; **no se ejecutó E2E con navegador**.

API, contratos y Web pasaron build/typecheck, contratos OpenAPI, lint (12 advertencias anteriores de W1-B), escaneo de secretos y `npm test` (API 18+12, Web 10, contratos 4, migración 2, restore 1). `pg_dump`/`pg_restore` entre bases del mismo contenedor preservó recuentos de 14 migraciones, dos instalaciones, tres solicitudes de concesión, 30 corridas, una sesión efectiva y 44 auditorías. Un `ALTER TABLE` dentro de transacción revertida no dejó columna. Esto acredita recuperación local del esquema/fixtures, no backup operativo ni restauración de claves.

## Riesgos y gates

W1-E1 **no está completa**: falta E2E de navegador con sesión real, revisión independiente de seguridad/privacidad, aprobación SDD de ADR-018/capacidades, política final de retención y auditoría, restore operativo de copias y claves, carga sostenida y revisión de migración/backfill de instalaciones existentes. El agente Kotlin conserva las pruebas sintéticas del Corte 2; este corte no añadió ni validó Android físico ni inicio tras reinicio. La cuarentena `202` requiere reintento del agente y no tiene reprocesador autónomo. El scheduler y las nuevas rutas no se han autorizado para datos reales. W1-E2 permanece bloqueada.
