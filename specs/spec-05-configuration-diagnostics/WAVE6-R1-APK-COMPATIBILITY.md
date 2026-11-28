# W6-R1 — Compatibilidad de APK instalada, sin instalación

La candidata Corporate Wave 4 se volvió a inspeccionar con `aapt`, `apksigner` y SHA-256. El archivo histórico de referencia se inspeccionó por separado. **No se observó el Moto G06 ni se leyó su APK instalada**: no hay ADB disponible en esta estación, inventario ManageEngine real ni acceso físico. Ninguna propiedad de la referencia se atribuye al dispositivo.

| Artefacto | Paquete | versionCode / versionName | Certificado SHA-256 | APK SHA-256 |
| --- | --- | --- | --- | --- |
| [Candidata Wave 4](../../apps/android-app/build/outputs/apk/corporate/debug/GeopsAndroid-corporate-debug.apk) | `com.geops.corporate` | `4` / `1.0.3-spec05-wave4` | `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8` | `426f31cd209a8b0e725fff24a619fcb8ee32ec7d5794ec12f4b1a8602d36c200` |
| APK histórica de referencia en worktree `5818` | `com.geops.corporate` | `1` / `1.0.0-spec04-test` | mismo certificado debug | `ba723c59ed9d3f10c8858c0c7376c724c22cd8b48628cd3175dee252f26ffec9` |
| APK realmente instalada | **UNKNOWN** | **UNKNOWN** | **UNKNOWN** | **UNKNOWN** |

La comparación entre **dos archivos** indica compatibilidad estática de paquete/firma y versión creciente 1→4 **si** la APK instalada fuese exactamente la referencia. La existencia de ese archivo no prueba distribución, instalación ni estado actual. La candidata es `debug` y solo corresponde a laboratorio. El backend staging observado no expone el endpoint diagnóstico SPEC-05; incluso con firma/versionCode compatibles, la actualización del Moto G06 no está lista.

## Gate de instalación individual

1. Verificar registro ManageEngine y teléfono real mediante un identificador confiable distinto del modelo o `fake-*`. Obtener package y versión instalada del inventario y del Android. No habilitar depuración USB remotamente.
2. Obtener SHA-256 del **certificado instalado**. Si la consola no lo presenta, usar una sesión ADB física y autorizada, consultar `adb shell pm path com.geops.corporate`, extraer el `base.apk` a una carpeta protegida y ejecutar `apksigner verify --print-certs base.apk`. Documentar la cadena de custodia; un nombre de APK o la versión en MDM no demuestran firma. ADB es herramienta de laboratorio, no requisito operativo de la flota.
3. Requerir paquete `com.geops.corporate`, certificado exactamente igual al de la candidata y versionCode instalado menor que 4. Si falla cualquier comparación, `BLOCKED`; no desinstalar, borrar datos ni intentar downgrade. Confirmar además backend/API 0042 compatible y Managed Configurations sin pérdida.
4. Antes de actualizar, registrar bajo custodia ID GEOPS, `installation_id`, vínculo MDM real, enrolamiento, configuración, permisos, última captura y ACK, cola GPS y reporte técnico sanitizado. La compatibilidad estática **no** prueba conservación de identidad, datos o cola: esos puntos requieren verificación posterior física.
5. Solicitar autorización explícita para una sola instalación de laboratorio después de los gates de staging y dispositivo. No distribuir masivamente ni cambiar perfil. Si la consola ManageEngine rechaza la firma debug, detener y proponer artefacto firmado compatible con evidencia, sin sustituir silenciosamente el certificado.

**Estados:** `APK_INSTALLED_VERSION_VERIFIED=BLOCKED`, `APK_INSTALLED_SIGNATURE_VERIFIED=BLOCKED`, `APK_UPDATE_COMPATIBILITY=BLOCKED`, `APK_CONTROLLED_UPDATE_READY=BLOCKED`. La [secuencia Moto G06 previa](WAVE4-MOTO-G06-UPDATE.md) se mantiene, condicionada a la evidencia real nueva.
