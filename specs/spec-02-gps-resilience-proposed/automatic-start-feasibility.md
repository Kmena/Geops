# Viabilidad de inicio al comienzo de la jornada

**Fecha de consulta:** 20/10/2026. Fuentes primarias: documentación de Android Developers citada abajo. **Conclusión para la APK actual:** no hay inicio automático de jornada implementado ni documentablemente garantizable. El manifest no declara `ACCESS_BACKGROUND_LOCATION`, receiver `BOOT_COMPLETED` ni permiso de alarmas exactas; la Activity visible arranca el FGS y el servicio devuelve `START_NOT_STICKY`. `targetSdk=35` en HEAD. Android recibe instancias UTC del servidor; una alarma local jamás sería fuente de autoridad para capturar.

## Matriz de alternativas

| Alternativa | Clasificación | Condiciones y límite |
| --- | --- | --- |
| Usuario abre GEOPS o pulsa notificación y se inicia FGS `location` desde interacción visible | **Técnicamente viable y documentada** | Revalidar política/PoP/ancla/ventana y permisos; notificación e indicadores visibles. Es inicio asistido, no inicio autónomo a la hora exacta. |
| Mantener un FGS de ubicación ya iniciado antes del turno | **Viable bajo condiciones específicas** | Servicio y proceso vivos, permisos y proveedor disponibles, energía/OEM compatibles. Fuera de ventana no debe registrar ni solicitar ubicaciones; sostener FGS ocioso todo el día exige justificación de privacidad y batería. No resuelve reboot ni parada del usuario. |
| `START_STICKY` para recrear un servicio muerto durante una jornada | **Viable bajo condiciones específicas** | Es una solicitud de recreación al sistema, no garantía temporal ni autorización; el servicio reconstruido debe revalidar todo antes de GPS. No reabre automáticamente una app force-stopped ni una autorización offline invalidada por reboot. |
| WorkManager periódico como reloj de inicio o GPS cada 60 s | **No garantizada** para inicio; **no permitida como promesa de 60 s** | Mínimo 15 min y ejecución diferible por Doze/batería. Sí es candidato a subida independiente de backlog; no concede acceso a ubicación ni exención para iniciar FGS. |
| AlarmManager inexacto para recordar siguiente turno | **No garantizada** | Puede demorarse por Doze/OEM. Requiere comprobar ventana real al ejecutarse; puede despertar para una notificación o evaluación, no implica captura. |
| AlarmManager exacto para activar GPS desatendido | **Viable bajo condiciones específicas**, sin garantía general | Requiere caso de uso preciso de cara al usuario y, según API/target, acceso especial `SCHEDULE_EXACT_ALARM` o elegibilidad restringida de `USE_EXACT_ALARM`; Android 14 lo deniega por defecto a muchas instalaciones. Exención de inicio FGS no elimina restricción de ubicación while-in-use; se requiere evaluar permiso background y privacidad. No se adopta por defecto. |
| `BOOT_COMPLETED` para restaurar planificación y avisar | **Viable bajo condiciones específicas** | Tras reboot se pierde el ancla monotónica de ADR-017; sin reconexión y nuevo snapshot no se captura. Android 15 prohíbe arrancar ciertos tipos FGS desde boot; `location` no aparece en esa lista, pero conserva reglas de permiso y background. OEM y stopped state pueden impedir recepción/ejecución. |
| `BOOT_COMPLETED` → FGS de ubicación con solo permiso while-in-use | **No permitida/ineficaz** para captura desde background | Android 14+ comprueba permiso al crear FGS y puede lanzar `SecurityException`; en versiones previas el servicio podía iniciarse sin acceso efectivo a ubicación. |
| Solicitar `ACCESS_BACKGROUND_LOCATION` | **Viable bajo condiciones específicas** | Permiso separado, justificación y aprobación de privacidad. Puede habilitar acceso de un FGS `location` iniciado legítimamente desde background en las excepciones documentadas; **no** concede por sí solo derecho a iniciar FGS ni garantiza ejecución/OEM. La APK actual no lo pide. |
| DPC propio en modo Device Owner | **Viable bajo condiciones específicas** | Android documenta excepción para **la app que es DPC Device Owner**, no para cualquier app administrada. Puede gestionar permisos mediante `DevicePolicyManager`, sujeto a reglas de ubicación, FGS, avisos y condiciones de provisión. GEOPS hoy no es DPC/DO; adoptar esa arquitectura es decisión empresarial separada, con pruebas multimarca. |
| MDM externo administra la APK ordinaria | **No garantizada** | Estar inscrita bajo MDM no convierte a GEOPS en DPC ni elimina límites de background, force-stop, indicadores o batería. Políticas OEM pueden variar y requieren prueba contractual/física. |
| Reabrir captura después de parada explícita o force-stop del usuario sin nueva acción | **No permitida como objetivo de diseño** | Android 13 permite Stop de apps con FGS; Android 15 preserva `FLAG_STOPPED` y cancela pending intents hasta interacción. GEOPS debe respetar la parada y mostrar pérdida de comunicación en servidor, no buscar una vía de evasión. |

## Diferencias por versión

| Sistema | Hecho documentado relevante | Implicación para GEOPS |
| --- | --- | --- |
| Android 12 / API 31–32 | Desde target 31, inicio FGS en background restringido con excepciones. Alarmas exactas requieren acceso especial para casos apropiados. | Un disparador de horario no basta; el inicio visible sigue siendo la ruta robusta. |
| Android 13 / API 33 | El usuario puede detener la app con FGS desde Task Manager. `POST_NOTIFICATIONS` afecta visibilidad del aviso según reglas, no exime FGS. | Distinguir stop explícito de muerte de proceso; no autoreiniciar a ciegas. |
| Android 14 / API 34 | Tipos/permiso FGS y requisitos while-in-use se verifican al arranque; `SCHEDULE_EXACT_ALARM` suele denegarse por defecto en instalaciones nuevas elegibles. | `location` FGS iniciado desde fondo con permiso solo while-in-use falla; probar `SecurityException` y permisos reales. |
| Android 15 / API 35 | Boot receiver no puede iniciar ciertos tipos FGS (incluido `dataSync`), pero la lista no incluye `location`; stopped state cancela pending intents. | No inferir permiso para `location` desde ausencia en lista; se aplican las otras reglas. No usar FGS `dataSync` al boot para backlog. |

**Fabricantes y batería:** Android documenta que restricciones concretas de background varían por fabricante. `LocationManager.requestLocationUpdates(minTime)` solicita un mínimo entre actualizaciones, no una entrega exacta cada minuto; Doze puede diferir red, jobs y alarmas. Dos teléfonos de distintos OEM son gate mínimo, no prueba de los 25 modelos. No diseñar exenciones de batería indiscriminadas sin decisión de negocio/privacidad. [Restricciones background](https://developer.android.com/develop/background-work/background-tasks/bg-work-restrictions), [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby), [LocationManager](https://developer.android.com/reference/android/location/LocationManager).

## Fuentes oficiales

- [Inicio FGS desde background y excepciones para ubicación/Device Owner](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Tipos FGS y requisitos de `location`](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Cambios Android 14 de tipos FGS](https://developer.android.com/about/versions/14/changes/fgs-types-required)
- [Cambios Android 15 para `BOOT_COMPLETED`](https://developer.android.com/about/versions/15/behavior-changes-15)
- [Estado stopped de Android 15](https://developer.android.com/about/versions/15/behavior-changes-all)
- [Parada de FGS iniciada por el usuario](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)
- [WorkManager periódico](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest)
- [Alarmas exactas, permisos y usos](https://developer.android.com/develop/background-work/services/alarms)
- [Concesión de permisos por Device Owner/Profile Owner](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#setPermissionGrantState(android.content.ComponentName,%20java.lang.String,%20java.lang.String,%20int))
- [Semántica de `Service` y `START_STICKY`](https://developer.android.com/reference/android/app/Service)

## Estudio MDM todavía necesario

Para cada fabricante/versión del piloto: identificar modalidad real (Fully Managed, COPE o Work Profile), paquete que actúa como DPC y propietario efectivo; verificar por documentación del proveedor y prueba física si puede gestionar el permiso de GEOPS, iniciar **su propio** FGS o invocar legalmente la APK, y qué ocurre tras reboot, ahorro de batería y parada explícita. El resultado de una DPC Device Owner no se atribuye a GEOPS si GEOPS sigue siendo una app ordinaria. La provisión real, compatibilidad de 25 teléfonos y conservación de datos son decisiones del estudio MDM, no de este SPEC.

**Decisión provisional:** mantener inicio diario asistido con un toque como respaldo. Investigar inicio desatendido como opción bloqueada, sin añadir `ACCESS_BACKGROUND_LOCATION` hasta demostrar necesidad y obtener revisión de privacidad. Ninguna opción autoriza capturar fuera de ventana ni eludir una parada explícita.
