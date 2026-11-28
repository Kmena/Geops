# SPEC-05 — Wave 1-R1: actualización y validación del Moto G06

Estado: preparación documental. No hay lectura del Moto G06 ni distribución ejecutada. Se inspeccionó el artefacto de referencia `C:\Users\kmena\.codex\worktrees\5818\Geops\output\android-test\GeopsCorporate-moto-g06-staging-debug.apk`: `com.geops.corporate`, versionCode `1`, versionName `1.0.0-spec04-test`, certificado SHA-256 `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8`, firma v2 válida. La candidata Wave 2 tiene el mismo paquete/certificado y versionCode `3`, versionName `1.0.2-spec05-wave2`; las cinco claves Managed Configurations están declaradas en ambas. **Compatibilidad estática con ese archivo: PASS condicional. APK_UPDATE_COMPATIBILITY del Moto G06: BLOCKED** hasta confirmar que ese archivo o una APK equivalente está realmente instalada. **APK_RELEASE_SIGNATURE_VALIDATION: NOT_RUN**; solo hay firma debug. `com.geops.mobile` no es actualizable por `com.geops.corporate`. No desinstalar, borrar datos ni reenrolar.

Los identificadores aportados para el equipo incluyen un `mdm_device_id` con prefijo `fake-`. Ese valor corresponde al proveedor sintético usado en GEOPS y **no identifica por sí mismo un dispositivo ManageEngine real**. Antes de cualquier distribución, verificar el ID ManageEngine auténtico, el tenant y el vínculo activo con el registro GEOPS. No usar el ID `fake-` como target en la consola.

## 1. Inventario de solo lectura antes de decidir

En el Moto G06 autorizado, registrar identificador MDM en el sistema protegido, versión Android, modo Device Owner/Profile Owner, tenant, grupo y app asignada. Con ADB supervisado, consultar `adb shell pm list packages | findstr geops`, `adb shell dumpsys package com.geops.corporate` y `adb shell pm path com.geops.corporate`. Si la política permite extraer la APK instalada, copiar su `base.apk` a un directorio protegido y ejecutar `aapt dump badging` y `apksigner verify --verbose --print-certs` tanto en instalada como candidata. Registrar `applicationId`, `versionCode`, `versionName`, SHA-256 del certificado, esquema de firma y SHA-256 de ambos archivos. Si no puede extraerse, obtener certificado firmado del repositorio de aplicaciones o del equipo de firma; marcar `UNKNOWN` hasta cotejarlo.

Antes de actualización, registrar sin exportar secretos: `device_id`/`installation_id` en GEOPS, `key_id` y estado de activación, cinco Managed Configurations existentes, política GPS v2, última captura/ACK, cola de posiciones y errores. Confirmar que la versión backend de laboratorio implementa el contrato de diagnóstico v1; si responde 404, la APK nueva seguirá capturando GPS v2 pero la telemetría diagnóstica permanecerá en cola y no debe interpretarse como éxito Wave 2. Mantener el endpoint Staging previsto por la APK. Los datos de identidad y cola permanecen cifrados en el almacenamiento de la app solo si Android acepta una actualización in situ; comprobar su conservación después, sin asumirla por la firma.

Si el paquete o certificado difiere, **detener la actualización**. Solicitar al custodio la clave release ya aprobada y firmar la candidata con el procedimiento oficial existente y las cuatro variables `GEOPS_ANDROID_RELEASE_*`; nunca crear una identidad nueva para simular compatibilidad. Comparar de nuevo certificado y versionCode. Si no existe clave compatible, la distribución queda BLOCKED para este teléfono; elevar un plan de migración separado, sin desinstalación ni limpieza en R1.

## 2. Distribución individual mediante ManageEngine

Solo tras superar la puerta anterior, registrar hash y certificado de la candidata, respaldo/verificación de cola y aprobación del operador de laboratorio. En el tenant y cuenta correctos, abrir **Device Management → App Repository → Android Enterprise App** de `com.geops.corporate`; cargar la nueva versión en el canal/etiqueta de laboratorio que permita la edición real. Comparar la pantalla de distribución antes de confirmar: **exactamente el Moto G06**, cero grupos y cero dispositivos adicionales. Conservar las cinco configuraciones `geops_device_id`, `mdm_device_id`, `invitation_id`, `invitation_secret`, `expires_at` únicamente si siguen vigentes y asociadas a la misma instalación; no regenerar invitación por defecto. Verificar permisos de ubicación precisa, background y notificaciones en consola y luego en Android. No cambiar perfiles operativos ni activar despliegue automático. Guardar comprobante MDM de versión instalada y resultado por dispositivo. La [guía GEOPS existente](../../docs/operations/mdm-corporate-physical-test.md) detalla la ruta de consola; los controles concretos pueden diferir por edición, por lo que el operador debe registrar la pantalla observada. Si no existe lanzamiento automático compatible, abrir la APK manualmente una vez.

Después de instalar, comparar `applicationId`, versionCode 3, firma, `device_id`, `installation_id`, clave PoP funcional, estado GPS, política, Managed Configurations, cola y ACK. Si un dato cambia inesperadamente, detener el ensayo y conservar evidencia. No declarar conservación de identidad o cola solo por instalación MDM exitosa.

## 3. Matriz física de causa raíz

En cada escenario registrar hora UTC de inicio/fin, permisos FINE/COARSE/BACKGROUND/NOTIFICATIONS y precisión, batería/Doze/background, servicio FGS/listener, último callback, última **captura local**, tamaño de **almacén/cola**, último **ACK**, errores recientes, posiciones recibidas en servidor y distribución de intervalos reales. Exportar reporte sanitizado y correlacionar con las tablas GPS autorizadas. `UNKNOWN` no equivale a detenido.

| Escenario | Duración mínima | Evidencia decisiva |
| --- | --- | --- |
| App abierta | 10 min | Línea base de permisos, callback, captura, cola y ACK |
| App minimizada | 60 min | Continuidad de FGS y callbacks fuera de Activity |
| Retirada de recientes | Ensayo separado de 10 min | Evento de destrucción/recuperación; distinguir de force-stop |
| Pantalla apagada | 5 min | Primer efecto de bloqueo/Doze |
| Pantalla apagada | 30 min | Huecos y recuperación intermedia |
| Pantalla apagada | 60 min | Persistencia, política OEM y reanudación |
| Pérdida de Internet | 15 min controlados | Capturas almacenadas, cola creciente, ACK detenido |
| Recuperación de Internet | Hasta vaciar cola o límite acordado | Reintentos, deduplicación, ACK y orden de recepción |
| Reinicio | Hasta primera captura/ACK o fallo observado | Boot, permiso, FGS, recuperación de identidad/cola |
| Seguimiento autorizado | 24 h | Intervalos, huecos, batería, permisos y posiciones servidor |

Clasificación: sin permiso efectivo → Android/MDM; permiso y FGS detenido reciente → servicio; FGS y callbacks sin captura → política/filtros GPS v2; captura sin ACK → red/auth/cola; ACK sin posición servidor → correlación de contrato; sin telemetría fresca → offline/insuficiente, nunca fallo GPS confirmado. Comparar política aplicada ManageEngine solo cuando haya evidencia de consola o API verificada. No modificar motor GPS sin esa secuencia causal. Ningún escenario recibe PASS antes de ejecutarse y archivar evidencia física.
