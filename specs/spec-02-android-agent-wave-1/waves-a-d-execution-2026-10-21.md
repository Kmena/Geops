# SPEC-02 — ejecución técnica P0 y Waves A–D (2026-10-21)

Rama: `codex/geops-spec02-mdm-integration`. Base verificada: `79fae4175b8343ec578f4feca59e8212d9ed07ae`. Este documento describe el código de la rama al cierre de la ejecución; el SHA inmutable evaluado y el resultado de auditoría se registran en el informe final de la tarea. No hubo instalación en POCO/Huawei, publicación ni despliegue.

## Contrato y decisiones

- ADR-020 rige la autorización offline. `GET /v2/device/config` entrega reglas recurrentes, excepciones, revisión, inicio de asignación y `authorization_until`. V1 sigue limitado al ancla de 12 horas/boot original. La migración `0021_gps_offline_policy_contract.sql` conserva su tabla y añade evidencia de entrega/boot para v2.
- `POST /v3/device/gps/batches` ingiere eventos de jornadas posteriores bajo la revisión entregada. Mantiene bearer, PoP, instalación, binding, tenant, ventana histórica, transacción, recibo e idempotencia. V1 y P0 v2 permanecen disponibles. El cliente no degrada eventos v3 a v1/v2 cuando v3 falta.
- El servidor registra `DEVICE_CLOCK_OFFLINE_V2`. La coherencia de tiempo transcurrido se valida por boot. Un reinicio offline carece de prueba criptográfica de hora civil: el reloj automático, una cota antirretroceso y la vigencia explícita reducen el riesgo, pero **no prueban** la fecha frente a manipulación con control del dispositivo. Requiere aceptación de Seguridad/Privacidad antes de piloto real.
- Una revocación recibida detiene la captura. Una revocación no recibida por desconexión solo puede hacerse efectiva cuando llega; la ingesta tardía se valida frente a la asignación histórica y conserva su procedencia. La autorización no se amplía por reintento ni por caducidad del token de subida.
- La auditoría independiente detectó que las sesiones futuras ya materializadas pasan a `CANCELLED` al revocar una política. V3 admite el evento histórico bajo la entrega/autorización previa y conserva la fila `CANCELLED`; no vuelve a habilitar esa jornada operativamente. Prueba HTTP/PostGIS: revocación entre entrega y captura, STARTED/posición atómicos, ACK y estado cancelado intacto.
- Android y backend resuelven una hora local inexistente por DST al primer instante válido después del salto; en solape usan el offset temprano para inicio y el tardío para fin. Los fixtures de Nueva York 2026 están en Kotlin y API. Android compara la versión tzdb entregada con la del sistema; si difieren, solo usa las instancias UTC exactas recibidas en la respuesta autenticada, hasta el horizonte de 7 días. Pasado ese horizonte falla cerrado y requiere nueva entrega de política. La disponibilidad de tzdb y ese fallback en POCO/Huawei requieren verificación física.
- El cooldown de STARTED se asocia al `boot_id` porque `elapsedRealtime` vuelve a cero al reiniciar. Los fixes batched de Fused con más de 120 segundos de edad se rechazan con `STALE_FIX`; no se cambia su timestamp original.
- La capacidad offline es finita: 32 MiB y 10 000 registros de todos los tipos; se demostró espacio para 4320 posiciones sintéticas (72 horas a un punto/minuto). No hay vencimiento local que borre pendientes: se conservan hasta ACK o remediación auditada. Si se llena el buffer, falla la nueva persistencia y el servicio registra/expone el fallo; no se promete captura ilimitada.
- La API admite eventos nuevos de hasta 90 días de antigüedad; luego responde rechazo y la APK conserva el registro en cuarentena local para remediación auditada. El recibo de un lote ya confirmado sigue resolviendo un ACK perdido. Esta ventana no amplía la vigencia de la política ni permite nuevas capturas fuera de autorización.
- El flujo manual de `EnrollmentActivity` conserva la verificación de identidad en servidor antes del primer inicio visible. La revisión automática rechazó omitirla en función de la política cacheada porque debilitaría la autenticación de inicio. Ese cambio no se aplicó; el inicio autónomo tras boot/redelivery usa la autorización local ya autenticada, pero el primer inicio visible sin red queda pendiente de un diseño de seguridad revisado.

## Matriz requisito → implementación → prueba → evidencia → estado

| Requisito | Implementación | Prueba / evidencia local | Estado |
| --- | --- | --- | --- |
| P0 STARTED y ACK exacto | `BatchSync.kt`, `gps-event-service.ts`, ruta v2 y migración 0020; `nextEligibleAtMs()` respeta backoff de STARTED por sesión | `syntheticTest`; `gps:mixed:integration` (64 aserciones v1/v2/v3, rollback, concurrencia, recibo, revocación diferida) | IMPLEMENTED; gate físico NOT_VERIFIED |
| A última política válida, jornada posterior y reinicio | `PolicyEngine.kt`, `AgentStore.kt`, `DeviceTransport.kt`, `gps-device-config.ts`, migración 0021 | Kotlin ADR-020 y DST; API configuración; PostGIS de próxima jornada, revocación diferida, otro boot, registro tardío y versión errónea | PARTIAL: hora civil tras reinicio no verificable criptográficamente; tzdb físico pendiente |
| A inicio sin abrir interfaz | `AutonomousBootReceiver.kt`, `GeopsApplication.kt`, `AgentRuntime.kt`; permiso background y servicio visible | Compilación Android y pruebas de motor local; sin dispositivo | PARTIAL: restricciones Android/OEM y preflight de inicio visible offline por verificar |
| B proveedor y continuidad | `GeopsLocationService.kt` selecciona Fused si GMS disponible y GPS de plataforma en fallback; watchdog vuelve a registrar sin fabricar coordenadas; STARTED cooldown por boot y rechazo de fix obsoleto | Compilación Android; Kotlin con GPS simulado, reinicio y callback atrasado | PARTIAL: POCO/Huawei, pantalla apagada y 60 s NOT_VERIFIED |
| C cola cifrada/capacidad | `EncryptedFileAgentStore` AES-GCM y escritura atómica, 32 MiB/10 000 eventos, alertas 70/90 %, ACK como única eliminación | Kotlin: 4320 posiciones recuperadas, corrupción, capacidad, backoff y ACK | IMPLEMENTED en JVM; Keystore/reinicio físico NOT_VERIFIED |
| D sincronización independiente | `PendingUpload`, `BatchSync`, `PendingUploadJobService`, JobScheduler con red; v3 por sesión y sin downgrade | Kotlin v2/v3 429, pérdida de ACK, múltiples sesiones; API/PostGIS idempotencia | IMPLEMENTED en pruebas sintéticas; recuperación de red/Doze física NOT_VERIFIED |
| Seguridad MDM/identidad | Rutas PoP y `GpsEventService.scope` preservan controles; migraciones 0017–0019 intactas | API `test`, `mdm:security:integration`, `mdm:integration`, OpenAPI | IMPLEMENTED en tests locales; MDM real NOT_VERIFIED |

## Gates y evidencia ejecutada

| Gate | Resultado |
| --- | --- |
| P0 técnico | PASS en Kotlin y PostGIS sintético, incluido STARTED en backoff y revocación offline; auditoría del SHA final pendiente. POCO pendiente. |
| Wave A técnico | PARTIAL por límite de hora civil tras reinicio, coincidencia tzdb física y flujo de inicio visible offline. Evaluación local, DST y nuevas jornadas demostradas en JVM/PostGIS. |
| Wave B técnico | PARTIAL: servicio compila, proveedor dual, cooldown tras boot y frescura de fix probados; continuidad física NOT_VERIFIED. |
| Wave C técnico | PASS JVM para cifrado, 4320 puntos, alertas, recuperación y conservación hasta ACK; Android Keystore físico NOT_VERIFIED. |
| Wave D técnico | PASS Kotlin/API sintético para cola, v3, recibo exacto y reintentos; red física/Doze NOT_VERIFIED. |
| PostGIS/migraciones | 21 migraciones aplicadas en base desechable; 0016→0021 y 0015→0021 poblada PASS. |
| Contratos | OpenAPI v1/v2/v3 validado por `contracts:check`; copia de SPEC-02 idéntica. |
| Android | `assembleDebug` y `lintDebug` PASS; `testDebugUnitTest` NO-SOURCE. Se corrigieron la comprobación de permiso Fused y la versión Fragment arrastrada por QR. |
| Lint | 31 errores `format` en 31 archivos no modificados por SPEC-02 (18 tests/scripts API, 2 CSS Web, 3 contratos y 8 scripts de raíz); 14 avisos `noNonNullAssertion`, incluidos dos preexistentes en `gps-event-service.ts`. La cuenta coincide con la línea base. Cuatro errores de formato introducidos en API durante la implementación se corrigieron. No se hizo refactor general. |
| Cierre técnico/operativo | BLOCKED/NOT_VERIFIED hasta auditoría independiente, resolución de hallazgos y pruebas físicas. |

## Prueba física sin borrar datos

Antes de instalar, registrar modelo, versión Android, paquete, `versionCode`, `versionName`, SHA-256 y certificado de firma del APK actual. Comparar firma y `applicationId` con el APK de diagnóstico. Si no coinciden, no instalar encima ni desinstalar: conservar la cola cifrada y planificar migración/backup aprobado. Verificar permisos de ubicación precisa, ubicación todo el tiempo y notificaciones; constatar notificación foreground y configuración de batería sin eludir controles del sistema.

En el mismo POCO: 30 min online con pantalla apagada; 30 min sin Internet; reconexión y drenaje; repetir sin Activity visible; jornada siguiente offline dentro de vigencia; reboot; política actualizada/revocación diferida; fin de horario; ACK perdido y sesiones acumuladas. Registrar solicitud, callback, aceptación, persistencia, intento de envío, ACK, pendientes, intervalos, intervalo máximo, pérdida, duplicados, latencia de drenaje y batería. Repetir en Huawei P40 para demostrar fallback sin GMS. Objetivo: al menos 27/30 minutos, máximo 180 s, cero capturas fuera de autorización, cero pérdida persistida y drenaje en 10 min con red estable. Los 60 s son objetivo operativo y no garantía Android.

Force-stop y cierre de Activity son casos distintos: el cierre de Activity no detiene por sí mismo el servicio; force-stop impide reinicio automático hasta nueva apertura según Android. BOOT_COMPLETED y recuperación de FGS dependen de permisos, versión y restricciones del fabricante. La ausencia de equipo/ADB mantiene todos los resultados físicos en `NOT_VERIFIED`.
