# GPS-HEALTH-001 — contrato y backend sintético (2026-10-19)

## Decisión

Se acepta el delta GPS-HEALTH-001 **para implementación sintética en `codex/spec-02-wave-1`**. La decisión registra una entidad de salud separada del heartbeat y de posiciones, con ACK propio. No aprueba seguridad independiente, privacidad, despliegue, teléfonos reales ni una modificación del baseline de identidad SPEC-01. [Propuesta actualizada](gps-health-change-proposal.md), [OpenAPI de diseño](openapi.design.yaml) y [API](api-contracts.md) documentan el cambio SDD; los requisitos originales siguen vigentes.

## Contratos implementados

| Superficie | Decisión / evidencia | Pendiente |
| --- | --- | --- |
| Identidad | Bearer corto y PoP de SPEC-01 en cada POST; `device_id` del cuerpo se compara con el principal autenticado. Tenant y vínculo MDM activo se resuelven en servidor y deben coincidir con los fijados en el ancla. Instalación activa requerida. Revocación de clave/dispositivo rechaza el envío. | Activación que cree `gps_device_installation`, configuración PoP real y rotación/restauración. |
| Evento | UUID estable, `schema_version:1`, UTC, `due_at`/`observed_at`, ancla y boot, versión de asignación/política, batería 0–100 o null, carga, enchufe, ahorro, GPS/red, RUNNING/STOPPED y etiquetas derivadas coherentes. Sin coordenadas. | Paridad ejecutada del nuevo payload Kotlin y matriz física OEM. |
| Ingesta | `POST /v1/device/health/batches`: 1–100 eventos, 128 KiB, 6 solicitudes/minuto/dispositivo, 200 con ACK solo tras COMMIT; 409 para ID/digest distinto o nonce replay; 413/422/429; duplicado con nueva prueba PoP. `202` no aplica a salud. | Cuota global compartida con otras rutas GPS, carga sostenida y red real. |
| Consulta | `GET /v1/admin/devices/{id}/health`: `gps.session.read`, concesión explícita de tenant, motivo obligatorio, último evento, historial limitado con cursor, auditoría de lectura. `NO_COMMUNICATION` es inferencia durante sesión programada; batería baja más silencio solo sugiere agotamiento posible. | Alta/baja supervisada de concesiones y UI W1-D. |
| Retención | 90 días desde observación, recibos 90 días desde persistencia; purga por lotes y cuotas antiguas, auditada. | Scheduler, backups/restore y plazo definitivo de privacidad. |

## Persistencia e integración

La [migración 0010](../../apps/api/src/db/migrations/0010_gps_health.sql) añade `gps_device_health_event`, `gps_health_batch_receipt`, `gps_health_request_quota`, `gps_health_tenant_access`, `gps_policy_revision.health_interval_s` y los campos `health_boot_id`, `health_mdm_binding_id` y `health_tenant_id` al ancla. FK compuesta mantiene tenant/dispositivo/vínculo; los índices sirven lectura por tenant y purga. Se aplicaron las 10 migraciones existentes en un PostGIS local desechable `geops_verify_*`; no se usó base compartida. El [servicio](../../apps/api/src/gps-health-service.ts) y las [rutas](../../apps/api/src/gps-health-routes.ts) se cablean en `app.ts`/`main.ts` solo con servicios de identidad/admin activos. El núcleo Kotlin emite los cuatro campos de ancla requeridos; su transporte de salud permanece deshabilitado por defecto y no se modificó la APK experimental.

## Pruebas ejecutadas

| Prueba | Resultado |
| --- | --- |
| OpenAPI 3.1, copia empaquetada y delta de salud | PASS (`npm run contracts:check`). |
| TypeScript API | PASS (`npm run typecheck --workspace @geops/api`). |
| Salud HTTP + PoP + PostgreSQL | PASS, 37 aserciones (`npm run gps:health:integration --workspace @geops/api` en `geops_verify_*`). Incluye concurrencia, duplicados, atomicidad 422, aislamiento y transferencia de tenant, revocaciones, cuota, 413, cursor, auditoría, inferencia y retención. |
| Regresión W1-B | PASS, 44 aserciones en la misma base desechable. |
| Vectores W1-A | PASS, 15/15. |
| API Node existente y MDM OAuth sintético | PASS, 12/12 y 18/18. |
| Contratos PoP SPEC-01 | PASS, 4/4; target de migraciones PASS, 2/2. |
| Compilación/prueba Kotlin nueva | **PENDIENTE**: este entorno no tiene Gradle ni compilador Kotlin disponible. El informe W1-C registró 14 pruebas anteriores, pero no cubre estos cuatro campos nuevos. |
| Build API | **NO VERIFICADO**: `dist` heredado devolvió EPERM al escribir. Typecheck y ejecución TypeScript directa pasaron; el empaquetado de producción queda pendiente. |

## Gates y readiness

W1-D puede diseñar la vista de salud con fixtures y este contrato; **no está lista para integración operativa**. Antes de W1-D/E1 hacen falta activación/instalación y `GET /v1/device/config` real con ancla y `health_interval_s`, flujo de concesión tenant, compilación/paridad Kotlin, scheduler de retención, backup/restore, privacidad y revisión de seguridad independiente. W1-C sigue parcial; E1/E2 siguen bloqueadas. No se declara PASS físico ni aprobación de seguridad. No se desplegó, migró una base compartida, activó GPS real ni se hizo commit/push/merge.

## Estado Git

Rama `codex/spec-02-wave-1`; HEAD de partida `d72cdb49d95915f8772ffcb6818698e4439c1a57`. Se preservaron cambios heredados de SPEC-00, ADR-014, W1-B y W1-C, incluidos archivos sin seguimiento. Este informe no reclasifica esos cambios como propios ni los descarta.
