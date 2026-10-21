# Riesgos y bloqueos

## Wave P0 — riesgos abiertos de GPS-UPLOAD-STARTED-BLOCKER

Contrato, decisión y ramas en [diseño P0](gps-upload-started-blocker-p0-2026-10-21.md). Todos están **abiertos** hasta implementación y evidencia; las pruebas citadas son futuras.

| ID | Riesgo | Mitigación y prueba |
| --- | --- | --- |
| R02-22 | Migrar/envolver buffer v1 pierde ubicaciones o cambia digest. | Preservar `event_id`/payload, comparar conteos, rollback sin borrado; P19. |
| R02-23 | STARTED duplicado o ACK perdido crea dos sesiones. | Unicidad por dispositivo/instalación/sesión, recibo pos-COMMIT y replay; P15/P17. |
| R02-24 | Rechazar posición offline válida bajo revisión anterior o ADR-020. | Validar versión/evidencia originales; conservar pendiente hasta extensión Wave A/D, sin ACK ficticio; P18/P19. |
| R02-25 | Android/API de versiones distintas interpreta v2/v1 o ACK ambiguo. | Ruta v2 aditiva, gate de capacidad, sets exactos y fallback sin borrado; P17/P19. |
| R02-26 | Locks, sesiones fuera de orden o retransmisiones concurrentes bloquean/duplican. | Serialización determinista por dispositivo, transacción corta, digest y prueba de carreras; P16/P17. |
| R02-27 | Registros tardíos, dependencia v1 de siete días o revocación diferida causan pérdida. | Conservar cifrado, cuarentena explícita, decisión histórica en Wave D; P18/P19. |
| R02-28 | Integración parcial de ramas omite `PendingUpload`/JobService o dependencias SQL. | Revisar diffs/commits y migraciones, E2E Kotlin↔API↔DB y POCO antes de cierre; P15/P19. |

**Riesgo vigente DEC-GPS-OFFLINE-001 (2026-10-21):** [ADR-020](../architecture/adr/ADR-020-ultima-politica-valida-offline.md) amplía la exposición a revocación no recibida hasta la vigencia explícita de la última política válida, potencialmente varios días. La mitigación histórica de 12 h/primera ventana de R02-02 ya no es vigente. Se suman reloj civil después de reboot sin red, horizonte de asignación, compatibilidad de ingesta v1 y backlog >7 días. Seguridad/privacidad deben aceptar la exposición antes de captura real.

**R02-21, release 2026-10-20 — rollback de 0015 (`BLOCKED`):** una migración fallida mantiene el gate en mantenimiento y la versión antigua no puede consumir el gate nuevo con nonce después del éxito. La cuarentena de backups protege identidades pero no devuelve acceso operativo. Se requiere un procedimiento de recuperación supervisado, probado en réplica y aprobado independientemente antes de publicar/actualizar Staging. Se corrigieron localmente dos riesgos de restauración: invitaciones/grants no invalidados y gate abierto sin vínculo al marcador. [Evidencia](w1-e2-single-tenant-release-readiness-2026-10-20.md).

**Enmienda ADR-019, riesgos abiertos:** el administrador principal concentra gestión de cuentas y permisos; requiere selección/custodia formal, contraseñas fuertes, revisión independiente, auditoría y procedimiento de recuperación con dos custodios. El tenant único `synthetic` se establece una sola vez; un tenant equivocado o grants históricos incompatibles bloquean la ceremonia, sin corrección SQL manual. La invitación de un solo uso exige entrega privada del token y protección frente a intentos de activación; su ventana es limitada. La migración 0015 en Staging necesita backup probado, gate de mantenimiento/epoch y ensayo de restauración antes de ejecutarse. La implementación no concede acceso en Staging ni habilita dispositivos reales. El flujo de admin2/doble aprobación descrito abajo es histórico para operaciones ordinarias.

**R02-11, diagnóstico previo al cierre técnico de admin2 (2026-10-19):** la [ceremonia inicial sintética](gps-capability-grants-proposal-2026-10-19.md) elimina el vacío de implementación del primer grant GPS sin privilegios automáticos. Persiste riesgo de custodia: dos cuentas de recuperación distintas no prueban dos personas independientes. La dependencia circular de admin2/tenant descrita en este corte se resuelve en el párrafo siguiente. No ejecutar la ceremonia en Staging antes de aprobar custodios, alcance tenant y revisión de seguridad.

**R02-11, cierre técnico sintético posterior:** el [runbook de admin2 y tenant](admin-tenant-bootstrap-runbook-2026-10-19.md) elimina esa dependencia circular en código mediante cuenta secundaria `LOCKED`, recuperación supervisada y aprobación tenant entre dos sesiones distintas. El riesgo de custodia humana y el alcance tenant siguen pendientes de aprobación; los datos del tenant nunca se conceden por la capacidad GPS sola. La ruta de inventario se limita al binding fake `synthetic` y a `gps.installation.manage`.

**W1-E2, 2026-10-19:** [evidencia y gates](w1-e2-first-device-2026-10-19.md). El APK firmado de prueba y las conexiones Web/API reducen brechas de implementación, pero añaden superficies que requieren prueba física y revisión independiente: orden de arranque del FGS y proveedor GPS, persistencia tras muerte de proceso/reinicio, custodia de firma, excepción de atestación sintética, activación por identificadores manuales y revocación offline. No se ha probado comportamiento OEM ni E2E de navegador contra Staging. MDM-001–006 y privacidad operativa siguen sin resolución.

**W1-E1 Corte 3:** [evidencia](w1-e1-c3-scheduler-activation-web-2026-10-19.md) reduce el bloqueo técnico de scheduler/activación/Web de lectura en sintético, pero **no cierra** R02-17/R02-19 ni W1-E1. ADR-018 y capacidades nuevas requieren aprobación; instalaciones previas quedan fail closed y precisan backfill/reactivación; retención/auditoría/backups y claves no tienen política operativa aprobada; faltan navegador E2E, carga sostenida y revisión independiente. La prueba de 25 dispositivos es carga acotada, no capacidad de producción. Los requisitos originales se conservan. Las notas previas abajo son históricas.

**W1-E1 Corte 2:** sesiones/posiciones pasaron integración sintética con [evidencia](w1-e1-c2-sessions-positions-2026-10-19.md); R02-12 reduce el riesgo de contrato/desorden, pero no está cerrado para operación. Quedan: reintento obligatorio de cuarentena `202` (no hay reprocesador), expiración y borrado de ciphertext a siete días, clave de cifrado sin rotación/restore operativo, migración 0012 que requiere revisión de filas preexistentes, scheduler de retención, concesiones tenant y seguridad independiente. La descripción del corte anterior abajo es histórica; los requisitos originales se mantienen.

**Corte W1-E1:** R02-17 baja de bloqueo de ruta a bloqueo de **activación de instalación**: `/v1/device/config` con PoP y emisión tenant se probó, pero no existe el alta supervisada. R02-19 mantiene pendiente scheduler/retención operativa aunque backup/restore de una base desechable pasó. Se añade el riesgo de vencimiento temporal de asignación sin avance de `assignment_version`: el snapshot podría emitir tombstone con versión previa y Kotlin rechazarlo como conflicto; se necesita scheduler/reconciliación antes de operar. Sesiones/posiciones y Web E2E siguen abiertos. [Evidencia detallada](w1-e1-readiness-2026-10-19.md). Los requisitos originales no cambian.

## GPS-HEALTH-001: riesgos abiertos (2026-10-19)

| ID | Riesgo | Mitigación / gate abierto |
| --- | --- | --- |
| R02-16 | SPEC-01 no tiene ámbito tenant en administrador. | `gps_health_tenant_access` deniega por defecto y filtra lecturas; faltan flujo supervisado de alta/baja, revisión independiente y prueba operativa de cambio de tenant. |
| R02-17 | El registro `gps_device_installation` y `GET /v1/device/config` aún no se emiten desde activación. | Fixture sintético funciona; cablear identidad/configuración antes de conectar Android o declarar interoperabilidad. |
| R02-18 | Una muestra atribuida a una ventana puede ser falsa si el teléfono/clave está comprometido; silencio no demuestra batería agotada. | PoP, ancla/boot, rango UTC y estado `NO_COMMUNICATION` como inferencia; aceptación de riesgo y prueba física pendientes. |
| R02-19 | Retención en tabla primaria sin scheduler/backups alineados. | Purga por lotes probada en DB desechable; programador, restore y plazo definitivo requieren privacidad/seguridad. |
| R02-20 | Reatribución de un backlog antiguo al tenant nuevo al transferir teléfono. | El ancla fija `health_mdm_binding_id`/`health_tenant_id` y la ingesta exige coincidencia con el vínculo activo; transferencia probada en PostgreSQL sintético. La emisión real de anclas sigue pendiente. |

| ID | Riesgo | Control y prueba | Estado |
| --- | --- | --- | --- |
| R02-01 | Android impide iniciar FGS `location` desde fondo; ventanas quedan sin captura. | Diseño de `MISSED_START`, interacción visible, P12 por OS/modelo; no prometer inicio automático. | Abierto, físico. |
| R02-02 | Revocación no llega offline y continúa captura. | [ADR-017](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md): máximo 12 h y fin de instancia, reboot fail closed, P05/P07; aceptar riesgo residual antes de piloto. | Diseño resuelto; aceptación operativa pendiente. |
| R02-03 | Política vieja/ajena o cliente manipulado habilita horario no autorizado. | PoP SPEC-00, versión monotónica, vínculo servidor, caché/ancla protegidas, `anchor_elapsed_realtime_ms`/delta UTC, restore epoch ADR-013, P04/P05. | Diseño resuelto; un teléfono comprometido aún puede mentir y exige pruebas/aceptación operativa. |
| R02-04 | Solape grupo/directo o DST genera ventanas ambiguas. | [ADR-017](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md): sin precedencia, exclusión temporal por dispositivo, instancias UTC y fixtures P03/P05. | GiST, carreras y DST sintéticos probados en W1-B; Android/PoP pendientes. |
| R02-05 | Sesiones inferidas se presentan como hechos y sesgan cobertura. | Eventos explícitos y estados `UNKNOWN_END/MISSED`; métricas con denominador y evidencia, P08/P10. | Diseño. |
| R02-06 | Pérdida de clave/buffer, backup o ACK genera fuga o pérdida de datos. | Cifrado seleccionado antes de datos reales, exclusión Auto Backup, cola/cuota/ACK, P07/P09. | ADR-008 abierto. |
| R02-07 | SPEC-01 no cierra identidad/admin/auditoría/restore. | Gates por wave; W1-A/C sintéticos, integración operativa espera P10–P17, W0A-E2/T18. | Bloqueo de integración real. |
| R02-08 | Exposición de ubicación y retención incompleta. | Capacidades mínimas, motivo/rango de hasta 24 h, logs sin coordenadas, 90 días con backup/purga probados, revisión de privacidad. | Bloqueo para datos reales. |
| R02-09 | Frecuencia GPS/Sync agota batería o se degrada por OEM. | Intervalos objetivo, telemetría y P11/P12 por modelo; ajustes aprobados en Web. | Físico pendiente. |
| R02-10 | MDM Free no impide desinstalar ni apagar ubicación; aprovisionamiento/multimarca sin resolver. | Investigación MDM separada, estado explícito en piloto; no implementar MDM ni cambiar ManageEngine. | Cuatro bloqueos externos independientes. |
| R02-11 | SPEC-01 autentica admin pero no tiene capacidades GPS; publicación excesiva. | [ADR-015](../architecture/adr/ADR-015-capacidades-administrativas-gps.md): siete capacidades, denegación por defecto, concesión auditada y P02. | Servicio y deny-by-default sintéticos en W1-B; doble control de concesión real y revisión pendientes. |
| R02-12 | STARTED/STOPPED duplicados o desordenados crean sesiones falsas. | [ADR-016](../architecture/adr/ADR-016-identidad-sesiones-gps.md): ID canónico servidor, provisional local, 202 cuarentena, 409 digest y UNKNOWN_END; P08. | Diseño resuelto; integración pendiente. |
| R02-13 | Replay de respuesta idempotente tras revocar capacidad, o mismo key con otro `If-Match`. | Auth/capacidades actuales antes de lookup; fingerprint incluye precondición; registro y efecto en una transacción, V11/P02. | Implementado y probado con HTTP/PG sintéticos; revisión independiente pendiente. |
| R02-14 | Diferencia entre modelo Node, cliente Kotlin y PostgreSQL. | [Vectores V01–V12](test-plan.md) son referencia; T03 ejecuta GiST/concurrencia en DB desechable, T06 consume fixtures en Kotlin y T09 verifica wire real. | Gate W1-B/C/E1; no declarar interoperabilidad completa. |
| R02-15 | Diagnóstico de reinicio sin ancla se acepta como inicio efectivo o una razón libre filtra datos. | ADR-016 y OpenAPI: `MISSED_START` sin ancla solo diagnóstico; STARTED exige ancla y `reason_code` es enum, P06/P08. | Diseño resuelto; validación Android/API pendiente. |

La PoC de 543 posiciones y 4 sesiones inferidas reduce incertidumbre sobre ingesta/cadencia bajo ese ensayo, pero no cierra ninguno de los riesgos de inicio automático, revocación offline, identidad del producto ni límites MDM.
