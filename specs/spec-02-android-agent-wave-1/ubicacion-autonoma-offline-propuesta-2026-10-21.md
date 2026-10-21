# GEOPS — SPEC actualizada: autonomía GPS y última política válida

**Actualización:** Wave P0 tiene implementación sintética en la rama aislada
`codex/geops-spec02-mdm-integration`; su gate sigue abierto por auditoría y
POCO. Las Waves A–E de esta propuesta no están implementadas. Las referencias
posteriores a P0 sin código corresponden al corte inicial de diseño; véase
el [informe de ejecución](integration-execution-2026-10-21.md).

**Predecesor obligatorio:** [Wave P0 GPS-UPLOAD-STARTED-BLOCKER](gps-upload-started-blocker-p0-2026-10-21.md) corrige el bloqueo global de subida por STARTED pendiente mediante ingesta v2 conjunta y atómica. Su cierre con interoperabilidad, auditoría independiente y POCO precede A–E; no cambia cuándo la política local autoriza captura ni el alcance de ADR-020. El contrato v1 y el APK todavía no implementan P0.

**Revisión:** 2026-10-21, DEC-GPS-OFFLINE-001 aprobada. **Estado:** diseño/documentación; APK, API y OpenAPI v1 siguen con el contrato anterior. **Autoridad:** [ADR-020](../architecture/adr/ADR-020-ultima-politica-valida-offline.md) sustituye la regla offline de [ADR-017 histórico](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md). Base física: [auditoría POCO del 21/10](../../docs/audit-regresion-gps-poco-2026-10-21.md). No se modificaron políticas laborales, código, teléfonos ni bases de datos.

## 1. Decisión y frontera de responsabilidades

**APK-FIRST / OFFLINE-FIRST / MDM-INDEPENDENT.** Android obtiene y valida el contrato cuando hay red; almacena la última política válida, evalúa localmente jornadas y excepciones, solicita y persiste fixes cifrados, y sube pendientes de forma independiente. El servidor publica revisiones/tombstones, mantiene la autoridad administrativa, valida ingesta histórica y devuelve ACK tras COMMIT. ManageEngine distribuye/administra la APK y puede facilitar permisos/restricciones, pero su disponibilidad no condiciona una captura. La app no necesita Activity visible mientras un FGS `location` autorizado esté activo. «Permanente» significa continuidad **dentro de horarios autorizados**, no captura de 24 horas.

El cambio sustituye tres gates anteriores: caducidad offline a 12 h, límite al fin de la primera instancia y validación online por cada nueva jornada. La pérdida de Internet no invalida por sí misma la política. **Se conservan** `valid_from/valid_until`, revisión/`assignment_version`, integridad, identidad, horario IANA, excepciones `OFF`/`REPLACE`, ventana `[inicio,fin)` y no captura sin política válida. No se añade otro vencimiento automático. Si `valid_until` explícito termina durante una desconexión, tampoco se amplía: se detiene. La revocación no recibida puede permitir captura hasta entonces; riesgo pendiente de aceptación de seguridad/privacidad.

## 2. Diagnóstico del contrato real y brechas

| Área | Existente en repositorio | Delta para DEC-GPS-OFFLINE-001 |
| --- | --- | --- |
| Permisos/servicio | APK `com.geops.mobile` pide fina/coarse, FGS `location` y notificaciones desde Activity; no `ACCESS_BACKGROUND_LOCATION`. Redelivery acotado, sin boot receiver. | Probar concesión background solo si una ruta legal requiere crear FGS desde fondo; inicio de jornada y reboot son gates Android independientes. |
| Proveedor | Agente usa `GPS_PROVIDER`; PoC separada usa Fused. Regresión de origen demostrada, causalidad no demostrada. | Comparación controlada Fused/GPS en POCO; seleccionar según precisión, cadencia, batería y disponibilidad offline. |
| Configuración | `GET /v1/device/config` v1 devuelve política semanal/excepciones, versión, `offline_not_after` y hasta siete días de `window_instances`; Android usa exclusivamente esas instancias y `validatedInstance`. | Versionar contrato y motor para acreditar asignación/horario de jornadas posteriores sin red. La recurrencia sola no prueba que una asignación futura siga vigente; el horizonte fijo y el campo `offline_not_after` v1 contradicen la nueva decisión. |
| Tiempo/ingesta | Mismo boot, ancla monotónica, máximo 12 h; backend coteja `capture_anchor_id` y delta con tolerancia 30 s. | Diseñar evidencia y validación histórica para nuevos boots/días offline; declarar incertidumbre del reloj civil sin red. El servidor actual rechazará o pondrá en cuarentena eventos no compatibles. |
| Persistencia/envío | Archivo AES-GCM atómico con máximo 10 000 eventos/4 MB; `JobScheduler` de subida; ACK por IDs. | Dimensionar buffer, fallos de escritura y pruebas de recuperación. Mantener IDs/ACK; no hacer de HTTP un gate de GPS. |

El APK identificado en disco tiene SHA-256 `11DF66BDCE32FD7086E41E88551BAE5062F899D06103E05D5CC31B71DA97D8D1`; aún no se verificó que sus bytes sean los instalados. «GPS activo» en UI no prueba callback/fix/persistencia. La muestra observada contiene un hueco de 330 s y un rechazo local sin motivo exportado; no acredita causa raíz.

## 3. Política local: estados y transiciones

Los siguientes son **fases conceptuales de la política**, no nuevos valores de enum/API. Se proyectan en el modelo actual `UNPROVISIONED`, `IDLE_NO_POLICY`, `READY`, `CAPTURING`, `BLOCKED_POLICY`, `EXPIRED` y en `active`/versión del snapshot. Los estados de servicio y cola son independientes.

| Fase conceptual | Representación y transición |
| --- | --- |
| Sin política válida | `IDLE_NO_POLICY`/`BLOCKED_POLICY`; no GPS. Una primera respuesta válida crea `READY`. |
| Recibida y validada | Respuesta autenticada, identidad/instalación/esquema/versión/vigencia y datos temporales verificados; escritura protegida y atómica **antes** de aplicarla. Descarga fallida o corrupta deja la anterior intacta. |
| Activa | `READY` fuera de ventana; `CAPTURING` solo con FGS legal, listener y ventana aplicable. Una ventana que termina retira listener sin invalidar política. |
| Política local usada offline | Misma revisión almacenada y estados `READY`/`CAPTURING`, con indicador de uso offline y hora de última verificación; no se crea una autorización distinta. Puede abrir nueva jornada si la asignación/horario son demostrables localmente. |
| Actualizada | Revisión/`assignment_version` superior válida sustituye atómicamente la anterior; cerrar generación/sesión previa antes de evaluar otra ventana, sin reetiquetar eventos. Snapshot idéntico no pausa listener. |
| Revocada | `active:false`/tombstone válido y versionado desplaza política, detiene captura y prohíbe nuevos fixes. Pendientes previos siguen cifrados; envío sujeto a identidad vigente y reglas backend. |
| Inválida | Contrato nuevo corrupto, ajeno, inferior, de esquema desconocido o temporalmente incoherente: rechazar **nuevo** contrato; conservar último válido. Si el almacén local/identidad/tiempo aplicable es inválido, `BLOCKED_POLICY`, sin GPS. |

**Casos A–G:** con red, descargar-validar-persistir-aplicar; sin red, continuar con último válido; nueva jornada offline, calcular ventana y solicitar arranque si Android lo permite; reboot offline, recuperar almacén e intentar solo por ruta legal y con tiempo local admisible; cambio remoto no conocido, seguir revisión local y registrar exposición; reconexión, consultar configuración y drenar cola de forma independiente, sin bloquear captura por HTTP; revocación **recibida y validada**, detener inmediatamente antes del siguiente callback. La sincronización de pendientes puede continuar fuera de horario sin acceder al proveedor de ubicación.

**Brecha temporal obligatoria:** la implementación actual usa instancias UTC del servidor como única autoridad y no lleva un contrato offline suficiente para futuras asignaciones más allá de ellas. Wave A debe fijar una representación versionada y autenticada de **alcance temporal de asignación y excepciones**, cálculo local IANA/DST con paridad de servidor, política de versión tzdb y tratamiento al agotar horizonte. No se introducen aquí campos/endpoints/migraciones nuevos. Si el cliente no puede probar una jornada con el contrato disponible, no la inicia; esto es un gate de compatibilidad, no un TTL de conectividad.

## 4. Motor de captura, permisos y autonomía Android

Solicitud objetivo cada ~60 s en FGS `location` con notificación del SO. En cada callback comprobar proveedor, precisión, frescura (`elapsedRealtime`), boot, revisión, sesión/generación y ventana local autorizada antes de persistir. Persistencia confirmada precede a contador «capturada» y a cualquier HTTP. No fabricar puntos para intervalos sin fix. Fused de la PoC es candidato principal; `GPS_PROVIDER` actual es comparador/fallback sujeto a prueba, sin dos listeners simultáneos ni aceptación de caché vieja. El intervalo Android es indicativo, no SLA ([Fused `LocationRequest`](https://developers.google.com/android/reference/com/google/android/gms/location/LocationRequest.Builder)).

| Condición Android | Resultado esperado |
| --- | --- |
| Activity cerrada/pantalla apagada, FGS ya iniciado | Continuar dentro de ventana, sujeto a callbacks reales, permisos, batería y OEM. |
| Proceso muerto por sistema | Recuperar servicio solo si Android lo recrea; reconstruir estado, revalidar ventana y no inventar fixes del hueco. |
| Nuevo turno offline | Política local puede autorizarlo; **iniciar FGS** requiere por separado una excepción de background start o acción visible. Registrar `MISSED_START` si no puede. |
| Reboot offline | Política permanece, pero ancla monotónica previa no; evaluar tiempo/boot bajo contrato futuro y ruta de inicio legal. No afirmar recuperación garantizada. |
| Task Manager Stop/force-stop | Parada explícita, sin autorrecuperación prometida ni evasión. |
| Fin horario, `valid_until`, revocación recibida o política local inválida | Cancelar listener/FGS y rechazar callback tardío. |

Android 10 permite opción «todo el tiempo» en diálogo; Android 11+ lleva a Ajustes para background; Android 12+ permite precisión aproximada; Android 13+ agrega permiso de notificación (FGS sigue requiriendo notificación aunque se niegue); Android 14+ verifica permiso de tipo FGS y ubicación al crear el servicio. `ACCESS_BACKGROUND_LOCATION` habilita acceso en ciertos inicios desde fondo, **no** concede una excepción para iniciar FGS. ManageEngine Fully Managed puede facilitar concesiones si es Device Owner real y su aprovisionamiento lo permite; GEOPS no hereda privilegios DPC. [Permiso background](https://developer.android.com/develop/sensors-and-location/location/permissions/background), [FGS location](https://developer.android.com/develop/background-work/services/fgs/service-types), [restricciones de inicio](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [DevicePolicyManager](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#setPermissionGrantState(android.content.ComponentName,%20java.lang.String,%20java.lang.String,%20int)).

## 5. Buffer, sincronización y observabilidad

Flujo: fix → autorización/calidad → escritura cifrada duradera con `event_id` y metadatos de política/sesión → pendiente → envío por lotes con red → ACK exacto tras COMMIT → marcar confirmado/liberar espacio. La cola y la política son persistencias distintas; error HTTP, caída de servidor o MDM y falta de Internet no cancelan solicitudes GPS. Reintentar con el mismo ID; ordenar por `captured_at,event_id`; `409/422` van a cuarentena, no a borrado. Un registro ya persistido no se elimina antes de ACK válido. Llenado/fallo de escritura es explícito y auditable.

**Capacidad provisional:** 32 MiB y ≥4 320 posiciones (72 h a un minuto, sin prometer 72 h de autorización), alertas 70/90 %, pendientes sin purga automática por edad. Al llenarse, conservar previos y declarar explícitamente la condición de cola llena (`queue_full` en el almacén actual); la captura nueva no puede garantizarse con almacenamiento finito. ADR-016 conserva `client_session_id` provisional y sesión canónica del backend. El servidor v1 solo tolera dependencia/llegada tardía hasta siete días y usa ancla online: la aceptación de backlog de varios días/boots requiere revisión versionada, sin alterar retroactivamente ACK ni retención de 90 días.

Diagnóstico separado: última solicitud, callback **bruto** y procesado, fix aceptado, fix persistido, intento HTTP, ACK, pendientes/cuarentena, rechazo con motivo, estado FGS/listener, permiso/proveedor, revisión local y última verificación online. «GPS activo» nunca equivale a captura confirmada. Diario cifrado y acotado, sin coordenadas ni secretos exportables. Marcar cada posición como obtenida bajo revisión local con o sin conectividad; hora reportada no es prueba criptográfica tras reboot sin red.

## 6. Waves sin repetir trabajo completado

**Orden actualizado:** Wave P0 → A → B → C → D → E. P0 elimina el bloqueo de progreso de subida y establece el sobre v2 inicial; A/D añaden después la evidencia/validación de nuevas jornadas y boots offline bajo ADR-020. La ruta D no puede reintroducir una barrera global por `STARTED` ni usar `202` como ACK. [Plan](plan.md), [tareas](tasks.md) y [pruebas](test-plan.md) fijan el gate previo.

| Wave futura | Delta pendiente y dependencia real | Gate |
| --- | --- | --- |
| A — contrato persistente | Aprovechar snapshot AES/PoP/versión máxima y resolver IANA del backend como referencia; Android hoy solo evalúa instancias UTC recibidas. **Versionar** alcance de asignación para jornadas futuras, cálculo local con paridad, tiempo tras reboot, integridad/rollback y revocación diferida. | Vectores Android/backend de nueva jornada offline, DST, expiración explícita y downgrade. |
| B — GPS autónomo | Aprovechar FGS, listener, redelivery y diagnósticos R1–R3; evaluar Fused, permisos, boot y disparadores permitidos. | Sin captura fuera de ventana; pantalla apagada/proceso/reboot/force-stop clasificados. |
| C — buffer | Aprovechar AES-GCM, cola e IDs existentes; definir ampliación a 32 MiB/4 320, atomicidad, saturación, integridad y migración si se elige otro almacén. | Crash, disco lleno y restauración sin pérdida de pendientes previos. |
| D — sincronización | Aprovechar `JobScheduler`, batches, ACK e idempotencia existentes; desacoplar totalmente políticas y subida, versionar ingesta histórica offline. | ACK por ID, dependencia STARTED, reintentos, revocación y >7 días. |
| E — validación | POCO mismo APK y segunda familia OEM; red/servidor/MDM caídos, pantalla apagada, jornada nueva offline, reboot, cambio/revocación diferida y fin. | Evidencia física y revisión seguridad/privacidad; sin declarar PASS antes. |

## 7. Criterios de piloto y preparación

Tramos de 30 min con/sin red y Activity cerrada: objetivo 27/30 minutos con fix persistido, intervalo máximo ≤180 s, cero capturas fuera de horario conocido, cero pérdidas de registros ya persistidos. Al reconectar: ACK por ID, cero duplicados lógicos y drenaje del tramo de 30 min en ≤10 min con red/backend sanos; captura nueva no espera al uploader. Una nueva jornada offline debe arrancar **si Android permite el inicio**; si el SO lo bloquea, `MISSED_START` y la causa son resultado medible, no éxito de autonomía. Reboot físico offline requiere política recuperada, tiempo evaluable y ruta FGS legal. Medir batería y cadencia real, sin prometer minuto exacto.

**Estado:** decisión arquitectónica cerrada; **no lista para implementación/captura real** hasta versionar contrato de política e ingesta, resolver tiempo tras reboot y aceptación histórica, cubrir riesgo de revocación diferida y validar permisos/arranque en POCO. La [matriz de impacto documental y técnico](impacto-dec-gps-offline-001-2026-10-21.md) separa compatibilidad, cambios documentales y trabajo futuro.
