# Auditoría — dependencia MDM en la ingestión GPS

**Fecha:** 2026-10-26. **Veredicto:** `CONDITIONAL`. **Alcance:** auditoría de HEAD y pruebas sintéticas locales; sin teléfono ni servidor remoto. Este informe registra resultados y no modifica el código, SPEC-02, el contrato GPS ni los otros documentos de SPEC-03.

## A. Estado del código

El checkout principal `codex/spec-02-wave-1` sigue en `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`, exactamente el HEAD auditado por SPEC-03. Está dos commits adelante de su remoto y tiene cambios preexistentes sin commit en contratos/documentos GPS y varios worktrees activos. `git diff 26efc9a..HEAD` es vacío y no hay modificación local de `apps/api/src/gps-event-service.ts`, `gps-event-routes.ts` ni `device-identity/session.ts`. SPEC-03 señaló correctamente la consulta de binding, pero su conclusión de que se requiere **ManageEngine real** sería demasiado amplia.

La rama de integración `codex/geops-spec02-mdm-integration` (`6d2453e`) incorpora v2/v3 mediante `205899c`, `da8a651`, `45ced09` y `5cad31b`. Es otro HEAD, no el checkout principal. En ella `GpsEventService.scope` conserva el gate de binding activo (`gps-event-service.ts:115-140`), y `ingestMixed` v2/v3 lo invoca (`:487-505`). El informe `waves-a-d-execution-2026-10-21.md:3,22-44` describe pruebas sintéticas y señala validación física pendiente. La versión `0.1.7-p0-test` de `.android-autostart-p0/docs/development/android-p0-autostart-2026-10-22.md:3-8,35-43` también registra pruebas locales, con validación POCO pendiente. Ninguna de esas ramas cambia el veredicto de HEAD.

## B. Dependencia exacta

1. **Identidad GEOPS:** `DeviceSessionService.verifyRequest` comprueba bearer, clave activa, dispositivo activo, firma PoP y nonce en `apps/api/src/device-identity/session.ts:145-205`; no consulta `mdm_binding`. Dispositivo registrado/autenticado no equivale a autorizado para ingestión GPS.
2. **Configuración GPS:** `GpsDeviceConfigService.snapshot` une instalación no retirada con `mdm_binding.state='ACTIVE'` y su `activation_binding_id/activation_tenant_id` (`apps/api/src/gps-device-config.ts:35-60`). Sin esa relación responde `403 gps_installation_inactive`; sin snapshot no hay ancla/ventana nueva para captura autorizada.
3. **Ingestión:** rutas v1 `POST /v1/device/gps-session-events/batches` y `POST /v1/device/locations/batches` autentican primero (`apps/api/src/gps-event-routes.ts:22-64`). `GpsEventService.ingest` llama `scope` antes de procesar eventos (`gps-event-service.ts:314-345`). `scope` requiere dispositivo activo, **exactamente un** binding activo y una instalación activa ligada a ese binding y tenant (`:105-135`). Sin binding: `403 binding_inactive`; con binding distinto al de la instalación: `403 installation_inactive`. Luego valida ancla, sesión, horario y tiempo (`:717-770`), inserta `position_event` (`:772-798`), recibo y ACK después del COMMIT (`:369-485`).
4. **Binding lógico frente a ManageEngine:** `scope` no comprueba `provider='manageengine'` ni llama al proveedor remoto. El flujo sintético de alta crea `mdm_binding(provider='fake',customer_id='synthetic',state='PENDING')` (`device-identity/repository.ts:66-97`), y la activación supervisada lo pasa a `ACTIVE` junto con dispositivo y clave (`device-identity/enrollment.ts:535-593`). El requisito técnico es una **fila activa de identidad/tenant e instalación coherente**, no una conexión en vivo con ManageEngine. Este flujo `fake` está limitado a entorno sintético; no demuestra un alta operativa real sin MDM.
5. **Base de datos:** `0003_device_identity.sql:1-23` define dispositivo y binding; `0009_gps_policies.sql:150-160,263-283` instalación y posiciones; `0012_gps_events.sql:39-66` añade FK tenant/binding/instalación y recibos; `0014_gps_installation_binding.sql:1-11` amarra activación a binding/tenant. La API no puede almacenar una posición canónica desligada de esos campos sin cambiar esquema y contrato de identidad.

**Clasificación:** `CONDITIONAL`. Sin **ManageEngine real**, un dispositivo con binding `fake` activo y demás autorizaciones puede sincronizar en el entorno sintético. Sin **ningún binding activo**, la ruta auditada bloquea GPS aun con sesión y PoP GEOPS válidos. No hay ruta alternativa de ingestión sin binding en HEAD. La capacidad productiva APK-first sin MDM real requiere un flujo de identidad/tenant aprobado; no se acredita con la existencia del modo sintético.

## C. Evidencia física reconstruida

`PASS`, `FAIL`, `PARTIAL` y `UNKNOWN` se refieren a la etapa indicada, no al sistema completo. «Sin MDM» para los teléfonos proviene del contexto comunicado por el operador; los informes no incluyen una consulta independiente del estado MDM/binding de cada instalación. `N/A` significa etapa ajena a la prueba.

| Prueba / fuente | Dispositivo | MDM | Captura | Persistencia local | Envío | ACK | PostgreSQL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PoC aislada, `docs/audit-regresion-gps-poco-2026-10-21.md:5-7,68` | POCO, otra app `com.geops.weekendpoc` | Sin MDM informado | PARTIAL: funcionó según operador, sin trazas archivadas suficientes aquí | UNKNOWN | UNKNOWN para backend GEOPS | UNKNOWN | UNKNOWN |
| Capturas del 20/10, `docs/audit-continuidad-gps-2026-10-20.md:23-34` | POCO, GEOPS | Sin MDM informado | PARTIAL: 36 capturadas en contador; hubo hueco e `INVALID_TIME` | PARTIAL: contador/estado local, sin inspección de IDs durables | PARTIAL: envío confirmado mostrado | PARTIAL: 36 ACK mostrados, sin recibos crudos | UNKNOWN: sin consulta correlacionada |
| Capturas 14:00–14:20 del 21/10, `docs/audit-regresion-gps-poco-2026-10-21.md:51-62,88-100` | POCO, GEOPS | Sin MDM informado | PARTIAL: 8 aceptadas, cadencia objetivo fallida | PARTIAL: contador visible | PARTIAL: inferido de ACK visible | PARTIAL: 8 ACK declarados, sin recibos crudos | UNKNOWN |
| GPS-PHYSICAL-01, `output/gps-physical-01-poco-cierre-historico-2026-10-21.md:17-60` | POCO Android 16, `0.1.6-test` | Sin MDM informado | PASS solo entrega Android de 102 ubicaciones; aceptación GEOPS UNKNOWN | UNKNOWN | PARTIAL: jobs programados, HTTP no demostrado | UNKNOWN | UNKNOWN |
| `0.1.7-p0-test`, `.android-autostart-p0/docs/development/android-p0-autostart-2026-10-22.md` | APK local; POCO pendiente | UNKNOWN | UNKNOWN físico; JVM PASS reportado | UNKNOWN físico | UNKNOWN físico | UNKNOWN físico | UNKNOWN físico |
| v1 sintética ejecutada aquí, `apps/api/test/gps-events.integration.mjs` | Dispositivo/clave sintéticos | Sin ManageEngine; binding `fake` activo | N/A | N/A | PASS por `app.inject` | PASS exacto y reenvío | PASS en PostGIS descartable |
| v2/v3 sintética documentada, `waves-a-d-execution-2026-10-21.md:22-44` de rama de integración | Dispositivo sintético | Binding preservado; MDM real no validado | JVM/sintética PASS/PARTIAL por wave | JVM PASS reportado | Integración sintética PASS reportada | PASS sintético reportado | PASS sintético reportado; no repetido aquí |

Los contadores Android de 102 entregas no se pueden sumar a los 36 o 8 ACK: pertenecen a ventanas y fuentes distintas. Un contador de ACK en pantalla permite inferir recepción según el código cliente, pero no identifica filas en la base ni prueba que el teléfono careciera de una fila `mdm_binding` sintética.

## D. Evidencia backend

La suite v1 (`apps/api/test/gps-events.integration.mjs:61-71,129-171,248-268`) crea explícitamente `mdm_binding(provider='fake',state='ACTIVE')`, instalación, clave y sesión. Comprueba `202` antes de `STARTED`, posterior `200`, IDs exactos, `persisted_at` idéntico tras retry, duplicado sin segunda fila y consultas a `position_event`. Es prueba de backend **sin ManageEngine remoto**, no de backend **sin binding** ni de teléfono real. `gps-mixed.integration.mjs:187-190,446-449` en la rama integrada incluye rechazo al revocar binding, pero esa suite no se ejecutó aquí.

No se encontró en los informes físicos una combinación verificable de identidad/instalación del POCO, recibo HTTP correlacionado y consulta `position_event` del mismo `event_id` que demuestre almacenamiento final sin ManageEngine. La ausencia de esa prueba no demuestra fallo físico.

## E. Reproducción local, 2026-10-26

Se inició `postgis/postgis:18-3.6` en contenedor nuevo `geops-mdm-audit-20261026`, sin volumen y publicado solo en `127.0.0.1`; base `geops_verify_20261026` con credenciales sintéticas. Se aplicaron 15 migraciones de HEAD **solo en ese contenedor descartable**. La suite v1 pasó **69 aserciones**: `gps-events integration PASS: 69 assertions`. Tras ella se observaron 3 filas `position_event`, 12 recibos de lote y 2 bindings `fake` en la DB de prueba (conteos posteriores a sus propias pruebas de purga/transferencia). No se consultó base persistente.

Prueba negativa dirigida: dentro de una transacción en esa DB se revocó el último binding activo del dispositivo de fixture y se invocó `GpsEventService.scope`; resultado `403 binding_inactive`. Se ejecutó `ROLLBACK`. Esta prueba aísla la condición de alcance; **no es** un POST HTTP completo sin binding. Una primera ejecución de la suite falló por restricción local `spawn EPERM` del sandbox antes de empezar; se repitió con permiso para usar el ejecutor local y pasó. El contenedor se detuvo con `docker stop` y `--rm` eliminó su DB efímera.

| Escenario | Resultado |
| --- | --- |
| Positivo: identidad sintética, binding `fake` activo, instalación, política, sesión, lote v1 | PASS sintético: 200, ACK exacto, fila GPS, retry idempotente |
| Negativo: mismo fixture sin binding activo | PASS de rechazo esperado: `scope` da 403 `binding_inactive`; cero prueba de ingestión sin binding |
| Negativo: binding transferido a tenant distinto de instalación | PASS en suite existente: 403, sin atribuir coordenadas al tenant nuevo |
| Teléfono físico sin ManageEngine y con binding GEOPS conocido | UNKNOWN: no se ensayó ni se verificó estado del binding del POCO |

## F. Impacto

La **captura local APK-first** no depende de una llamada a ManageEngine en `TrackingController`; la **configuración nueva y sincronización backend** sí dependen del binding/instalación GEOPS. El modo `fake` demuestra separación técnica respecto a la API ManageEngine, pero su uso está restringido a sintético. La persistencia offline local puede conservar registros mientras falla el envío; no convierte un `403` en ACK. SPEC-02 debe distinguir la prueba física de captura de la validación de identidad/ACK/PostGIS y mantener abierto el gate productivo. SPEC-03 Wave 1 de catálogo de clientes/geozonas puede avanzar documentalmente y con datos sintéticos; el motor de permanencia no puede atribuir visitas de teléfonos cuyas posiciones no ingresaron. La frase de SPEC-03 «exige MDM» debe precisarse como «exige `mdm_binding` activo e instalación coherente; no necesariamente ManageEngine real».

## G. Recomendación y criterio de cierre

1. **No cambiar código todavía.** El gate de identidad está demostrado y eliminarlo sin un modelo alterno rompería tenant, ancla y FKs.
2. **Corregir documentación** de SPEC-03 después de revisar este informe: separar fila `mdm_binding` lógica de servicio ManageEngine real y dejar el flujo productivo como decisión pendiente.
3. **Añadir regresión futura** de dispositivo/PoP válido sin binding: `/v1/device/config` y lote deben dar 403; con binding `fake` autorizado en modo sintético debe haber 200, ACK exacto y una fila; incluir v2/v3 al integrar.
4. **Decisión específica de producto/seguridad:** definir si un teléfono real sin ManageEngine tendrá un binding GEOPS de tipo autónomo, cómo se verifica y a qué tenant pertenece. Solo entonces planificar corrección acotada de alta/esquema/API, sin tocar captura Android por esta causa.
5. **Prueba física adicional autorizada:** registrar estado de identidad/binding/instalación del POCO, `event_id` no sensible, intento HTTP, ACK por ID y consulta autorizada a `position_event` para el mismo ID durante una ventana. Probar offline/reconexión y reenvío. No declarar PASS extremo a extremo con contadores solos.

**Respuesta inequívoca:** un teléfono **sin ManageEngine real** puede, en la implementación sintética demostrada, autenticar y almacenar GPS si tiene binding `fake` activo, instalación y política válidos. Un teléfono que solo está registrado/autenticado en GEOPS **pero no tiene ningún `mdm_binding` activo no puede completar la ingestión en HEAD**: recibe 403 antes del ACK y de `position_event`. Para un POCO real sin ManageEngine, la captura está parcialmente demostrada; sincronización y almacenamiento final correlacionados con su estado de binding permanecen **pendientes de validar**.
