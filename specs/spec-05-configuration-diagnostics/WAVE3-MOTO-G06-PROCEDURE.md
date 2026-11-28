# SPEC-05 — Identificación y actualización controlada del Moto G06

Este procedimiento es para operador autorizado en laboratorio. No se ejecutó contra el tenant ni el teléfono. No modificar perfiles, distribuir APK, desinstalar, borrar datos ni reenrolar durante la identificación.

## Identificar el tenant y el equipo

1. Registrar desde consola ManageEngine producto exacto, Cloud/On-Premises, edición, licencia, versión, región/URL base, cliente MSP, modo de administración Android Enterprise y scopes OAuth concedidos. Conservar capturas sanitizadas; no copiar tokens ni claves al informe.
2. Con sesión administrativa de GEOPS y permisos de solo lectura, consultar `GET /v1/admin/mdm/status` y `GET /v1/admin/mdm/devices?limit=50`; después `GET /v1/admin/mdm/inventory`. Si el servicio no está conectado, detener la identificación API y usar consulta de consola sin fingir `PASS`.
3. Buscar Moto G06 por nombre/modelo **solo para reducir candidatos**. Confirmar ID MDM numérico, serial o UDID contra la ficha del equipo y evidencia física del operador. Confirmar empresa/cliente, agente asignado, estado managed, última comunicación y modo. El `fake-f2c5…` previamente aportado no es objetivo válido.
4. Conservar por separado el ID GEOPS `f2c5d59b-a27b-4be8-9f75-ba2b79decf0d`, binding `37d592cf-6726-4054-b1d4-c2fd7de56cbe` y el ID MDM real que se confirme. La asociación GEOPS↔MDM es administrativa y auditada; no ejecutarla solo por nombre/modelo. Una asociación de inventario no autentica a la APK ni autoriza captura GPS.
5. Tras vínculo verificado, consultar `GET /v1/admin/mdm/devices/{geops_device_id}/configuration`. Registrar cada sección como `AVAILABLE`, `SCOPE_DENIED` o `UNAVAILABLE`; anotar perfil `ASSIGNED`, `PENDING` o `APPLIED_REPORTED` y comparar con reporte Android efectivo. Un estado MDM aplicado no demuestra que Android concedió cada permiso.

## Comprobar la APK instalada antes de actualizar

1. Desde ManageEngine, leer lista de apps del equipo para `com.geops.corporate`, versionCode/versionName y estado de instalación. Confirmar que backend Staging admite el contrato de snapshots Wave 2. Verificar conservación de las cinco claves administradas de inscripción sin publicar sus valores.
2. Si hay acceso ADB autorizado al equipo, leer `adb shell dumpsys package com.geops.corporate` y `adb shell pm path com.geops.corporate`. Para comprobar firma, extraer la APK instalada a un destino de laboratorio y usar `apksigner verify --print-certs` y SHA-256; el versionName o el estado de consola no acreditan certificado. No ejecutar `pm clear`, `uninstall` ni instalación en esta etapa.
3. Comparar con la [candidata Wave 2](../../apps/android-app/build/outputs/apk/corporate/debug/GeopsAndroid-corporate-debug.apk): `com.geops.corporate`, versionCode 3, certificado SHA-256 `539cc2a13063cc67a58749d96179e5b928dd1daef7e70bc21f4089f0a3374be8`, APK SHA-256 `9b601b2107b165ae989443fabf9072ce585e11bf51939a88468679ef4d714409`. La comparación estática anterior fue solo contra el archivo de referencia `GeopsCorporate-moto-g06-staging-debug.apk`, no contra el instalado.
4. Si paquete, firma, versionCode, identidad/cola local, claves administradas o backend no pueden comprobarse, registrar `APK_INSTALLED_COMPATIBILITY=BLOCKED` y no distribuir. La variante debug no es release. Si todo coincide, presentar cambio individual al operador para autorización separada, siguiendo [Wave 1-R1](WAVE1-R1-LAB-PROTOCOL.md). No usar grupos ni `update_all`.

La validación GPS física sigue el [protocolo de diez escenarios](WAVE1-R1-LAB-PROTOCOL.md). Registrar horarios UTC, captura, transmisión, ACK, permiso efectivo, batería, servicio y perfil aplicado; no atribuir la causa raíz del primer plano hasta comparar esas evidencias. No declarar 24 horas ni `PRODUCTION_READY` a partir de API o mocks.
