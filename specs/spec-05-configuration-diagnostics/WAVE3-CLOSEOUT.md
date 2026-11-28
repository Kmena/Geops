# SPEC-05 — Informe de Wave 3

Fecha: 2026-11-27. Rama aislada `codex/mdm-diagnostics-wave0`. Wave 2 aprobada técnicamente por el usuario. El usuario aprobó este cierre **solo parcialmente** y autorizó Wave 4; el estado es `WAVE3_TECHNICAL_PARTIAL`, `MDM_CONFIGURATION_COMPARISON_LAB_PASS` y `MDM_REMEDIATION_CONTRACTS_LAB_PASS`. Tenant, lectura/escritura real de permisos y validación física siguen bloqueados o no ejecutados. El texto de pruebas siguiente describe la entrega original de Wave 3; consultar [Wave 4](WAVE4-CLOSEOUT.md) para el estado posterior.

## Entrega técnica

- Adaptador ManageEngine existente ampliado con lecturas documentadas de perfiles y apps por equipo, resumen de último contacto y detalle de perfil. Valida IDs numéricos exactos, cliente autorizado, origen HTTPS, forma y tamaño de respuesta; 401 renueva una vez, 403/429/5xx se sanitizan. La lectura por secciones conserva fallos parciales. No se llama al proveedor con `fake-*`.
- `MdmPolicyService` une dispositivo GEOPS, vínculo explícito de inventario, agente/tenant, diagnóstico Android Wave 2 y evidencia MDM. Reutiliza RBAC/grants de diagnóstico; una asignación o distribución MDM no se convierte en permiso efectivo. La configuración deseada conocida es ownership/autorización GPS; perfil y versión GEOPS deseados siguen sin baseline aprobado.
- Endpoints administrativos de [consulta, capacidades, vista previa, solicitud e historial](WAVE3-API-CONTRACT.md). La vista previa de asociación de perfil exige perfil Android publicado y versión. Solicitudes locales idempotentes quedan `AWAITING_APPROVAL` con evento inmutable y auditoría. El transporte POST de asociación individual tiene gate exacto y tests sintéticos, pero no está conectado al endpoint operativo: `submit` devuelve `mdm_write_disabled`; no existe modificación real ni supuesto `EFFECTIVE_VERIFIED`.
- Migración aditiva `0042_mdm_policy_workflow.sql` añade cuatro capacidades administrativas sin autoconcesión, tabla de solicitudes, índices y eventos inmutables. Recuperación de mantenimiento y upgrades sintéticos actualizados a 0042.
- [Matriz de capacidades](MANAGEENGINE-CAPABILITY-MATRIX.md), [procedimiento Moto G06](WAVE3-MOTO-G06-PROCEDURE.md) y SDD actualizados.

## Estados independientes

| Estado | Resultado | Evidencia o bloqueo |
| --- | --- | --- |
| WAVE2_TECHNICAL_PASS | PASS | Aprobación expresa del usuario; [cierre Wave 2](WAVE2-CLOSEOUT.md) |
| MANAGEENGINE_TENANT_IDENTIFIED | BLOCKED | Sin grant del tenant actual; producto/edición/licencia/versión/scopes no confirmados |
| MANAGEENGINE_CAPABILITY_MATRIX_READY | PARTIAL | Matriz oficial y código; ninguna capacidad verificada en tenant actual |
| MANAGEENGINE_AUTHENTICATION_PASS | BLOCKED | OAuth sintético PASS; autenticación actual no ejecutada |
| MANAGEENGINE_DEVICE_READ_PASS | PARTIAL | Adaptador y fixtures PASS; equipo real no consultado |
| MANAGEENGINE_POLICY_READ_PASS | PARTIAL | Perfiles/apps/detalle sintéticos PASS; API/licencia reales pendientes |
| MANAGEENGINE_PERMISSION_READ_PASS | BLOCKED | API por app/permiso no acreditada; Android es fuente efectiva |
| MANAGEENGINE_PERMISSION_WRITE_LAB_PASS | NOT_RUN | Tenant/permisos/endpoint aún sin verificar; gate cerrado |
| MANAGEENGINE_PERMISSION_WRITE_REAL_PASS | NOT_RUN | Ninguna escritura ejecutada |
| MDM_CONFIGURATION_COMPARISON_PASS | PARTIAL | Motor puro y proyección sintética; sin política aplicada real ni baseline de perfil |
| MDM_REMEDIATION_WORKFLOW_PASS | PARTIAL | Preview, request, idempotencia, historial, rechazo de envío; sin submit/seguimiento real |
| MDM_AUDIT_PASS | PARTIAL | Eventos inmutables y audit_event comprobados en DB descartable; sin evento real |
| RBAC_SECURITY_PASS | PARTIAL | 403 sin capacidad y aislamiento sintético; sin tenant real |
| MULTITENANT_ISOLATION_PASS | PARTIAL | Dos tenants sintéticos; se requiere comprobar correlación organización↔cliente MSP real |
| GPS_V2_REGRESSION_PASS | PASS | 64 aserciones DB sintética y 61 casos Kotlin; no físico |
| BYOD_REGRESSION_PASS | PARTIAL | Personal build/lint y suite compartida PASS; no ensayo físico |
| REAL_DEVICE_IDENTIFICATION | BLOCKED | Solo ID `fake-*`; ID MDM real no aportado |
| APK_INSTALLED_COMPATIBILITY | BLOCKED | Referencia estática compatible, APK instalada no verificada |
| PHYSICAL_DEVICE_VALIDATION | NOT_RUN | Moto G06 no conectado/inspeccionado |
| GPS_BACKGROUND_ROOT_CAUSE | BLOCKED | Continúa sin confirmarse |
| GPS_24H_VALIDATION | NOT_RUN | Sin ensayo físico |
| PRODUCTION_READY | BLOCKED | **NO**: tenant real, permisos, firma release, backend y prueba física pendientes |

## Pruebas

- `npm test --workspace @geops/api`: **84 pruebas PASS** (20 + 55 + 2 + 7), incluidas siete nuevas de Wave 3. Cubren perfiles/apps, fallo parcial, identidad exacta, token expirado y gate de escritura simulada.
- `scripts/run-spec05-wave3-integration.ps1` en PostGIS descartable: ingestión Wave 2 (24 aserciones), RBAC/tenant/preview/idempotencia/auditoría/write gate Wave 3, inventario e inscripción MDM, upgrade 0035→0042, recuperación y GPS mixto (64 aserciones) PASS. Ninguna petición a ManageEngine real.
- `npm run typecheck --workspace @geops/api`, build API y `npm run lint` PASS; lint conserva 12 advertencias anteriores de módulos GPS, sin nuevos errores.
- Android `syntheticTest` PASS (61 casos). `assembleCorporateDebug assemblePersonalDebug lintCorporateDebug lintPersonalDebug` PASS en contenedor local; variantes Android sin cambios de Wave 3. No se instaló el APK.

## Puertas pendientes

La [candidata Corporate Wave 2](../../apps/android-app/build/outputs/apk/corporate/debug/GeopsAndroid-corporate-debug.apk) continúa en versionCode 3 y firma **debug**; la compatibilidad aprobada fue únicamente estática contra un archivo de referencia. El [procedimiento](WAVE3-MOTO-G06-PROCEDURE.md) exige identificar tenant y Moto G06, comprobar la APK instalada, conservar enrollment/cola e inspeccionar cinco claves antes de una actualización individual autorizada.

El transporte de asociación individual existe, pero **no se conecta al flujo operativo**, y no se implementan aún verificación de aplicación ni concesión API de permisos Android, porque el producto/edición/licencia/scopes/endpoint y modo del tenant actual carecen de evidencia. El flujo local no constituye `MANAGEENGINE_PERMISSION_WRITE_LAB_PASS`. La edición Cloud es orientación del adaptador, no un hecho verificado del tenant. Solicitar revisión de este cierre y datos de solo lectura del laboratorio antes de ampliar el gate. Wave 4 no iniciada.
