# Wave 2 — máquina de estados y límites de administración

Documento de decisión previo a la implementación. Fuente canónica: `geops_device.status`; no se crea una tabla de estados nueva. La identidad, el binding MDM, la clave PoP y la instalación GPS son cosas distintas.

| Acción | Antes | Después | Efecto y repetición |
| --- | --- | --- | --- |
| Detener seguimiento GPS | Identidad ACTIVE, instalación activa | Identidad ACTIVE, instalación retirada | Reutiliza `POST /v1/admin/gps-installations/:id/retire`. El siguiente config o lote falla; conserva clave e identidad. Se retira una vez; repetir con la misma instalación retirada no crea otra transición. El servicio Android desconectado puede continuar capturando localmente hasta enterarse y sus lotes posteriores serán rechazados. |
| Suspender | ACTIVE | SUSPENDED | Revoca sesiones PoP emitidas, retira instalación activa, cancela ventanas programadas futuras y deja sesiones efectivas abiertas como `UNKNOWN_END` sin inventar hora de fin. Conserva la clave activa para reautenticación posterior. Repetir SUSPENDED no altera estado. |
| Reactivar | SUSPENDED | ACTIVE | Requiere un binding `ACTIVE` único del tenant autorizado, clave PoP `ACTIVE` única, ninguna invitación/claim abierto y ninguna instalación activa. La asignación GPS queda intacta, pero la instalación permanece retirada; una activación GPS posterior exige su operación autorizada. Una clave perdida o binding revocado exige nueva inscripción, no bypass administrativo. Repetir ACTIVE no reactiva GPS. |
| Revocar identidad | DRAFT, INVITED, PENDING_CONFIRMATION, ACTIVE o SUSPENDED | REVOKED | Cancela invitaciones/claims, revoca binding, claves y sesiones, retira instalación, cancela ventanas y conserva historial/auditoría. Repetir REVOKED es idempotente. No existe REVOKED → ACTIVE. |
| Retirar del inventario operativo | DRAFT, INVITED, PENDING_CONFIRMATION, ACTIVE, SUSPENDED o REVOKED | RETIRED | Misma invalidación terminal que revocar; aparece en «Retirados». Repetir RETIRED es idempotente. No existe RETIRED → ACTIVE. |

Las demás transiciones administrativas son 409. El flujo existente de inscripción conserva DRAFT → INVITED → PENDING_CONFIRMATION → ACTIVE. El estado `SUSPENDED` no sustituye el estado de instalación, servicio Android ni frescura de lecturas. Las políticas asignadas y datos históricos se conservan; ninguna transición crea posiciones ni borra sesiones. Las consultas históricas siguen filtradas por capacidad y tenant histórico.

Cada mutación exige sesión administrativa, Origin, CSRF, `gps.installation.manage`, tenant autorizado y motivo. La transacción bloquea primero `geops_device`, igual que la ingesta GPS; la solicitud concurrente que llega después observa el estado nuevo y se rechaza o resulta idempotente. Las acciones terminales requieren confirmación explícita en Web. La revocación puede dejar un teléfono desconectado capturando localmente: la autorización del servidor se corta de inmediato, mientras que el servicio Android solo se detiene al observar el rechazo o al terminar su ventana local. No se promete parada remota instantánea.

La emisión de una sesión PoP también bloquea la fila `geops_device` antes de comprobar la clave. Si compite con suspensión, o bien la sesión se emite antes y la suspensión la revoca, o bien la suspensión gana y la emisión se rechaza. La vista GPS operativa muestra únicamente identidades activas autorizadas; Inventario conserva los estados terminales y permite consultar sesiones históricas bajo `gps.session.read`. La consulta de ubicación exige `gps.location.read` y motivo por solicitud; por eso no se carga automáticamente al abrir el inventario.

## Verificación previa a publicación

- `npm test`, `npm run typecheck`, `npm run build`, `npm run contracts:check` y vectores SPEC-02: PASS.
- `npm run lint`: PASS con 12 avisos existentes en archivos ajenos a Wave 2. `npm run security:scan`: PASS (406 archivos). `git diff --check`: PASS.
- PostgreSQL/PostGIS desechable: 15 migraciones; inscripción y ciclo de vida, políticas GPS (45 aserciones), configuración (24), salud (37), eventos (69) y operaciones (58): PASS. No se usaron datos de Staging.
- Kotlin/JVM `syntheticTest`: PASS en contenedor Gradle con JDK 17 (BUILD SUCCESSFUL).
- Impeccable: se ejecutaron `context` y `detect`; `detect` devolvió `[]`. El comando `audit` no está disponible en la versión instalada. Se hizo revisión manual del inventario sintético en 390 px y 1280 px: sin desbordamiento horizontal, foco visible, confirmación de acciones terminales y paginación funcional. **No se ejecutó una auditoría formal UIAudit**; no se declara PASS de UIAudit.
- Pendiente tras publicación: validación operativa en Staging con administrador autenticado y dispositivo de prueba autorizado. No se ha comprobado parada física en un teléfono ni se han modificado los cinco dispositivos existentes.
