# SPEC-05 — Informe de Wave 4

Fecha: 2026-11-27. Rama aislada `codex/mdm-diagnostics-wave0`. Entrega para revisión técnica; Wave 5 no iniciada. No se modificó `main`, producción, políticas operativas ManageEngine, motor GPS v2 ni reglas Corporate/BYOD. No se instaló, distribuyó ni reenroló ningún dispositivo.

## Implementación

- La APK Corporate amplía la misma Activity de “Configuración y diagnóstico” con nueve secciones en español: dispositivo, permisos, batería/segundo plano, GPS, ManageEngine, configuración GPS, conectividad, reportes y sesión. La pantalla local sigue disponible tras activación sin sesión administrativa. El código de login y la Activity administrativa están en `src/corporate`; el flavor Personal no los compila ni declara en su manifiesto.
- El login HTTPS reutiliza usuarios, sesiones, Origin/CSRF, permisos y grants GEOPS. El token de cookie y CSRF viven solo en memoria de proceso; no se guarda contraseña ni token. El logout borra la sesión local y solicita revocación backend. Un 401 la limpia. El backend comprueba sesión fresca de cinco minutos para vista previa, solicitud y envío MDM. La [arquitectura y matriz RBAC](WAVE2-ADMIN-AUTH-PROPOSAL.md) distinguen dispositivo, agente, sesión y permisos.
- La pantalla consume diagnóstico Wave 2 y configuración/capacidades/historial Wave 3 con RBAC. Permisos Android y diagnóstico local se muestran con fuente/hora; MDM sin tenant verificado se muestra como no disponible, nunca concedido. La corrección permite vista previa y solicitud local solo cuando la API lo autoriza, con clave de idempotencia estable por vista previa. `submit` real conserva `mdm_write_disabled`; la UI no afirma aplicación MDM. Parámetros GPS existentes se leen, pero no se editan porque no hay contrato de actualización segura autorizado.
- El reporte usa `CreateDocument` de Android y excluye coordenadas, tokens, contraseñas e identificadores completos. Se añadieron último intento de transmisión, último inicio/interrupción observados y errores separados de captura/transmisión al diagnóstico local sin cambiar el contrato de snapshot Wave 2 ni el motor GPS. El resumen GPS solo afirma servicio detenido ante evento reciente explícito.

## Pruebas y evidencia

| Comprobación | Resultado | Límite |
| --- | --- | --- |
| API typecheck y build | PASS | Compilación local |
| API unitarias | PASS: 84/84 | Fixtures/sintéticas; login y cookies existentes |
| Integración PostGIS descartable | PASS | 24 aserciones de diagnóstico, Wave 3 RBAC/tenant/preview/idempotencia/write gate, login reciente y logout, upgrade/recuperación y 64 aserciones GPS mixtas; ninguna conexión MDM real |
| Corporate/Personal assemble + lint | PASS | Compilación y análisis estático; no equivalen a prueba UI ejecutada |
| Agente Kotlin `syntheticTest` | PASS: 62 casos | Incluye clasificación GPS conservadora; JDK 21 disponible usado solo para la ejecución; `jvmToolchain(17)` restaurado en el repositorio; no prueba física |
| APK package/version/firma | PASS estático | `com.geops.corporate` y `com.geops.personal`, versionCode 4, versionName `1.0.3-spec05-wave4`, signer debug SHA-256 `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8` |
| Separación de flavor | PASS estático | Manifiesto Corporate declara `DiagnosticActivity`; Personal no la declara ni contiene `AdminApiClient`/`DiagnosticActivity` en DEX |
| Capturas reales y tests instrumentados | NOT_RUN | Sin emulador configurado ni equipo conectado en este entorno |
| APK instalada en Moto G06 | BLOCKED | Sin evidencia del paquete y firmante instalados |

La compilación confirma las rutas y el manifiesto, pero no acredita accesibilidad, interacción, respuesta de red móvil, funcionamiento de `CreateDocument`, continuidad GPS física ni experiencia en el Moto G06. No se incluyen maquetas como capturas reales.

## Estados independientes de cierre

| Estado | Resultado | Evidencia / pendiente |
| --- | --- | --- |
| WAVE1_TECHNICAL_PASS | PASS | Aprobación previa del usuario |
| WAVE2_TECHNICAL_PASS | PASS | Aprobación previa del usuario |
| WAVE3_TECHNICAL_PARTIAL | PARTIAL | Aprobación parcial expresa; tenant real pendiente |
| MDM_PROVIDER_MANAGEENGINE_CONFIRMED | PASS | DEC-MDM-001 |
| MDM_CONFIGURATION_COMPARISON_LAB_PASS | PASS | Wave 3 sintética |
| MDM_REMEDIATION_CONTRACTS_LAB_PASS | PASS | Wave 3 sintética |
| APK_ADMIN_AUTHENTICATION_PASS | PARTIAL | Backend login/logout/reautenticación en fixture; APK compila, sin runtime |
| APK_ADMIN_RBAC_PASS | PARTIAL | API/tenant sintéticos PASS; pantalla no ejecutada |
| APK_SESSION_ISOLATION_PASS | PARTIAL | Código separado de PoP/AgentRuntime; no prueba física |
| GPS_CONTINUITY_AFTER_LOGOUT_PASS | NOT_RUN | Logout no llama al runtime; observación real pendiente |
| APK_CONFIGURATION_UI_PASS | PARTIAL | Nueve secciones compiladas, sin captura ejecutada |
| APK_PERMISSION_UI_PASS | PARTIAL | Modelo local/matriz de estados, sin prueba en dispositivo |
| APK_GPS_DIAGNOSTICS_UI_PASS | PARTIAL | Señales GPS v2 compiladas, sin observación física |
| APK_MDM_UI_PASS | PARTIAL | Contratos integrados, tenant real no identificado |
| APK_REMEDIATION_UI_PASS | PARTIAL | Preview/solicitud/historial sintéticos; UI no ejecutada |
| APK_MDM_WRITE_GATE_PASS | PASS | API `submit` devuelve 503 `mdm_write_disabled`; sin transporte operativo |
| APK_REPORT_EXPORT_PASS | PARTIAL | `CreateDocument` y sanitización compilados; export real no ejecutado |
| CORPORATE_BUILD_PASS | PASS | Assemble/lint y firma debug válidos |
| BYOD_REGRESSION_PASS | PARTIAL | Personal assemble/lint PASS y sin Activity/código admin; uso físico pendiente |
| MANAGEENGINE_TENANT_IDENTIFIED | BLOCKED | Edición, licencia, versión, OAuth/scopes sin evidencia |
| MANAGEENGINE_REAL_READ_VALIDATION | BLOCKED | Tenant no conectado |
| MANAGEENGINE_REAL_WRITE_VALIDATION | NOT_RUN | Prohibida; gate cerrado |
| APK_INSTALLED_COMPATIBILITY | BLOCKED | Referencia estática compatible; instalada desconocida |
| PHYSICAL_DEVICE_VALIDATION | NOT_RUN | Moto G06 no inspeccionado |
| GPS_BACKGROUND_ROOT_CAUSE | BLOCKED | No confirmada |
| GPS_24H_VALIDATION | NOT_RUN | Sin ensayo físico |
| PRODUCTION_READY | BLOCKED | NO: tenant, firma release, backend y validación física pendientes |

## Candidatas y próxima revisión

- [Corporate debug](../../apps/android-app/build/outputs/apk/corporate/debug/GeopsAndroid-corporate-debug.apk): paquete `com.geops.corporate`, versionCode 4; APK SHA-256 `426F31CD209A8B0E725FFF24A619FCB8EE32EC7D5794EC12F4B1A8602D36C200`.
- [Personal debug](../../apps/android-app/build/outputs/apk/personal/debug/GeopsAndroid-personal-debug.apk): paquete `com.geops.personal`, versionCode 4; APK SHA-256 `C70CE1F7AD82EF33C9E659AD6F43A610C4A9252180D5CB0125E2C6248821DC52`.
- [Actualización individual y validación Moto G06](WAVE4-MOTO-G06-UPDATE.md). No instalar ni distribuir automáticamente; comparar la APK **instalada**, no solo la referencia. Conservar Managed Configurations, identidad técnica, enrolamiento, datos y cola GPS.

Wave 1-R1 sigue abierta. Se solicita revisión de Wave 4 con los límites expuestos; no iniciar Wave 5.
