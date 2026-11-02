# GEOPS GPS por propiedad del dispositivo — SDD

Estado: V1 parcial en checkout; despliegue y activación corporativa pendientes. Base auditada: `codex/apk-v9-b32-staging-integration`, 2026-11-02.

La V1 exige autorización **individual**. Vincular inventario ManageEngine no activa GPS. Ningún dispositivo existente se reclasifica o habilita por migración. La mutación administrativa usa `If-Match` sobre `gps_device_ownership.version`, guarda base, evidencia, aviso y vigencia; la configuración v2 devuelve propiedad, modo y versión y cierra captura para `UNVERIFIED`. La política BYOD reusa las ventanas GPS existentes. Una revocación recibida produce configuración inactiva y conserva la subida de cola.

**Gate de tenant:** `requireInstallationAccess` comprueba el único tenant operativo `synthetic`; los identificadores de cliente de ManageEngine son diferentes. La revisión automática rechazó quitar la comprobación de tenant y el filtro de cliente del endpoint corporativo por riesgo de autorizar otro tenant. La activación corporativa real queda bloqueada hasta definir y probar un mapeo explícito entre tenant operativo, cliente MDM y grants administrativos.

## Decisión del propietario: único dispositivo heredado

La flota existente tiene un dispositivo que se retirará de operación. La operación exige su UUID real y una transición administrativa auditada a `DECOMMISSIONED`; nunca selecciona por cantidad ni aplica un backfill. La transición revoca autorizaciones GPS, claves y sesiones, cierra la instalación y vínculos activos, y conserva entregas, posiciones, sesiones, visitas y auditoría según la retención aplicable. El inventario operativo deja de mostrarlo y el inventario administrativo conserva su ficha. No se clasifica automáticamente como MDM o BYOD.

El servidor consulta `gps_policy_delivery` del UUID elegido antes del cambio y devuelve cantidad y vencimiento máximo de autorizaciones offline aún posibles. `DECOMMISSIONED` significa retiro y rechazo del lado servidor; solo se declara desactivación completa tras comprobar revocación efectiva en el equipo o el vencimiento de la última autorización offline. El bloqueo de compatibilidad heredada se retira únicamente tras verificar esta transición para el UUID real. La autorización corporativa 24/7 sigue siendo individual y exige MDM verificado.

## Alcance y decisiones

Una sola tubería de posiciones GPS conserva cola cifrada local, PoP, ACK idempotente y contrato de ingesta v2/v3. Tres funciones se separan: **captura** por autorización del dispositivo, **sincronización** de toda la cola pendiente incluso con captura detenida y **clasificación** histórica por ruta. Una ruta no concede ni revoca captura. La ventana de una visita solo afecta su evaluación. Fuera de ruta y fuera de geozona son estados distintos.

| Propiedad | Condición de captura | Al vencer | Interfaz |
| --- | --- | --- | --- |
| `CORPORATE_MANAGED` | Autorización corporativa vigente, inscripción MDM verificada por servidor, política continua y permisos Android | Cerrar captura; subir cola | Estado y diagnóstico; sin botón ordinario de parada |
| `PERSONAL_BYOD` | Autorización personal vigente y ventana laboral de política GPS independiente de rutas | Cerrar captura; subir cola | Estado, permisos, jornada y parada fuera de jornada |
| `UNVERIFIED` | Ninguna autorización nueva | Captura cerrada; cola histórica se sincroniza | Revisión administrativa |

Una caída temporal de ManageEngine conserva evidencia MDM previamente verificada hasta el fin explícito de su vigencia. Una baja confirmada revoca. El cliente jamás puede autoasignarse `CORPORATE_MANAGED`. Cada cambio exige actor, motivo, fuente, vigencia y versión creciente en historial append-only. No se rellena `PERSONAL_BYOD` por inferencia a partir de un vínculo GEOPS o de un horario antiguo.

## Auditoría de base

| Componente | Estado B32 y dependencia |
| --- | --- |
| APK v9 / Android | `PolicyEngine` evalúa política GPS v2 local con tzdb, vigencia, reloj y ventanas; `TrackingController` abre sesiones y conserva cola. `AgentRuntime`, `AutonomousBootReceiver` y `WindowWakeScheduler` reintentan donde Android permite. La pantalla aún ofrece parada al equipo MDM. |
| API config / ingesta | `/v2/device/config` entrega política recurrente y autorización hasta vigencia; ingesta v3 reconstruye autorización histórica. La sesión GPS continúa ligada a `gps_scheduled_session`, que procede de la **política GPS**, no de `route_assignment`. La entrega conserva `offline_not_after` para compatibilidad v1. |
| MDM | `mdm_inventory_device` y `gps_mdm_continuous_authorization` identifican equipos administrados. La integración no debe convertirse en latido necesario de cada fix. Verificar la interpretación real de `managed_status` y propiedad de ManageEngine en el tenant piloto. |
| Rutas / visitas | `route_assignment` tiene tiempo de visita y vínculo histórico `agent_device_link`. `visit_evaluation` y revisión 3 `TECHNICAL_ONLY` permanecen. No hay llamada de rutas desde el motor Android. |
| Web | `/gps/devices` y políticas GPS muestran sesiones y ventanas. Falta propiedad explícita y jornada BYOD en la ficha de dispositivo. Las rutas tienen editor propio. |
| Staging B32 | Checkout con migraciones 0033 y despliegue simple en `scripts/deploy/simple`; hay modificaciones locales previas en controladores y wrapper. No usar esos controladores para cambios ordinarios. |

## Contrato objetivo y persistencia

Una migración aditiva crea una identidad de seguimiento por dispositivo con propiedad, estado MDM, fuente, evidencia, vigencia y autorización versionada, más historial inmutable. Los registros existentes se conservan sin reclasificación ni autorización automática. La jornada BYOD usa una revisión de la política GPS existente: no se crea un calendario rival de rutas. Otra migración agrega el estado terminal `DECOMMISSIONED` y bloquea nuevas concesiones al dispositivo retirado.

Contrato de configuración nuevo, con versión explícita: `tracking_mode`, `ownership`, `authorization_version`, `authorization_until` y la revisión GPS. `CONTINUOUS` se admite solo para corporativo; `WORK_WINDOW` solo para BYOD. Un tombstone autenticado cierra captura con versión mayor. Android persiste la última política válida y máximo `authorization_version` para rechazar rollback. La pérdida de red no altera la autorización local vigente. La revocación recibida se aplica antes del siguiente callback. La ingesta reconstruye la autorización **al instante de captura**, no a la hora de llegada, y nunca descarta una posición legítima por falta de ruta.

La API administrativa requiere capacidad y alcance tenant para clasificar, verificar y revocar. `If-Match` y clave de idempotencia protegen cambios; una transición corporativa exige evidencia MDM del servidor. BYOD exige base documentada y consentimiento cuando corresponda. Lecturas de estado distinguen última captura, último ACK, listener observado e inferencia de continuidad. La clasificación de ruta se deriva de `captured_at`, vínculo histórico y asignación vigente entonces. Ningún endpoint de rutas activa GPS.

## Matriz de migración

| Origen | Destino | Acción de datos | Comportamiento hasta validar |
| --- | --- | --- | --- |
| Autorización continua MDM comprobada | `CORPORATE_MANAGED` | Autorizar individualmente tras mapeo de tenant, evidencia MDM, base, aviso y vigencia; conservar sesiones y eventos | No activar por enlace ni por backfill; gate operativa pendiente |
| Política horaria y evidencia personal | `PERSONAL_BYOD` | Reusar revisión GPS como jornada, conservar excepciones y auditoría | Requiere clasificación y autorización explícita |
| MDM ausente, estado confuso o vinculación sin propiedad | `UNVERIFIED` | Conservar historial, cola y horarios antiguos; no borrar | Sin nueva captura bajo contrato nuevo |
| Posición histórica sin ruta | `FUERA_DE_RUTA` | Conservar fila y ACK originales | No acredita visita sin ventana y reglas de evaluación |

No se eliminan columnas, endpoints ni historial. No hay backfill de autorización. El dispositivo heredado se retira mediante transición auditada por UUID. El rollback de aplicación deja las columnas nuevas sin borrar y desactiva el contrato nuevo; no revierte eventos ni versiones emitidas.

## Waves y pruebas de salida

0. Auditar contratos, MDM, Android, rutas, B32 y datos reales; fijar ADR y plan de migración.
1. Añadir modelo/versiones, verificación y endpoints; probar PostgreSQL/PostGIS, privilegios, revocación y migración.
2. Actualizar APK: modo continuo con notificación visible, BYOD con jornada, permisos, inicio tras reboot donde Android permite, cola independiente y diagnósticos. Probar reinicio, offline, reloj y cambio de autorización.
3. Clasificar rutas por captura histórica; probar ruta, ausencia, superposición impedida, cancelación posterior, posiciones tardías y geozonas por separado.
4. Mostrar propiedad, MDM, jornada y estados en Dispositivos; retirar horario GPS como módulo general sin borrar la configuración BYOD; probar navegador y accesibilidad.
5. Ejecutar regresión de ingesta GPS v2/v3, B32 (10 minutos acumulados, cobertura, evidencia insuficiente, reevaluación, scheduler/manual) y pruebas de carga/resiliencia.
6. Respaldar staging; ejecutar `geops check staging`, `geops deploy staging`, `geops status staging`; validar salud y migración. No producción ni distribución automática de APK.

Pruebas físicas: POCO y Huawei, Android 15/16 según versión disponible; pantalla apagada, ahorro de batería, reboot, proceso muerto, force-stop, sin red, MDM offline, revocación recibida y permisos revocados. Medir gaps frente al objetivo de 60 s y reportar causas; nunca extrapolar continuidad absoluta.

## Gates y riesgos

Android requiere FGS de tipo `location`, permiso de ubicación de fondo para reinicio/background y notificación visible; fabricantes pueden impedir arranque o suspender callbacks. La sincronización pendiente debe sobrevivir aunque la política de captura caduque. El reloj civil después de reboot offline no tiene prueba criptográfica general; conservar el cierre por incoherencia de ADR-020. Force-stop y revocación remota no recibida son límites explícitos.

Antes de flota real, asesoría local debe validar base jurídica, finalidad, proporcionalidad de 24/7, información al titular, retención, acceso, seguridad, transferencias y derechos bajo Ley 8968 y su reglamento. Esta revisión no se sustituye por permiso MDM ni por este SDD. Mantener revisión 3 de visitas en `TECHNICAL_ONLY`.

Fuentes: [Ley 8968](https://pgrweb.go.cr/DOCS/NORMAS/1/VIGENTE/L/2010-2019/2010-2014/2011/1153F/DCEF7.HTML), [restricciones FGS Android](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [cambios Android 15/16](https://developer.android.com/develop/background-work/services/fgs/changes), [API de dispositivos ManageEngine](https://www.manageengine.com/mobile-device-management/api/devices/).
