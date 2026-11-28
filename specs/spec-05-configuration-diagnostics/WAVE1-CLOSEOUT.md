# SPEC-05 — Informe de Wave 1

Fecha: 2026-11-27. Rama: codex/mdm-diagnostics-wave0. Autoridad MDM: ManageEngine (DEC-MDM-001; edición del tenant por verificar). La pantalla de Wave 1 era local y de solo lectura; no modificaba políticas ni transmitía diagnósticos al backend. Wave 2 comenzó tras revisión.

## Entrega técnica

- [LocalDiagnosticModel](../../apps/android-agent/src/main/kotlin/com/geops/agent/LocalDiagnosticModel.kt): estados de permiso, servicio y transmisión con reglas conservadoras; una ausencia de datos no prueba que el GPS esté detenido.
- [LocalDiagnostics](../../apps/android-app/src/main/kotlin/com/geops/mobile/LocalDiagnostics.kt): lee permisos declarados y efectivos, ubicación precisa/aproximada, servicios globales/proveedor, tipo FGS, batería, restricción background, ahorro de datos, red, alarma y Managed Configurations sin abrir secretos.
- [AgentRuntime](../../apps/android-app/src/main/kotlin/com/geops/mobile/AgentRuntime.kt): proyección sanitizada de diario cifrado/cola GPS v2, último callback, captura, ACK, cinco errores recientes, configuración y recuperación. No altera el motor de captura.
- [DiagnosticActivity](../../apps/android-app/src/main/kotlin/com/geops/mobile/DiagnosticActivity.kt): entrada corporativa después de la activación existente, secciones legibles, actualizar y exportar mediante selector de documentos Android. El reporte indica fuente/hora y omite coordenadas, IDs GEOPS/MDM, claves y tokens.
- [Gradle](../../apps/android-app/build.gradle.kts): versión candidata 2 / 1.0.1-spec05-wave1 para permitir actualización de laboratorio cuando coincida el certificado de firma.

La APK actual no implementa login de empleado/administrador; la activación de instalación es la única barrera local existente. DEC-MDM-003 mantiene el login y las acciones de corrección/configuración mediante backend como requisito de Wave 4, después de que Wave 2 provea telemetría y Wave 3 lectura/escritura ManageEngine comprobada. El indicador “ManageEngine UNKNOWN” es intencional hasta entonces.

## Verificaciones

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| Clasificación de permisos/servicio/transmisión | PASS sintético | gradle syntheticTest con Java 17; 61 casos PASS, incluidos dos nuevos |
| Build Corporate Debug | PASS | assembleCorporateDebug; BUILD SUCCESSFUL |
| Build Personal Debug y regresión | PASS de compilación | assemblePersonalDebug; BUILD SUCCESSFUL y suite compartida del agente; sin prueba física |
| Firma, paquete y versión de APK | PASS | apksigner v2 válido; aapt: Corporate/Personal versionCode 2, versionName 1.0.1-spec05-wave1, minSdk 26; cert SHA-256 539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8 |
| Manifest fusionado por flavor | PASS | Ambos declaran background location, FGS location y notificaciones; cámara solo Personal |
| Android lint de ambas variantes | PASS con advertencias | lintCorporateDebug y lintPersonalDebug; BUILD SUCCESSFUL; Corporate: 0 errores, 43 advertencias, 2 sugerencias; Personal: 0 errores, 44 advertencias, 2 sugerencias |
| Captura de pantalla de la Activity ejecutada | NOT_RUN | No hay emulador con imagen de sistema ni Moto G06 conectado en este entorno |
| Prueba física Moto G06 | NOT_RUN | Se requiere ensayo supervisado |
| Lectura/acción ManageEngine real | NOT_RUN | Fuera de Wave 1; gate Wave 3 |

No se declara PASS físico ni continuidad 24 h a partir de compilación o pruebas sintéticas.

La [maqueta de referencia](wave1-screen-preview.svg) permite revisar la jerarquía de la pantalla. Está rotulada como simulación y **no** sustituye una captura de la Activity ejecutada en Android.

## APK candidata e instalación controlada con ManageEngine

Los artefactos históricos de Wave 1 tenían estos datos: Corporate, 4,301,956 bytes, SHA-256 060a0586093a1236190608b32b6bb300d42a944cfe80f05d61daad305862e3c9; Personal, SHA-256 5245602d59b4a85cbfe0c2f64d03c2c3d132c486df9cc5996649c8fff22b46e5. Las rutas de `build/outputs/apk` fueron sobrescritas por la compilación de Wave 2 y ya no representan esos hashes. Usar la [candidata y hashes de Wave 2](WAVE2-CLOSEOUT.md) para el laboratorio actual. Copiar a un paquete de laboratorio solo después de verificar SHA-256, applicationId, versionCode, certificado y entorno Staging. La clave debug de laboratorio es la misma de SPEC-04 (certificado confirmado); permanece ignorada por Git. Nunca usar un artefacto debug en producción.

Procedimiento de operador, sin ejecución automática:

1. En GEOPS, confirmar vínculo ManageEngine, autorización individual, política GPS vigente, cola pendiente y versión instalada del Moto G06. Registrar hash y certificado del APK anterior. No limpiar datos si hay posiciones pendientes.
2. Comparar paquete, certificado y versionCode. Si el paquete/certificado no coinciden, **no** ejecutar actualización in situ; planificar alta nueva supervisada y conservación de evidencia. El paquete legado com.geops.mobile tampoco es actualizable por com.geops.corporate.
3. En el tenant de laboratorio/autorizado de ManageEngine, abrir App Repository → Android Enterprise App, cargar el APK corporativo candidato y asignarlo **solo** al Moto G06 de prueba. Seguir la [guía oficial de administración de aplicaciones Android MSP](https://www.manageengine.com/mobile-device-management-msp/help/app_management/android_app_management.html). No cambiar perfiles de producción como parte de este procedimiento.
4. Conservar las cinco Managed Configurations de inscripción vinculadas al equipo; no copiarlas en reportes. Comprobar en consola permisos de ubicación precisa, background y notificaciones, y confirmar su estado efectivo en la nueva pantalla Android.
5. Registrar estado de instalación MDM, versión/firma instalada y primer reporte local exportado. Si no hay lanzamiento MDM compatible, abrir la APK manualmente una vez según la [guía existente](../../docs/operations/mdm-corporate-physical-test.md). No interpretar “instalada” como “capturando”.

## Validación física prioritaria: Motorola Moto G06

Usar equipo y autorización de laboratorio, hora UTC, hash/versionCode/certificado de APK, versión Android, versión ManageEngine, modo administrado y perfil aplicado. Exportar el reporte técnico antes de cada bloque, sin coordenadas ni secretos. Comparar con GPS v2 y salud backend usando device/installation ID solo en sistema autorizado.

| Paso | Duración/acción | Evidencia para distinguir la causa |
| --- | --- | --- |
| Línea base | App visible 10 min | Permisos FINE/COARSE/BACKGROUND, ubicación global/proveedor, FGS, callback, captura, ACK y cola |
| Interfaz minimizada | 60 min | Si FGS sigue observado y hay callbacks; separar callback de captura y ACK |
| Pantalla apagada | 30 min dentro del bloque | Ahorro, restricción background, huecos y reanudación |
| Retirar de recientes | Ensayo separado | Evento FGS_DESTROYED/reinicio; no confundir con force-stop |
| Reiniciar | Esperar recuperación permitida | BOOT/WINDOW_WAKE, permisos y política offline, primera captura |
| Sin red y recuperación | Intervalo controlado | Capturas/cola local vs ACK posterior, sin duplicación |
| Restricción MDM/batería | Solo si el operador tiene autorización específica | Comparar perfil aplicado con permiso efectivo; no cambiar política operativa |
| 24 h corporativas | Tras pasar bloques cortos y obtener autorización | Huecos medidos, consumo de batería y continuidad; no garantizar 60 s exactos |

Si el servicio está activo pero sin callbacks, investigar proveedor/Android/OEM. Si hay callbacks sin capturas, investigar filtros/política GPS v2. Si hay capturas sin ACK, investigar conectividad, autenticación y cola. Un dispositivo offline sin evidencia reciente de proceso queda UNKNOWN, no “servicio detenido”. No cambiar el motor GPS antes de observar la ruta de falla.

## Limitaciones y gate de cierre

La pantalla Wave 1 no obtiene perfil aplicado ni permisos concedidos por ManageEngine mediante API. No puede distinguir todas las restricciones OEM. El estado FGS solo se afirma RUNNING_OBSERVED cuando el proceso actual informa listener registrado; un evento de parada antiguo caduca a UNKNOWN. Android/Doze pueden posponer ejecución y red.

**Cierre técnico:** diagnóstico local, pantalla mínima, builds, pruebas sintéticas y lint completados. Captura real y validación física NOT_RUN; login y acciones administrativas APK siguen pendientes según DEC-MDM-003. Detenerse antes de Wave 2.
