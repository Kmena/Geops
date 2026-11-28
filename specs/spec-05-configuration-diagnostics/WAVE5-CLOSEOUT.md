# SPEC-05 — Cierre de Wave 5 para revisión

Fecha: 2026-11-27. Rama aislada `codex/mdm-diagnostics-wave0`. Wave 4 aprobada técnicamente por el usuario; Wave 3 continúa parcial. Wave 5 se ejecutó solo en laboratorio local y se detiene aquí, antes de Wave 6. No se modificó `main`, producción, perfiles operativos ManageEngine, motor GPS v2 ni código Android en Wave 5. No se instaló, distribuyó ni generó una nueva APK.

## Entrega y auditoría UX

La navegación existente tenía `/status` para conexión/sincronización ManageEngine, `/inventory` para identidad/activación GEOPS y `/gps/*` para políticas, posiciones y continuidad. Se amplió **la misma** ruta `/status` con Resumen, Dispositivos, Permisos y configuración, Diagnósticos, Correcciones e Historial y auditoría. Se conservaron la conexión y el vínculo MDM existentes. No hay un segundo módulo MDM ni una regla de diagnóstico duplicada en React. Los filtros viajan en URL; las llamadas reutilizan el cliente API, sesión GEOPS y CSRF. La vista responde a móvil con filtros apilados y tablas desplazables, estados de carga/error/vacío y códigos técnicos dentro de detalles desplegables.

El backend agrega equipos registrados con y sin snapshot mediante una proyección SQL con última observación y contacto, alcance por `mdm.diagnostics.view` más grants de datos y salud del tenant, y consultas acotadas. Los indicadores distinguen permiso faltante, batería, captura, transmisión, falta de comunicación, diagnóstico antiguo y ausencia total de datos. El valor de **conformidad** es `null` porque la evidencia ManageEngine real no está disponible: ningún equipo sin telemetría se clasifica como conforme. El cliente MDM del proveedor usa ID de cliente propio, separado del tenant GEOPS. Hay filtros combinables, búsqueda, orden, paginación, selección de hasta 100 equipos y exportación JSON sanitizada.

El detalle compara deseado/administrado/efectivo donde existen señales. El snapshot remoto v1 carece de estado individual de Foreground Service Location, recuperación tras reinicio, último intento de envío e intervalos reales; esas filas muestran **pendiente/no disponible**. Los perfiles asignados/aplicados reportados no se promueven a permiso Android efectivo. Las discrepancias MDM se leen del comparador Wave 3. La línea temporal muestra solo diagnósticos, capturas, ACK, cambios comparativos de permisos/configuración, eventos administrativos y correcciones con timestamps disponibles. No fabrica eventos FGS ni cambios históricos del proveedor. La solicitud de diagnóstico remoto inmediato permanece no soportada; [propuesta acotada](WAVE5-REMOTE-DIAGNOSTIC-PROPOSAL.md).

La interfaz de correcciones reutiliza vista previa, impacto individual, solicitud local, reautenticación reciente, idempotencia, historial y confirmación. Una solicitud queda para revisión y no aplica MDM. El endpoint de envío sigue respondiendo `503 mdm_write_disabled`; no se habilitó una vía alternativa ni operación masiva de escritura. Los [contratos API](WAVE5-API-CONTRACT.md) documentan los endpoints aditivos. No hubo migración nueva en Wave 5.

## Pruebas ejecutadas

| Comprobación | Resultado | Alcance |
| --- | --- | --- |
| API unitarias | PASS: 84 | Proveedor, políticas, auth, cookies, GPS y suites previas; mocks |
| Web unitarias | PASS: 64 | Cliente, navegación, disponibilidad MDM, GPS y regresiones existentes |
| Integración Wave 5 PostGIS | PASS | Agregación con equipo sin snapshot, vínculo, permisos, batería, transmisión, filtros, paginación, página vacía, tenant cruzado, timeline, reporte y correcciones con RBAC; parámetros inválidos, idempotencia, auditoría y escritura cerrada |
| Regresión PostGIS Waves 1–3 | PASS | 24 aserciones de ingesta diagnóstica, políticas/corrección, inventario, enrolamiento, upgrade 0035→0042, recuperación y 64 aserciones GPS mixtas |
| Chrome E2E local | PASS: 20 checks | API+Vite+PostGIS desechable, 8 equipos sintéticos visibles, uno de otro tenant oculto y adaptador ManageEngine simulado; usuario limitado/admin, dashboard, filtros, detalle, matriz, timeline, preview, solicitud, write gate, historial, selección/exportación y móvil |
| Typecheck y build API/Web | PASS | `VITE_MDM_ENABLED=true` para build web de laboratorio; sin despliegue |
| Lint del monorepo | PASS, código 0 | 12 advertencias preexistentes GPS; archivos Wave 5 sin advertencias |
| Kotlin `syntheticTest` | PASS: 62 | Motor GPS y diagnósticos; imagen local JDK 17, sin dispositivo físico |
| Corporate/Personal compile y lint | PASS | Ambos flavors con JDK 17, sin `assemble` ni APK nueva; advertencia deprecación `versionCode` |
| Tenant ManageEngine real | BLOCKED | No se recibieron edición, licencia, versión, región, scopes ni credenciales de solo lectura verificables |
| Moto G06 y APK ejecutada | NOT_RUN | Sin teléfono/emulador conectado; pantalla APK y continuidad física no observadas |

Capturas **reales** de Chrome en el entorno descartable: [dashboard](../../output/playwright/spec05-wave5-dashboard.png), [detalle y matriz](../../output/playwright/spec05-wave5-device-detail.png), [móvil](../../output/playwright/spec05-wave5-mobile.png) y [cierre E2E](../../output/playwright/spec05-wave5-complete.png). Los nombres de equipos en ellas llevan “SINTÉTICO”; no representan la flota operativa. Scripts reproducibles: `scripts/run-spec05-wave5-integration.ps1`, `scripts/run-spec05-wave5-browser-e2e.ps1` y la regresión `scripts/run-spec05-wave3-integration.ps1`. El runner del navegador limpia contenedor, servidor, navegador y directorio temporal al finalizar.

## Estados independientes

| Estado solicitado | Resultado | Razón |
| --- | --- | --- |
| WAVE1_TECHNICAL_PASS | PASS | Aprobación previa |
| WAVE2_TECHNICAL_PASS | PASS | Aprobación previa |
| WAVE3_TECHNICAL_PARTIAL | PARTIAL | Aprobación parcial; tenant real pendiente |
| WAVE4_TECHNICAL_PASS | PASS | Aprobación expresa en SPEC-05 Wave 5 |
| WEB_MDM_DASHBOARD_PASS | PARTIAL | Indicadores observables PASS en laboratorio; conformidad queda `null` hasta lectura MDM real |
| WEB_DEVICE_LIST_PASS | PASS | Chrome y PostGIS sintéticos: filtro, búsqueda, paginación, selección |
| WEB_DEVICE_DETAIL_PASS | PASS | Chrome muestra identidad, GPS, MDM, permisos, fuentes y estados desconocidos |
| WEB_PERMISSION_MATRIX_PASS | PARTIAL | Matriz funcional; aplicado por permiso MDM y señales FGS individuales sin contrato confirmado |
| WEB_GPS_DIAGNOSTICS_PASS | PARTIAL | Captura/ACK/cola/estado visibles; intento de envío e intervalos reales no están en snapshot remoto |
| WEB_DIAGNOSTIC_TIMELINE_PASS | PASS | Eventos con timestamps disponibles; ausencias declaradas, sin inferencias inventadas |
| WEB_REMEDIATION_UI_PASS | PASS | Vista previa, impacto, confirmación, solicitud e historial sintéticos |
| WEB_MDM_WRITE_GATE_PASS | PASS | Chrome y API verifican `503 mdm_write_disabled` |
| WEB_REPORT_EXPORT_PASS | PASS | JSON descargado en Chrome; selección y ámbito/auditoría probados en PostGIS |
| WEB_RUNTIME_UI_VALIDATION | PASS | Chrome real local, escritorio y 390 px; no producción |
| WEB_E2E_PASS | PASS | 20 checks con PostGIS y mock MDM desechables |
| RBAC_SECURITY_PASS | PASS | 403 sin capacidad/export; login reciente y CSRF en corrección; alcance validado en backend |
| MULTITENANT_ISOLATION_PASS | PASS | Tenant B excluido de listado, detalle, timeline y reporte sintéticos |
| APK_WEB_CONTRACT_CONSISTENCY_PASS | PARTIAL | Mismos endpoints y enums Wave 2/3; ejecución de UI APK sigue pendiente |
| GPS_V2_REGRESSION_PASS | PASS | 64 aserciones GPS mixtas y 62 pruebas Kotlin; físico pendiente |
| BYOD_REGRESSION_PASS | PARTIAL | Personal compile/lint y suite compartida PASS; sin runtime físico |
| MANAGEENGINE_REAL_VALIDATION | BLOCKED | Tenant/licencia/API/scopes sin evidencia |
| APK_INSTALLED_COMPATIBILITY | BLOCKED | Paquete/firmante de la APK actualmente instalada en Moto G06 no obtenidos |
| PHYSICAL_DEVICE_VALIDATION | NOT_RUN | Moto G06 no inspeccionado |
| GPS_BACKGROUND_ROOT_CAUSE | BLOCKED | Sin traza física discriminante |
| GPS_24H_VALIDATION | NOT_RUN | Requiere observación física continua |
| PRODUCTION_READY | BLOCKED | NO; tenant, firma release, pruebas APK y Moto G06 pendientes |

## Riesgos y punto de parada

La web no puede confirmar un permiso aplicado por ManageEngine ni editar intervalos GPS cuando el contrato no suministra esa evidencia. Las cifras de diagnóstico solo reflejan snapshots recibidos y caducidad de 15 minutos; un dispositivo desconectado puede tener estado Android distinto. El reporte exporta máximo 100 equipos por petición; páginas adicionales requieren exportaciones separadas. La interfaz usa una tabla con desplazamiento horizontal en móvil. El bundle web muestra una advertencia de tamaño de chunk durante build, sin fallo. Las credenciales de ManageEngine permanecen en backend y el mock se usó solo en la fixture local.

Se conserva la candidata Corporate de Wave 4: `com.geops.corporate`, versionCode 4, versionName `1.0.3-spec05-wave4`, SHA-256 APK `426F31CD209A8B0E725FFF24A619FCB8EE32EC7D5794EC12F4B1A8602D36C200` en `apps/android-app/build/outputs/apk/corporate/debug/`. No se generó una versión Wave 5. La comparación con la APK instalada, la validación de Moto G06 y el procedimiento controlado de actualización siguen en [Wave 4](WAVE4-MOTO-G06-UPDATE.md) y [R1](WAVE1-R1-LAB-PROTOCOL.md). **Detenerse para revisión antes de Wave 6.**
