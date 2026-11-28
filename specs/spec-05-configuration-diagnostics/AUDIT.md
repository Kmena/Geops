# Wave 0 — Auditoría de configuración, GPS y MDM

Fecha de revisión: 2026-11-27. Base auditada: b597c9f, rama aislada codex/mdm-diagnostics-wave0. Método: lectura de código y documentación; consulta de documentación oficial. No se consultó un tenant MDM ni un teléfono real. Los documentos de pruebas anteriores se usan como evidencia histórica, no como observación actual. Actualización: DEC-MDM-001/002/003 aprobadas; ManageEngine es el proveedor único.

**Actualización Wave 4:** el usuario aprobó Wave 3 solo parcialmente y autorizó Wave 4. La auditoría de autenticación encontró cuentas, permisos, sesión con vencimiento/revocación, Origin y CSRF reutilizables desde Android mediante HTTPS. La APK Corporate emplea una sesión administrativa solo en memoria y el backend exige login reciente para correcciones sensibles. La pantalla local se amplió; el tenant ManageEngine, la lectura de permisos MDM real, el Moto G06 y la causa GPS continúan sin verificación. Consultar [arquitectura de autenticación](WAVE2-ADMIN-AUTH-PROPOSAL.md) y [cierre Wave 4](WAVE4-CLOSEOUT.md); los cuadros históricos siguientes describen la auditoría de Wave 0 y no el estado actual del código.

**Actualización Wave 5:** el usuario aprobó técnicamente Wave 4. La auditoría UX encontró que `/status` ya contiene conexión, sincronización y vínculo MDM, `/inventory` conserva identidad/activación GEOPS y las pantallas `/gps/*` cubren políticas y posiciones; se amplió `/status` sin crear un segundo módulo. La navegación mantiene una sola entrada “Integración MDM” con seis secciones internas y filtros en URL. La proyección administrativa agrega también dispositivos sin diagnóstico y aplica RBAC más ambos grants de tenant antes del listado, detalle y exportación. La lectura de políticas, vista previa, solicitud y auditoría reutiliza contratos Wave 3. La validación de navegador es sintética y no acredita el tenant real ni la ejecución Android física. Véanse [contratos](WAVE5-API-CONTRACT.md), [cierre](WAVE5-CLOSEOUT.md) y [limitación de solicitud remota](WAVE5-REMOTE-DIAGNOSTIC-PROPOSAL.md). Los cuadros de Wave 0 siguientes permanecen históricos.

## 1. Estado y trazabilidad del producto

| Tema | Evidencia del repositorio | Conclusión |
| --- | --- | --- |
| Arquitectura | [ADR-001](../architecture/adr/ADR-001-monorepo.md), [ADR-002](../architecture/adr/ADR-002-gps-propio.md), [ADR-007](../architecture/adr/ADR-007-mdm-externo.md) | Monorepo API TypeScript/PostgreSQL, web React y agente Kotlin. El MDM es un plano externo; GPS llega directamente a GEOPS. La separación hexagonal es un objetivo del nuevo módulo, no una estructura uniforme ya aplicada. |
| MDM real | [adaptador](../../apps/api/src/mdm/provider.ts), [rutas](../../apps/api/src/mdm/routes.ts), [ADR-007](../architecture/adr/ADR-007-mdm-externo.md) | Proveedor confirmado ManageEngine; el adaptador actual está orientado a MSP Cloud y lee inventario/estado. La edición del tenant real no está verificada. FakeMdmProvider se usa en pruebas. No hay cliente Android Management API ni recursos enterprises/policies en este código. |
| Vinculación | [inventario](../../apps/api/src/mdm/inventory.ts), [migración 0018](../../apps/api/src/db/migrations/0018_mdm_inventory.sql) | Asociación exclusiva entre ID ManageEngine y geops_device, sincronización con bloqueo y reintentos; la vinculación no concede autenticación al dispositivo. |
| Identidad y autorización | [rutas de identidad](../../apps/api/src/device-identity/routes.ts), [alcance](../../apps/api/src/device-identity/admin-scope.ts), [ADR-019](../architecture/adr/ADR-019-empresa-unica-administracion-por-capacidades-propuesto.md) | Sesión administrativa con CSRF y capacidades por usuario; instalación GPS usa clave/PoP independiente. Hay un tenant sintético y límites de alcance. No existe una sesión de empleado en la APK corporativa. |
| GPS v2 | [configuración](../../apps/api/src/gps-device-config.ts), [runtime](../../apps/android-app/src/main/kotlin/com/geops/mobile/AgentRuntime.kt), [servicio](../../apps/android-agent/src/android/kotlin/com/geops/agent/GeopsLocationService.kt) | Política firmada/autenticada, captura, cola cifrada, ACK, salud y continuidad. La política corporativa continua depende de autorización individual y vínculo MDM; no depende de rutas. |
| Telemetría existente | [salud](../../apps/api/src/gps-health-service.ts), [continuidad](../../apps/api/src/gps-continuity-monitor.ts), [diario](../../apps/android-agent/src/main/kotlin/com/geops/agent/Diagnostics.kt) | Salud de GPS, eventos de servicio/captura/sync y diario cifrado local de 24 h. No hay snapshot remoto estructurado de permisos/configuración efectiva. |
| Web | [Inventario](../../apps/web/src/app.tsx), [administración](../../apps/web/src/DeviceManagement.tsx) | Inventario MDM, vínculo, dispositivos GPS y últimas posiciones; no existe matriz deseada/aplicada/efectiva ni corrección de políticas. |
| APK | [Activity](../../apps/android-app/src/main/kotlin/com/geops/mobile/EnrollmentActivity.kt) | Diagnóstico local textual y resumen técnico; la vista corporativa técnica depende de admin_diagnostics_enabled en Managed Configurations. No hay autenticación administrativa interactiva ni pantalla estructurada de permisos. |
| Publicación | [guía dual APK](../../docs/operations/spec04-dual-apk-readiness.md) | Corporate com.geops.corporate y Personal com.geops.personal, versionCode 1 y versionName 1.0.0-spec04-test en Gradle; minSdk 26, targetSdk 35, compileSdk 36. La guía registra builds locales, no una versión instalada actual. |
| Recuperación | [receptor](../../apps/android-app/src/main/kotlin/com/geops/mobile/AutonomousBootReceiver.kt), [alarmas](../../apps/android-app/src/main/kotlin/com/geops/mobile/WindowWakeScheduler.kt) | Boot, reemplazo de paquete y cambios de reloj programan una alarma; el FGS usa START_REDELIVER_INTENT. La recuperación sigue sujeta a permisos, política local y restricciones Android. |

El [manifiesto común](../../apps/android-app/src/main/AndroidManifest.xml) declara FINE, COARSE, BACKGROUND, FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, INTERNET, ACCESS_NETWORK_STATE y SCHEDULE_EXACT_ALARM. El [flavor Corporate](../../apps/android-app/src/corporate/AndroidManifest.xml) añade Managed Configurations y elimina cámara; el Personal hereda cámara/QR y no incorpora Managed Configurations. WAKE_LOCK no está declarado ni aparece como mecanismo del servicio: clasificarlo NOT_DECLARED y no pedirlo sin necesidad demostrada. El [manifiesto del módulo android-agent](../../apps/android-agent/src/android/AndroidManifest.xml) es auxiliar; la APK final fusiona manifiestos y se debe verificar el artefacto por flavor.

## 2. DEC-MDM-001 — ManageEngine confirmado

El usuario corrigió la identificación del proveedor: **ManageEngine es la autoridad MDM oficial**. El código existente apunta a MSP Cloud, pero la edición operativa del tenant está pendiente de verificación. GEOPS ampliará el adaptador existente; no se implementará cliente AMAPI, otro proveedor, migración ni reenrolamiento. Android Management API queda fuera del alcance de SPEC-05.

La [API MSP de dispositivos](https://www.manageengine.com/mobile-device-management-msp/api/devices/) documenta inventario y detalle; la [API de perfiles](https://www.manageengine.com/mobile-device-management-msp/api/profiles/) documenta lectura y escritura genérica de perfiles; la [guía de permisos y configuraciones](https://www.manageengine.com/mobile-device-management/help/android_for_work/mdm_app_configurations_and_permissions.html) describe funciones de consola. **Esas páginas no prueban que el tenant, edición, licencia y versión de GEOPS permitan cada operación por API.** La validación de permisos, perfiles concretos, asignación, reporte aplicado y semántica de errores es gate obligatorio antes de Wave 3. El inventario actual continúa read-only.

## 3. GPS limitado al primer plano: evidencia e hipótesis

**Causa raíz: no confirmada.** No hay en este worktree un registro del Motorola Moto G06 con APK, permisos efectivos, política aplicada, eventos FGS y timestamps de captura/transmisión durante la falla. La [guía de prueba física](../../docs/operations/mdm-corporate-physical-test.md) enumera acciones esperadas; la [guía SPEC-04](../../docs/operations/spec04-dual-apk-readiness.md) declara pendientes las pruebas físicas. La auditoría histórica de POCO [distingue una regresión posible de proveedor](../../docs/audit-regresion-gps-poco-2026-10-21.md), pero es otro paquete y no prueba el caso corporativo actual.

| Hipótesis | Evidencia de código | Prueba discriminante futura |
| --- | --- | --- |
| Permiso efectivo faltante, ubicación apagada o precisión aproximada | La Activity corporativa exige FINE, BACKGROUND y POST_NOTIFICATIONS antes de iniciar; la alarma vuelve a comprobar FINE, BACKGROUND y GPS. No existe inventario remoto de esos valores. | Leer permisos y LocationManager en el Moto G06, cotejarlos con política MDM y observar FGS_PROMOTION_FAILED / WINDOW_WAKE_BLOCKED. |
| Inicio autónomo impedido por Android/OEM | [WindowWakeScheduler](../../apps/android-app/src/main/kotlin/com/geops/mobile/WindowWakeScheduler.kt) usa startForegroundService desde una alarma y registra bloqueo/reintento. Android limita FGS iniciados en background y aplica condiciones extra para location. | Registrar evento de alarma, excepción codificada, estado de proceso y versión Android con pantalla apagada. |
| Servicio activo pero sin callbacks | El servicio registra Fused de Play Services y recurre a GPS_PROVIDER; el runtime intenta recuperar listener tras 180 s sin callback. | Separar FGS_PROMOTED, LISTENER_REGISTERED, CALLBACK_RECEIVED y CAPTURE_ACCEPTED con horas observadas. |
| Captura local sin transmisión | Cola cifrada y SyncJobs son independientes; puede haber pendientes, backoff o rechazo de ACK. | Comparar última captura, cola, SYNC_ACK, salud backend y conectividad. |
| Política/autorización caducada o identidad inválida | La recuperación evalúa política local, boot, vigencia offline y vínculo; error de config 401/403 detiene captura. | Cotejar evaluación local con /v2/device/config, autorización individual y estado MDM de esa instalación. |
| Muerte o cierre forzado del proceso | onDestroy conserva intención condicionada; START_REDELIVER_INTENT y alarmas no garantizan reactivación tras force-stop. | Distinguir minimizar, retirar de recientes, kill del sistema, force-stop y reboot mediante eventos y prueba supervisada. |

La Activity hace unbind en onDestroy, pero inicia explícitamente el servicio con startForegroundService; por lectura del código, cerrar la interfaz no llama a stop del servicio. Esto descarta una dependencia directa obvia de la Activity como explicación única, no demuestra continuidad física. El servicio y sus alarmas siguen sujetos a las [restricciones FGS](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [permisos de ubicación](https://developer.android.com/develop/sensors-and-location/location/permissions) y [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby).

**Primera captura de evidencia recomendada, sin modificar el teléfono en Wave 0:** paquete y versión instalada; Android/API/OEM; modo MDM y política real; permisos FINE/COARSE/BACKGROUND/POST_NOTIFICATIONS; ubicación global y precisión; optimización de batería; timestamps de FGS, listener, callback, captura, ACK, último heartbeat y cola. Correlacionar por instalación, boot y tiempo UTC. Si el diario de 24 h expiró, programar prueba física autorizada en Wave 6.

## 4. Matriz de capacidades actuales

E = existe; P = parcial; N = no existe. “ME API” distingue documentación pública de **capacidad comprobada en el tenant GEOPS**. Ninguna función de consola se considera escribible por API sin ensayo de edición/licencia/scopes.

| Capacidad | GEOPS | ME API en GEOPS | APK | Manual / límite |
| --- | --- | --- | --- | --- |
| Inventario MDM y vínculo GEOPS | E | GET devices/list/detail comprobado en código; tenant real sujeto a conexión | No | Integración actual read-only |
| Política MDM deseada y asignada | N | Perfil API documentado; alcance y asignación sin verificar | No | Wave 3 tras ensayo de tenant |
| Política aplicada y cumplimiento | N | Lectura de restricciones/perfiles por dispositivo documentada; versión/cumplimiento específicos sin verificar | No | No inventar equivalente a nonComplianceDetails |
| Permisos declarados por flavor | P | No es fuente efectiva | Sí | Verificar manifiesto final |
| Permisos runtime efectivos y precisión | P local textual | Estado de consola no basta | Sí | Android puede restringir o revocar |
| Ubicación global/proveedores | P local GPS provider | Perfil/consola no equivale a estado Android | Sí | Algunas acciones requieren usuario |
| FGS y último listener/callback | P local | No | Sí | Proceso muerto: UNKNOWN |
| Optimización de batería y datos restringidos | N | API para excepción por app no verificada | Sí, parcialmente | Límites OEM no observables |
| Captura, cola, ACK y salud | E/P | No | Sí | Telemetría GPS existente |
| Managed Configurations | P: invitación configurada en consola | Escritura por API no verificada | Sí, lectura | No exponer invitation_secret |
| Corrección remota de permisos | N | Perfil de permisos en consola; endpoint/payload/licencia sin verificar | Verificación posterior | Solo tras prueba de Wave 3 |
| Corrección masiva con vista previa | N | Asignación/actualización API sin verificar | Verificación | Perfil compartido afecta a varios |
| Diagnóstico histórico estructurado | P: diario y GPS health | No | Sí, nueva telemetría | Separar posiciones GPS |
| RBAC administrativo y auditoría | P: capacidades GPS/MDM y audit_event | No | No administrativo | Faltan capacidades diagnósticas |
| Pantalla APK y portal comparativos | N | No | Sí | Wave 1 adelanta pantalla local |

## 5. Matriz Android / ManageEngine

| Propiedad o permiso | Tipo y versión | ManageEngine actual / por verificar | Fuente efectiva y cautela |
| --- | --- | --- | --- |
| ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION | Runtime; FINE puede degradarse a aproximada en Android 12+ | Consola puede configurar permisos de app; API concreta/edición sin verificar | APK checkSelfPermission de ambos; precisa solo si FINE efectivo. [Android](https://developer.android.com/develop/sensors-and-location/location/permissions/runtime), [ManageEngine](https://www.manageengine.com/mobile-device-management/help/android_for_work/mdm_app_configurations_and_permissions.html) |
| ACCESS_BACKGROUND_LOCATION | Runtime especial desde Android 10 | Configuración en consola documentada; API y modo del Moto G06 sin verificar | APK lo comprueba por separado; en Android 11+ la concesión manual usa Ajustes. [Android](https://developer.android.com/develop/sensors-and-location/location/permissions/background) |
| FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION | Declaración/permiso FGS; tipo location exigido al target actual | No asumir control por perfil MDM | Manifest fusionado + inicio/promoción observada. [Android 14](https://developer.android.com/about/versions/14/changes/fgs-types-required) |
| POST_NOTIFICATIONS | Runtime Android 13+ | Configuración exacta por perfil/API sin verificar | El código GEOPS lo usa como gate propio; revisar si es necesario. [Android](https://developer.android.com/develop/ui/views/notifications/notification-permission) |
| RECEIVE_BOOT_COMPLETED, INTERNET, ACCESS_NETWORK_STATE | Permisos normales declarados | No son evidencia de ejecución ni de red | APK: manifiesto/capacidad y eventos de boot/red |
| WAKE_LOCK | No declarado | No se pide | NOT_DECLARED; evaluar solo si un caso técnico lo exige |
| SCHEDULE_EXACT_ALARM | Acceso especial declarado | Concesión remota por API sin verificar | APK canScheduleExactAlarms; fallback inexacto |
| Política de ubicación/perfil | Depende de modo Android Enterprise y payload de perfil | [API de perfiles MSP](https://www.manageengine.com/mobile-device-management-msp/api/profiles/) documenta endpoints generales; payload, asociación y estado aplicado deben verificarse en tenant | APK consulta ubicación global/proveedor; política no prueba estado efectivo |
| Instalación/control de usuario | Configuración de aplicación y perfil | Consola y API pueden diferir; no se probó escritura | No evitan todos los cierres Android/OEM |
| Managed Configurations | Restricciones por app | GEOPS configura invitación en consola; escritura API pendiente de prueba | APK RestrictionsManager; jamás registrar invitation_secret |
| Reportes de app/dispositivo | Inventario ManageEngine | GET devices/list/detail implementados; perfiles/restricciones por dispositivo documentados pero no integrados | Pueden estar desactualizados. [API MSP](https://www.manageengine.com/mobile-device-management-msp/help/api/cloud/api-index.html) |
| Cambios de perfil/permisos | API MSP documenta edición genérica de perfiles | Compatibilidad, scopes, licencia, idempotencia, reporte posterior y efecto sobre perfil compartido pendientes | Releer y comprobar permiso efectivo desde APK |

## 6. Alcance de la evidencia

La auditoría de Wave 0 fue estática, sin conexión al tenant/dispositivo. Los estados históricos BUILD SUCCESSFUL y LOCAL_TECHNICAL_PASS de [SPEC-04](../../docs/operations/spec04-dual-apk-readiness.md) no son prueba física. La implementación local de Wave 1 y su evidencia están en [el cierre](WAVE1-CLOSEOUT.md).
