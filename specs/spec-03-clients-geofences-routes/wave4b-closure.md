# SPEC-03 Wave 4B — cierre técnico local

**Fecha:** 2026-10-26. **Rama/worktree:** `codex/spec03-wave4b`, `C:/Users/kmena/.codex/worktrees/spec03-wave4b/Geops`. **Base:** `79a8a1cb6c1fc7751ea29c1ad18846d1456edfbf` (`codex/spec03-mdm-integration`). El candidato original y el checkout principal no se modificaron.

## A. Estado Git y alcance

La implementación permanece en la rama aislada. No se modificaron Android, OAuth/MDM, contratos GPS v2/v3, ACK, manifiestos B23, controlador de despliegue ni Wave 5. Se agregaron las migraciones `0028` y `0029`; los scripts y fixtures de regresión reconocen el catálogo de 29 migraciones. **DEPLOYED = NO; PUSHED = NO; MERGED_TO_MAIN = NO; MERGED_TO_STAGING = NO; PHYSICAL_VALIDATION = PENDING.** El estado de commits locales se registra al final.

## B. Identidad agente–dispositivo

`agent.id` sigue independiente de administradores, claves, instalaciones, `geops_device.id` y `mdm_binding.id`. `agent_device_link` guarda tenant, agente, dispositivo canónico, intervalo `[valid_from,valid_to)`, estado, versión, autor, timestamps y motivos. Exclusiones GiST impiden que un dispositivo o agente tengan vínculos simultáneos; se eligió conservadoramente un dispositivo vigente por agente. Finalizar y reasignar cierran el intervalo anterior y conservan la fila. Revocar la mantiene auditable y excluye su atribución. No hay borrado físico. `If-Match`, bloqueo de fila y clave de idempotencia protegen cambios concurrentes.

`geops_device_tenant` conserva la propiedad canónica de tenant tras retirar un binding MDM. Para un dispositivo MDM se establece desde binding activo verificado, instalación y clave GEOPS activas. La vía GEOPS sin MDM requiere clave activa previamente provisionada, permiso administrativo adicional `gps.installation.manage`, tenant autorizado e instalación explícita. Una sincronización GPS nunca crea el vínculo ni la propiedad de tenant. El aprovisionamiento inicial de una APK nueva sin MDM y su prueba física siguen pendientes; la autorización administrativa de una clave preexistente no sustituye esa ceremonia.

## C. GPS y evaluación

La configuración, los eventos de sesión/posición y health resuelven un binding MDM activo cuando existe. Sin binding, exigen `geops_device_tenant` y una instalación activa con `activation_tenant_id` concordante y `activation_binding_id=NULL`. La sesión GEOPS autenticada y la prueba de posesión de clave se mantienen. Las nuevas filas GPS pueden almacenar `mdm_binding_id=NULL` solamente bajo la comprobación de propiedad de tenant; las FK compuestas históricas continúan protegiendo las filas con binding. La prueba sintética verifica ACK de sesión y posición, persistencia en `position_event`, tenant correcto, binding nulo y consumo por el evaluador.

Wave 4A sigue siendo el único motor. Selecciona `agent_device_link` por `position_event.captured_at` dentro de jornada y ventana programada/efectiva, con snapshot `assignment_visit`. El timestamp de recepción no reasigna una posición tardía. La revisión 2 `TECHNICAL_ONLY` copia los parámetros de laboratorio y solo corre en `geops_verify_*` sintética; una revisión `APPROVED` separada sería necesaria para activar producción. `UNATTRIBUTABLE` e `INSUFFICIENT_EVIDENCE` no se convierten en `NOT_VISITED`.

El worker reconcilia hasta 100 asignaciones por ejecución, encola evidencia aceptada adicional y procesa con `FOR UPDATE SKIP LOCKED`. El ACK no espera al motor. Reintentos usan `next_attempt_at` y backoff acotado; cada nuevo trabajo reinicia intentos. Reprocesar sin nueva evidencia conserva la revisión. El conteo detecta filas nuevas, no modificaciones en sitio de `position_event`; una corrección excepcional requiere reproceso administrativo explícito.

## D. Migraciones

`0028_agent_device_links.sql` agrega propiedad de tenant, vínculos temporales, exclusiones, historial, permiso, referencia de intervalo a vínculo operativo, algoritmo técnico y reintentos. `0029_geops_gps_identity.sql` permite binding nulo en filas GPS/health bajo guardas de tenant, conserva las FK MDM y hace inmutable la propiedad GEOPS. No se editó ninguna migración anterior. Instalación desde cero, actualización 0027→0029, conservación de los 27 checksums previos, readiness y replay idempotente pasaron en PostGIS descartable. Las pruebas de actualización desde 0015/0016/0022/0023 también pasaron.

Compatibilidad pendiente de inventario antes de staging: instalaciones o entregas históricas sin binding **y** sin tenant siguen almacenadas, pero la guarda 0029 no permite nuevas mutaciones sobre ellas. Su retirada/reconciliación requiere un plan supervisado con tenant demostrable; no se debilitó la guarda para aceptar identidades ambiguas. Este riesgo no se ensayó contra una base persistente y no autoriza despliegue.

SHA-256 local: `0028 = FEC1D922F7C8E79A2CEBAB75153AC94467F5CFA683154CEB27B0F9A0679A5C80`; `0029 = 1F818A9362905B1AB27E8A4AAB2AAA7A171335116132134C83A171A35906E5E3`.

## E. API administrativa

`POST /v1/admin/agent-device-links`, `POST /v1/admin/agent-device-links/:linkId/end`, `POST /v1/admin/agent-device-links/:linkId/reassign`, `GET /v1/admin/agents/:agentId/device-link`, `GET /v1/admin/agents/:agentId/device-links`, `GET /v1/admin/agent-devices/available`, `GET /v1/admin/agent-devices/unassigned-agents` y `POST /v1/admin/agent-devices/:deviceId/authorize-geops`. Las mutaciones exigen sesión administrativa, origen/CSRF, `Idempotency-Key` UUID, permisos, validación estricta y auditoría; finalizar/reasignar requieren `If-Match`. La APK no puede modificar vínculos.

## F. Pruebas y regresiones

| Ensayo local sintético | Resultado |
| --- | --- |
| Wave 1 PostGIS | 57/57 |
| Wave 2 PostGIS | 76/76 |
| Wave 3 PostGIS | 70/70 |
| Wave 4A PostGIS | 40/40 |
| Wave 4B PostGIS | 53/53: vínculos, tenant, permisos, concurrencia, GPS MDM y sin MDM, ACK de sesión/posición/health, permanencia, reintento e idempotencia |
| Upgrade 0027→0029 | PASS; checksums históricos, readiness y replay |
| MDM/GPS | 16/16 scripts: OAuth, enrolamiento, política, eventos, health, continuidad, seguridad y migraciones |
| Chrome SPEC-03 | 15 Wave 1 + 14 Wave 2 + 20 Wave 3, escritorio y móvil |
| GPS navegador/integración del runner SPEC-03 | política 48, health 37, operaciones 58 |
| `npm test` | PASS: suites API, Web, contratos, migración, restore y réplica 0015 |
| `npm run typecheck` / `npm run build` | PASS API, Web y contratos |
| Lint dirigido | PASS: 24 archivos TS/MJS Wave 4B, 0 errores/advertencias |
| Lint global | PASS: 149 archivos, 12 advertencias preexistentes ajenas al cambio funcional |
| `git diff --check` | PASS |

El test Chrome de Wave 3 selecciona explícitamente una asignación vigente; el selector anterior podía abrir la ocurrencia cancelada y esperar un botón ausente. Su archivo `run-code` es una expresión ejecutable por Playwright CLI y no pertenece al globo de Biome del repositorio; la ejecución Chrome de 20/20 lo valida. Todas las bases `geops_verify_*` y el contenedor `postgis/postgis:18-3.6` fueron descartables, sin datos reales ni volumen persistente.

## G. Matriz de cierre

| Control | Estado | Evidencia / límite |
| --- | --- | --- |
| Identidad agente–dispositivo | PASS | Modelo, API y 53 pruebas Wave 4B |
| Integridad temporal | PASS | GiST, `[from,to)`, solapamiento y concurrencia |
| Atribución GPS | PASS | `captured_at`, sesión e instalación, prueba MDM y GEOPS sin MDM |
| Cambio de dispositivo | PASS | Cierre/apertura e historia conservada |
| Cambio de agente | PASS | Reasignación y atribución por captura |
| Permanencia | PASS | Motor Wave 4A, 40 pruebas y reproceso Wave 4B |
| Snapshots | PASS | `assignment_visit` y regresión Waves 2–4A |
| Eventos tardíos | PASS | Reconciliación por nueva fila y vínculo histórico |
| Idempotencia | PASS | Claves de API, lotes GPS y evaluación sin cambio |
| Seguridad | PASS | Permisos, tenant, clave/instalación GEOPS y auditoría |
| Migraciones | PASS | PostGIS descartable 0027→0029 y checksums |
| Regresión SPEC-03 | PASS | 57+76+70+40 y Chrome 15+14+20 |
| Regresión GPS | PASS | Suites GPS y runner SPEC-03 |
| Regresión MDM | PASS | 16/16 scripts |
| Pruebas físicas | NOT_RUN | Sin autorización/uso de dispositivos; protocolo separado |
| Calibración | NOT_RUN | Precisión, cadencia y permanencia requieren medición |
| Retención | PARTIAL | GPS crudo 90 días existente; resultados, intervalos y auditoría requieren decisión aprobada |

## H. Evidencia física, riesgos y Wave 5

`wave4b-physical-protocol.md` define POCO Android 16 sin MDM, Huawei P40 con estado MDM verificado, correlación Android→almacenamiento→envío→ACK→PostGIS→visita, offline y calibración. No se ejecutó. El circuito de aprovisionamiento inicial de POCO sin MDM debe comprobarse sobre APK existente o diseñarse en un frente autorizado; la ruta backend probada empieza con una clave GEOPS ya activa. El monitor de continuidad actual está centrado en alertas con `mdm_binding`; su cobertura del escenario sin MDM exige trabajo operativo adicional antes del ensayo físico. Retención derivada, calibración, umbrales y publicación futura siguen pendientes. El manifiesto/controlador B23 sigue fijado a 23 migraciones y bloquea despliegue; se resolverá después de Wave 5 con autorización.

| Dato / operación | Regla vigente o pendiente |
| --- | --- |
| `position_event` crudo | Purga existente a 90 días; no extender por Wave 4B |
| Resultados `visit_evaluation` | Plazo y método de eliminación pendiente de aprobación de privacidad |
| Intervalos acreditados e IDs de eventos | Plazo/minimización pendiente; no asumir conservación indefinida |
| Auditoría administrativa/GPS | Plazo y control de acceso pendiente de política aprobada |
| Replay tras purga GPS | Resultado histórico subsiste; no reconstruir evidencia cruda eliminada ni inferir nueva visita |
| Acceso administrativo | Capacidades, tenant, motivo auditado para coordenadas; definir rol operativo final |
| Eliminación segura | Diseñar orden de purga y prueba de FK/historia después de la decisión de retención |

Los contratos de evaluación, evidencia y consulta administrativa permiten iniciar **Wave 5 local** si el cierre técnico se acepta. El dashboard debe mostrar pendientes de sincronización, no atribuibles e insuficientes sin tratarlos como incumplimiento definitivo.

## I. Estado final

`WAVE4B_INTEGRATION_TECHNICAL_PASS` — integración local sintética; no acredita aprovisionamiento inicial ni operación física.

`WAVE4B_PHYSICAL_VALIDATION_PENDING`

`WAVE4B_OPERATIONAL_PASS = NO`

`DEPLOYED = NO`; `PUSHED = NO`; `MERGED_TO_MAIN = NO`; `MERGED_TO_STAGING = NO`; `PHYSICAL_VALIDATION = PENDING`.

**COMMITTED = NO.** HEAD permanece `79a8a1cb6c1fc7751ea29c1ad18846d1456edfbf`; los cambios Wave 4B están sin commit en el worktree aislado. No hubo push ni merge.
