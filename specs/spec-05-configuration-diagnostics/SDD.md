# SDD — Configuración y diagnóstico de dispositivos GEOPS

Estado: **Waves 1, 2 y 4 PASS técnico; Wave 3 PARTIAL técnico; Wave 5 implementada en laboratorio para revisión** el 2026-11-27. Base: b597c9f. [Auditoría](AUDIT.md), [contratos Wave 2](WAVE2-API-CONTRACT.md), [contratos Wave 3](WAVE3-API-CONTRACT.md), [contratos Wave 5](WAVE5-API-CONTRACT.md), [preparación física R1](WAVE1-R1-LAB-PROTOCOL.md), [cierre Wave 4](WAVE4-CLOSEOUT.md), [cierre Wave 5](WAVE5-CLOSEOUT.md) y [matriz ManageEngine](MANAGEENGINE-CAPABILITY-MATRIX.md). Esta especificación no cambia el motor GPS v2, el contrato de posiciones ni la política BYOD.

## 1. Problema, objetivos y límites

El operador necesita distinguir si un hueco GPS se originó en autorización GEOPS, configuración MDM, permiso Android, servicio FGS, proveedor de ubicación, almacenamiento local o transmisión. El módulo mostrará **deseado**, **aplicado** y **efectivo** con fuente, hora y nivel de certeza por dato. La comparación no declarará conformidad cuando falte telemetría o el dispositivo esté offline. El controlador MDM seguirá siendo el único aplicador de políticas de administración y las credenciales permanecerán en backend.

**ManageEngine es el único proveedor MDM confirmado.** El adaptador existente está orientado a MSP Cloud; la edición del tenant real aún no está verificada. Se amplía la integración existente; no se desarrolla AMAPI ni se migra/reinscribe la flota. Wave 3 llegó solo a verificación sintética; edición, licencia, versión, OAuth scopes, endpoints/payloads y evidencia aplicada del tenant siguen pendientes antes de operaciones reales. La APK Corporate conserva seguimiento individual autorizado con independencia de rutas y de sesión interactiva; Personal mantiene ventanas y controles propios.

**No objetivos:** prometer una posición cada 60 s, garantizar reinicio después de force-stop, presentar estados inferidos como mediciones, crear otro controlador MDM, incluir secretos MDM en APK o tratar una ruta como condición de captura.

## 2. Semántica y fuentes de verdad

| Nivel | Fuente | Datos | Caducidad y resultado sin datos |
| --- | --- | --- | --- |
| Deseado | geops_device, gps_policy_revision, gps_effective_assignment, gps_mdm_continuous_authorization y futura referencia de política MDM | propiedad, autorización, intervalos, versión APK esperada, permisos requeridos, política | Se calcula al consultar y se versiona por revisión/asignación. Si no hay política autorizada: no se supone seguimiento. |
| Aplicado | Adaptador ManageEngine | perfil/asignación, versión, cumplimiento, detalle, modo, instalación y reporte **solo cuando la API concreta lo exponga** | Timestamp ManageEngine; PENDING_VERIFICATION si espera reporte, UNKNOWN si falta dato, NOT_SUPPORTED si la edición/API no lo expone. |
| Efectivo | APK vinculada por device_id + installation_id + PoP | permisos, ubicación, batería, red, FGS/listener, captura, ACK, cola, versión, configuración recibida | observed_at del dispositivo y received_at del servidor; si envejece, DIAGNOSTIC_STALE. Proceso muerto no puede afirmar FGS activo. |

Cada campo de la comparación lleva value, normalized_state, source, observed_at, received_at, applicability y evidence_ref. Estados: GRANTED, DENIED, NOT_DECLARED, RESTRICTED, NOT_APPLICABLE, NOT_SUPPORTED, UNKNOWN y PENDING_VERIFICATION. Para banderas de servicio usar RUNNING_OBSERVED, STOPPED_OBSERVED o UNKNOWN, nunca GRANTED. El valor PENDING_VERIFICATION describe un cambio enviado sin confirmación; no es éxito. Umbrales configurables por política y por tipo de dato, con valores iniciales propuestos: snapshot 15 min, heartbeat 15 min, captura estancada 3 intervalos con tolerancia Android; confirmar con datos físicos antes de fijarlos para producción.

## 3. Arquitectura propuesta

    APK Corporate/Personal -> DeviceDiagnosticCollector -> transporte PoP existente
                                   |                        |
                                   + diario cifrado GPS v2    v
    Web / APK autorizada -> API HTTP -> casos de uso Diagnostics/Remediation
                                           |       |         |
                                           v       v         v
                                      PostgreSQL  reglas  MdmProviderCapabilities
                                                             |
                                               ManageEngine (edición por verificar)

1. **Dominio:** observaciones tipadas, comparación y findings deterministas. Las reglas consumen evidencias con timestamps y emiten causa/impacto/acción con certeza. Un dispositivo offline recibe DEVICE_OFFLINE y, si procede, DIAGNOSTIC_STALE; no GPS_SERVICE_NOT_RUNNING sin evidencia reciente de detención.
2. **Aplicación:** SubmitSnapshot, ReadDeviceComparison, RequestFreshDiagnostic, PreviewRemediation, SubmitRemediation, ReconcileRemediation y ExportReport. El caso de uso impone autorización y tenant antes del adaptador. La APK nunca recibe OAuth MDM.
3. **Puertos/adaptadores:** MdmCapabilities abstrae la integración ManageEngine existente sin crear proveedores adicionales. ManageEngineReadOnly continúa suministrando inventario; nuevas lecturas/escrituras requieren verificar API, licencia, edición y versión. Las capacidades no probadas devuelven NOT_SUPPORTED o PENDING_VERIFICATION, jamás éxito inferido.
4. **Persistencia:** nuevos snapshots de diagnóstico separados de gps_device_health_event y posiciones. Reusar audit_event, geops_device, gps_device_installation, mdm_inventory_device, gps_policy_revision y sus versiones como referencias. El diario local cifrado alimenta resumen; no se suben coordenadas, tokens ni invitation_secret.
5. **Programación:** el colector se activa tras inicio de proceso, inscripción, cambios de permisos/configuración, conectividad, boot permitido y petición administrativa. Trabajo periódico compatible con Android, con deduplicación por estado y mínimo intervalo; el servicio GPS existente no se duplica. Una petición remota se atiende en la próxima comunicación permitida, no se promete push inmediato. La ausencia de Activity no detiene captura ni diagnóstico periódico.
6. **Modelo de seguridad Wave 4:** sesión administrativa GEOPS existente con cookie HttpOnly de servidor, Origin/CSRF y RBAC; la APK Corporate mantiene el valor de cookie y CSRF solo en memoria de proceso y llama HTTPS al backend, sin WebView ni persistencia de contraseña/token. El backend aplica 30 min inactivo, 8 h absoluto, revocación, permisos actuales y grants del tenant. Una sesión nueva emitida tras contraseña válida en los últimos 5 min es obligatoria para vista previa, solicitud y envío MDM. El PoP de instalación para GPS y snapshots no depende de esa sesión. El endpoint de permisos administrativos es `/v1/admin/auth/permissions`.

## 4. Modelo de datos propuesto

Wave 2 implementa la migración aditiva `0041_device_diagnostics.sql`, posterior a 0040, sin alterar tablas GPS v2 históricas. El contrato v1 guarda un snapshot tipado, limitado a 16 KiB, con payload y findings JSONB inmutables. `device_id` y `tenant_id` proceden del vínculo autenticado en servidor; la APK solo declara `installation_id`. La clave única `(installation_id,boot_id,sequence)` permite reintentos idempotentes, mientras `observed_at` y `received_at` separan orden de captura y recepción. La implementación no crea aún tablas de observación por campo ni de corrección MDM: se posponen hasta validar la API real del tenant.

| Entidad | Claves/campos principales | Retención e invariantes |
| --- | --- | --- |
| device_diagnostic_snapshot | id UUID, device_id, installation_id, ownership, boot_id, sequence, observed_at, received_at, app_version, android_api, payload_schema, payload_digest, source | UNIQUE(installation_id, boot_id, sequence); digest detecta mismo ID con contenido distinto; snapshot inmutable. |
| device_diagnostic_observation | snapshot_id, key, state, value_json limitado, source, observed_at, applicability, confidence | Lista blanca de keys; sin coordenadas, identificadores sensibles ni texto libre del sistema. |
| device_diagnostic_finding | snapshot_id o evaluación_id, code, severity, evidence_refs, source, observed_at, cause, impact, recommendation, remediation_class, status | La evaluación es reproducible y versionada; no duplicar eventos GPS de salud. |
| mdm_policy_observation | customer_id, profile_id, revision si existe, fetched_at, digest, campos permitidos | Solo proyección/redacción. Campo sin equivalente verificado queda UNKNOWN. |
| mdm_device_observation | customer_id, mdm_device_id, geops_device_id, assigned/applied profile si la API lo confirma, last report/sync, fetched_at | UNIQUE(customer_id, mdm_device_id); FK al vínculo verificado. |
| mdm_remediation_request | id, customer_id, target_device/profile, kind, desired_delta, preview_digest, expected_profile_digest, actor, reason, idempotency_key, state, created_at | UNIQUE(customer_id, actor, idempotency_key); no contraseña/token en delta. |
| mdm_remediation_attempt | request_id, ordinal, submitted_at, manageengine_result_code, observed_profile_digest, error_code, retry_at | Intentos acotados; una acción por perfil bajo lock. |
| mdm_remediation_target | request_id, device_id, result_state, evidence_ref | Resultado individual y agregado para bulk; cero cambios ocultos. |

Política de retención propuesta para revisión: snapshot detallado 30 días, findings y resultados 90 días, audit_event conforme a retención corporativa existente (no inferida aquí); partición/archivo y borrado solo tras aprobación de política. Guardar observed_at **y** received_at para detectar datos fuera de orden. La descarga técnica incluye hashes/referencias, nunca claves ni posiciones. Recuperación: probar migración hacia adelante sobre copia descartable con checksums existentes, backup verificado, restore de ensayo y binario anterior compatible con tablas aditivas; si falla, detener rollout y conservar datos, no revertir mediante DROP.

## 5. Reglas de diagnóstico

| Código | Condición mínima de evidencia | Severidad inicial / acción |
| --- | --- | --- |
| GPS_PERMISSION_MISSING, GPS_BACKGROUND_PERMISSION_MISSING, GPS_PRECISE_LOCATION_DISABLED | Permiso runtime de snapshot reciente, versión Android aplicable y seguimiento autorizado | ERROR; AUTO_MDM solo con proveedor/modo verificado, si no USER_ACTION_REQUIRED |
| LOCATION_SERVICES_DISABLED | LocationManager desactivado reciente | ERROR; AUTO_MDM solo si perfil/endpoint ManageEngine se validó; si no usuario |
| GPS_SERVICE_NOT_RUNNING | Evento reciente STOPPED/FGS_DESTROYED más ausencia confirmada en proceso vivo | ERROR; INVESTIGATION_REQUIRED |
| GPS_SERVICE_STATE_UNKNOWN | Proceso/telemetría ausente o vieja | WARNING; pedir diagnóstico, no afirmar detención |
| GPS_CAPTURE_STALE | Política vigente, servicio/listener observados y sin captura por umbral validado | WARNING; investigar permisos/proveedor/Doze |
| GPS_TRANSMISSION_STALE, SYNC_QUEUE_BACKLOG | Captura y pendientes existentes con ACK retrasado | WARNING; revisar red/ACK; no mezclar con falta de GPS |
| BATTERY_RESTRICTION_DETECTED, BACKGROUND_DATA_RESTRICTED | Señal Android explícita y versión aplicable | WARNING; USER_ACTION_REQUIRED o INVESTIGATION_REQUIRED |
| MDM_POLICY_NOT_APPLIED, MDM_POLICY_VERSION_MISMATCH, MDM_NON_COMPLIANT | Reporte MDM fresco, política asignada conocida | WARNING/ERROR; AUTO_MDM solo para delta soportado |
| MDM_PERMISSION_MISMATCH | Perfil ManageEngine reporta permiso concedido y APK observa DENIED | ERROR; verificar perfil aplicado, modo y APK |
| APP_VERSION_OUTDATED | Versión APK instalada observada y mínimo configurado | WARNING; APP_UPDATE_REQUIRED |
| DEVICE_OFFLINE, DIAGNOSTIC_STALE, BOOT_RECOVERY_UNVERIFIED, DEVICE_MANAGEMENT_UNVERIFIED | TTL y fuente faltante explícitos | WARNING/INFO; sin inferir FGS detenido |

Cada finding incluye código, severidad INFO/WARNING/ERROR/CRITICAL, descripción, fuente, evidence_refs, hora, causa posible, impacto y acción. CRITICAL solo para evidencia de pérdida de seguimiento autorizado de alto riesgo definida por política de negocio, no por un único heartbeat ausente. Versionar reglas y reevaluar sin alterar snapshots.

## 6. Corrección segura

Clases: AUTO_MDM, APP_CONFIGURATION, USER_ACTION_REQUIRED, APP_UPDATE_REQUIRED, NOT_SUPPORTED, INVESTIGATION_REQUIRED. Estado: REQUESTED → VALIDATED → SUBMITTED → PENDING_APPLICATION → APPLIED → EFFECTIVE_VERIFIED; terminales FAILED, PARTIALLY_APPLIED, TIMED_OUT, CANCELLED, SUPERSEDED. APPLIED exige reporte del controlador; EFFECTIVE_VERIFIED exige observación APK posterior al cambio cuando sea técnicamente posible. Si no lo es, cerrar con APPLIED y verificación efectiva NOT_SUPPORTED, sin mostrar éxito completo.

**Preview obligatorio:** leer perfil actual, contar dispositivos asociados, verificar edición/licencia/scopes/modo/API level, calcular delta y efecto por dispositivo, mostrar diff y preview_digest. El administrador introduce motivo y confirma digest y conteo. Si ManageEngine permite un perfil individual, ofrecerlo solo tras validar impacto. Bulk queda deshabilitado por defecto.

**Submit:** backend relee perfil y versión/digest disponibles, compara con preview, adquiere lock por customer/profile, registra request/audit y envía únicamente el delta compatible con la API ManageEngine verificada. Rechaza 409 si cambió la base. El lock local no impide ediciones en la consola; releer después y clasificar SUPERSEDED si difiere. No habilitar escritura hasta verificar semántica del endpoint en laboratorio. Reintentos acotados; nunca repetir una operación ambigua sin consultar estado remoto. Auditoría en audit_event con actor, tenant, target, before/after redactados, motivo, correlación, versión/digest y error.

## 7. Contratos HTTP (v1 Wave 2 y propuestos posteriores)

Conservar rutas GPS v2 existentes. Todos los endpoints administrativos requieren sesión y capacidad, y los mutantes exigen Origin/CSRF, reason, request_id UUID e Idempotency-Key. Se valida tenant desde el servidor. JSON desconocido se rechaza; los timestamps son UTC ISO 8601.

| Método y ruta | Petición / respuesta esencial | Seguridad y errores |
| --- | --- | --- |
| POST /v1/device/diagnostics/snapshots | PoP; schema_version, installation_id, boot_id, sequence, observed_at, observations[]; respuesta snapshot_id, accepted_at, duplicate | Solo instalación vinculada; 400 esquema, 401 PoP, 403 vínculo, 409 digest distinto, 413 límite, 429 cuota |
| GET /v1/device/diagnostics/self | Último snapshot propio, findings filtrados, estado/frescura y acciones locales | PoP; sin datos MDM reservados salvo proyección apta para empleado |
| POST /v1/device/diagnostics/requests/poll | Recoge petición pendiente para la instalación; ACK de ejecución separado | PoP; no credenciales MDM ni orden de modificar política |
| GET /v1/admin/mdm/diagnostics/summary | Conteos por estado con denominador y as_of; filtros permitidos | mdm.diagnostics.view y alcance tenant |
| GET /v1/admin/mdm/devices/{id}/diagnostics | desired, applied, effective, comparison[], findings[], freshness, evidence | mdm.diagnostics.view + tenant/dispositivo |
| GET /v1/admin/mdm/devices/{id}/diagnostics/history | cursor, limit, snapshots resumidos, findings y auditoría autorizada | mdm.diagnostics.view; audit aparte requiere mdm.audit.view |
| POST /v1/admin/mdm/devices/{id}/diagnostics/requests | Solicita próximo snapshot; devuelve request_id, queued_at, expires_at | mdm.diagnostics.execute; 202 no implica entrega |
| GET /v1/admin/mdm/profiles/{id} | Proyección de perfil ManageEngine, revision/digest si existe, fetched_at, support por campo | mdm.policies.view; 404/503/501 según disponibilidad verificada |
| POST /v1/admin/mdm/remediations/preview | targets[], kind, delta de perfil ManageEngine; devuelve impacto, diff, compatibilidad, preview_digest, expiración | mdm.permissions.remediate o mdm.configuration.update; sin efectos |
| POST /v1/admin/mdm/remediations | preview_digest, reason, request_id, confirmation_count; devuelve estado y targets | Capacidad específica; 409 preview obsoleto, 422 incompatible, 503 proveedor |
| GET /v1/admin/mdm/remediations/{id} | timeline, revisión/digest de perfil aplicado si existe, verificación APK, resultado por target | mdm.diagnostics.view en todos los targets |
| GET /v1/admin/mdm/devices/{id}/diagnostics/report | JSON técnico o CSV sin coordenadas/secretos; encabezado de fechas/fuentes | mdm.diagnostics.export y tenant |

Wave 2 implementa POST snapshots, GET self, último, historial limitado, permisos, findings, captura/transmisión y listas de problemas/desactualizados, además de summary. Los endpoints de solicitud remota, perfil MDM, corrección y exportación administrativa continúan propuestos; el contrato exacto ejecutable se registra en [WAVE2-API-CONTRACT.md](WAVE2-API-CONTRACT.md). El acceso administrativo exige `mdm.diagnostics.view` y ambos grants de datos GPS del tenant; no se autoasigna el permiso. La lectura aplicada de ManageEngine responde `UNKNOWN` hasta Wave 3.

La selección masiva usa un snapshot de IDs explícitos, no un filtro vivo que pueda crecer después del preview. Paginación por cursor, máximo 100 por página; límites y TTL a fijar en contrato final. En errores se devuelve código estable, correlation_id y mensaje redactado. Los contratos Wave 3 ejecutables usan vista previa de un dispositivo, solicitud local e historial; el envío real responde `mdm_write_disabled` incluso con sesión fresca. API pública documentada en OpenAPI al implementar, con pruebas de contrato.

## 8. Capacidades y acceso

Convención existente: gps.* y mdm.* en admin_permission, sin roles rígidos; [ADR-019](../architecture/adr/ADR-019-empresa-unica-administracion-por-capacidades-propuesto.md). Wave 2/3 incorporaron `mdm.diagnostics.view`, `mdm.diagnostics.export`, `mdm.policies.view`, `mdm.permissions.remediate`, `mdm.configuration.update` y `mdm.audit.view`; las capacidades propuestas de ejecución/bulk siguen sin contrato operativo. El permiso self se deriva de PoP de instalación y vínculo vigente, no de una capacidad administrativa autodeclarada. La APK Corporate usa la sesión administrativa GEOPS existente desde Wave 4; `admin_diagnostics_enabled` de Managed Configurations nunca sustituye RBAC. El diagnóstico local no crea una identidad de empleado ni altera controles.

La base actual utiliza una empresa sintética y modelos de tenant en transición; antes de activar multiempresa real, aprobar modelo de ownership y FK/índices de tenant. Todas las consultas y escrituras comprueban scope incluso si el identificador UUID es válido. Auditoría separa actor DEVICE/ADMIN/SYSTEM y registra resultado también en rechazo.

## 9. Diseño de pantallas (modo Operar)

### Corporate / Personal

La entrada visible “Configuración y diagnóstico” se ubica tras la activación existente. Wave 1 adelantó la vista local; Wave 4 la amplía en la APK Corporate con login administrativo, permisos, batería/background, GPS v2, ManageEngine, configuración GPS, conectividad y reporte sanitizado. El diagnóstico local no exige sesión abierta. El estado aplicado por permiso permanece UNKNOWN hasta lectura verificada del tenant; un perfil asignado no equivale a concesión efectiva. Cada fila local muestra deseado, asignado/aplicado cuando haya evidencia, efectivo, hora, impacto y acción. “Sin datos recientes” es distinto de “Denegado”. Los intervalos se leen de la configuración GPS existente, sin duplicar parámetros. La APK Personal no contiene la Activity ni el cliente de autenticación MDM.

Corporate muestra al empleado diagnóstico propio y “Solicitar soporte”; la sección administrativa aparece solo tras sesión privilegiada validada en backend. BYOD muestra solo permisos/estado local, controles de jornada y ajustes manuales compatibles. Ninguna vista Personal incluye política corporativa o seguimiento 24/7. “Prueba de captura” usa una única solicitud dentro de autorización existente, registra resultado y no crea un segundo listener. “Prueba de comunicación” no envía una posición de prueba. Exportar reporte técnico omite ubicación exacta e identificadores secretos.

### Portal web

Extender “Integración MDM” y “Dispositivos” existentes. Resumen con ocho indicadores solicitados y denominadores/as_of; listar por agente, modelo, Android, APK, política, cumplimiento, permisos, GPS, heartbeat y diagnóstico. Búsqueda por nombre/ID autorizado y filtros combinables; selección y acciones masivas visibles según capacidad. El detalle contiene General, Permisos Android, Políticas MDM, GPS, Configuración e Historial. Matriz con columnas Configuración | Deseada | Aplicada | Efectiva | Estado | Acción; celdas incluyen fuente y hora, y los estados desconocidos no se colorean como error. La acción abre preview con conteo afectado, diff, compatibilidad, motivo y confirmación; después muestra timeline por dispositivo. En móvil, cada fila se apila como tarjeta manteniendo encabezados legibles; teclado, lectores de pantalla, foco y texto de estado accesibles. Reutilizar tokens, navegación y componentes existentes; no añadir una consola MDM paralela.

## 10. Waves, dependencias y estimación de impacto

| Wave | Entrega / salida verificable | Componentes impactados |
| --- | --- | --- |
| 0 | Este AUDIT/SDD, decisiones y plan; sin despliegue | specs únicamente |
| 1 | Colector Android, permisos efectivos, FGS, batería, red, captura/ACK, pantalla corporativa mínima, reporte, pruebas y APK de laboratorio | android-app + android-agent; impacto alto |
| 2 | Ingesta PoP, migración aditiva, reglas, historial y RBAC de lectura | api + DB + contratos; alto |
| 3 | Ampliación ManageEngine, comparación MDM y corrección con preview/audit, solo tras verificar API/licencia | mdm provider + api + DB; muy alto |
| 4 | Completar login y acciones APK autorizadas; evolucionar pantalla Corporate y BYOD con estados de corrección | android-app + backend auth; medio/alto |
| 5 | Dashboard, detalle, filtros, export y bulk | web + api; alto |
| 6 | Prueba discriminante y corrección de defecto GPS confirmado, recuperación boot/offline | android-agent, app y API si procede; variable |
| 7 | CI, seguridad, rendimiento, batería, física Moto G06 y release/rollback | todos; alto |

Secuencia ejecutada: Wave 1 produjo evidencia local y pantalla mínima; Wave 2 la transportó; Wave 3 implementó contratos y comparación sintéticos con cierre **parcial** porque el tenant real no fue identificado; Wave 4 completó la pantalla y autenticación, aprobadas técnicamente por el usuario. Wave 5 amplió el workspace web existente con dashboard, listado, detalle, matriz, línea temporal, correcciones y exportación; la validación de navegador usa exclusivamente datos y MDM sintéticos. Antes de habilitar lecturas/escrituras reales del proveedor se requieren edición, licencia, versión, API/scopes y ensayo autorizado. No cambiar GPS sin causa respaldada.

## 11. Matriz de pruebas y CI

| Capa | Casos mínimos | Evidencia y gate |
| --- | --- | --- |
| Android unit/instrumented | Permiso concedido/denegado/no declarado, FINE/COARSE, background por API 26/29/31/33/35, ubicación apagada, FGS y precisión, batería/Doze, conectividad, boot, proceso muerto, cola offline, BYOD | Fixtures de versión y pruebas instrumentadas; no confundir emulador con físico |
| API/DB | DTO inválido, PoP, replay, idempotencia, duplicado con digest distinto, out-of-order, tenant cruzado, RBAC, retención, migración/restore, reglas sin falsos positivos | Integración Postgres descartable y contratos; no tocar datos reales |
| ManageEngine | inventario, perfil/restricción disponible, 401/403/429/5xx/timeout, aplicación demorada, perfil compartido, cambio competidor, escritura parcial, rollback lógico | Mock/fixture y tenant de laboratorio con licencia/scopes comprobados |
| Web/APK | carga/error/offline/UNKNOWN, rol, matriz, preview, bulk, reporte, accesibilidad/responsive | E2E y pruebas manuales de diseño |
| GPS regresión | Políticas vigentes, fuera de ruta, sin ruta, offline/ACK, continuidad, BYOD, rechazo de config, no duplicación | Suites GPS v2 existentes + casos nuevos |
| Física | Motorola Moto G06 obligatorio; pantalla apagada 30 min, Activity cerrada 60 min, autorizado 24 h, reboot, sin red, MDM, batería, permisos efectivos | Registro de APK/hash/Android/política, eventos y métricas. Hasta ejecutar: NOT_RUN |

Integrar en CI existente lint/typecheck/build API/web, build Corporate/Personal, pruebas unitarias/contrato/integración/E2E/Android, migraciones, secretos y seguridad. Los workflows actuales son de publicación y no sustituyen un gate completo de este módulo; añadir job sin credenciales productivas. No marcar físicas PASS con emulador o mock. Criterio de salida Wave 7: evidencia de los 16 puntos de aceptación de la solicitud, incluida prueba física, sin regresiones GPS v2/BYOD.

## 12. Riesgos y decisiones pendientes

| ID | Decisión / riesgo | Dueño propuesto y gate |
| --- | --- | --- |
| D-01 | **RESUELTA: ManageEngine único.** Pendiente verificar edición, licencia, versión, scopes, endpoints y payloads del tenant antes de escribir. | MDM; gate Wave 3 |
| D-02 | Confirmar modelo de empresa/tenant operativo y relación agente–usuario–dispositivo; la base actual conserva tenant sintético/transición. | Backend + Seguridad; bloquea RBAC productivo |
| D-03 | Definir autenticación administrativa en APK y alcance empleado; hoy hay inscripción de dispositivo, no login de usuario. | Producto + Seguridad; bloquea acciones APK |
| D-04 | Aprobar retención de snapshots/auditoría, exportaciones y minimización de datos. | Privacidad + Operaciones |
| D-05 | Política compartida vs por dispositivo, límite bulk y ventana de rollback. | Administración MDM; bloquea corrección |
| D-06 | Verificar configuración en Moto G06, versión instalada, permisos, OEM y causa GPS con ensayo controlado. | QA + Operaciones; bloquea GPS_BACKGROUND_TRACKING_PASS |
| D-07 | Revisar gate POST_NOTIFICATIONS, exact alarm y frecuencia para compatibilidad/consumo antes de cambiar el motor. | Android + QA |
| D-08 | Identificar ramas de release y secuencia de migraciones vigente al implementar; esta base incluye 0040 y hay otros worktrees activos. | Release engineering |

Los límites Android/OEM, fuerza de cierre, modo ahorro, reporte MDM diferido y latencia de red impiden garantizar continuidad absoluta. Las fuentes oficiales de [API MSP](https://www.manageengine.com/mobile-device-management-msp/help/api/cloud/api-index.html), [permisos y configuraciones](https://www.manageengine.com/mobile-device-management/help/android_for_work/mdm_app_configurations_and_permissions.html) y [FGS Android](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) sustentan las posibilidades; el [AUDIT](AUDIT.md) distingue disponibilidad real de documentación pública.

## 13. Estados de cierre de Wave 0

| Check | Estado | Evidencia / motivo |
| --- | --- | --- |
| SDD_READY | PASS | Este SDD, AUDIT y matriz; pendiente aprobación para implementar |
| ANDROID_PERMISSION_DIAGNOSTICS_PASS | PARTIAL | Wave 1 implementa matriz local y pruebas de reglas; falta ejecución Android física/instrumentada |
| GPS_BACKGROUND_DIAGNOSTICS_PASS | PARTIAL | Wave 1 muestra FGS, restricciones, wake y callback; falta observación Moto G06 |
| MDM_POLICY_READ_PASS | NOT_RUN | ManageEngine confirmado; lectura de perfil específica pendiente de Wave 3 |
| MDM_POLICY_UPDATE_PASS | NOT_RUN | Wave 3 |
| MDM_EFFECTIVE_PERMISSION_VERIFICATION_PASS | NOT_RUN | Wave 1–3 |
| MDM_REMEDIATION_PASS | NOT_RUN | Wave 3–5 |
| APK_DIAGNOSTICS_UI_PASS | PARTIAL | Pantalla Corporate local compilada; falta captura ejecutada, login y comparación MDM |
| WEB_DIAGNOSTICS_UI_PASS | PASS de laboratorio | Navegador Chrome local con PostGIS descartable y proveedor simulado; no valida tenant real |
| RBAC_SECURITY_PASS | PARTIAL | RBAC existente; capacidades nuevas no implementadas |
| AUDIT_PASS | PARTIAL | audit_event existente; correcciones nuevas no implementadas |
| GPS_BACKGROUND_TRACKING_PASS | NOT_RUN | Falta Moto G06 y observación sin Activity |
| GPS_REBOOT_RECOVERY_PASS | NOT_RUN | Código presente, prueba física pendiente |
| GPS_OFFLINE_RECOVERY_PASS | NOT_RUN | Código y suites históricas, prueba física pendiente |
| BYOD_REGRESSION_PASS | PARTIAL | Build Personal y pruebas compartidas pasan; falta ejecución física |
| PHYSICAL_DEVICE_VALIDATION | NOT_RUN | No se tocó dispositivo en Wave 0 |
| GPS_24H_VALIDATION | NOT_RUN | Requiere ensayo autorizado |
| PRODUCTION_READY | BLOCKED | Implementación Waves 2–7, validación tenant y física pendientes |

**Historial de aprobación:** Wave 0 y el cierre técnico de Wave 1 quedaron aprobados. D-01 exige verificación técnica del tenant antes de Wave 3.

## 14. Decisiones de Wave 2 y brecha de autenticación APK

Estados aprobados: `WAVE1_TECHNICAL_PASS`, `WAVE1_PHYSICAL_VALIDATION_PENDING`, `GPS_BACKGROUND_ROOT_CAUSE_UNCONFIRMED`, `MDM_PROVIDER_MANAGEENGINE_CONFIRMED`, `PRODUCTION_READY=NO`. Wave 2 usa PoP existente para transmitir diagnósticos desde un JobScheduler persistente, independientemente de la Activity. Mantiene una cola local AES-GCM de hasta 16 snapshots y limita el envío a cambios relevantes o refresco cada 15 minutos, sujeto a Android/Doze. El backend valida instalación/tenant, esquema y cuota, guarda snapshots inmutables y computa hallazgos. No se infiere servicio detenido desde silencio de red.

La activación de dispositivo no es login de empleado ni de administrador. Wave 4 separa identidad técnica, agente asignado, sesión administrativa y capacidades RBAC; reutiliza la autoridad web existente con credencial administrativa temporal solo en memoria y reautenticación para cambios sensibles. La sesión interactiva no gobierna el FGS corporativo autorizado. Wave 2 no tenía operación administrativa en APK; Wave 4 añade consulta, vista previa y solicitud local sujetas al backend.

**Punto de parada de Wave 2 cumplido:** el usuario aprobó `WAVE2_TECHNICAL_PASS` y `APK_STATIC_UPDATE_COMPATIBILITY_PASS`. `PHYSICAL_DEVICE_VALIDATION=NOT_RUN`, `GPS_BACKGROUND_ROOT_CAUSE=UNCONFIRMED` y `PRODUCTION_READY=NO` permanecen separados.

## 15. Wave 3: lectura ManageEngine y corrección administrada

La migración 0042 agrega capacidades `mdm.policies.view`, `mdm.permissions.remediate`, `mdm.configuration.update`, `mdm.audit.view` sin autoconcederlas. Agrega solicitud e historial de corrección con clave idempotente, digest de vista previa y eventos inmutables. El adaptador existente añade lectura de perfiles y aplicaciones por dispositivo, detalle de perfil y último contacto usando endpoints documentados para MSP Cloud. La lectura exige vínculo explícito GEOPS↔inventario ManageEngine, cliente/region autorizados, RBAC y grants del tenant. El motor compara configuración deseada conocida, asignación, aplicación **reportada por MDM** y permiso efectivo de Android, sin promover un estado asignado a aplicado.

La vista previa de asociación individual de perfil valida Android, publicación, versión y alcance de un solo dispositivo. La solicitud queda `AWAITING_APPROVAL`; el envío API devuelve `mdm_write_disabled` por defecto. La API per-app de permisos, batería y Managed Configurations no está confirmada para el tenant real: se conserva `UNKNOWN` y la acción se clasifica `INVESTIGATION_REQUIRED` o `CONSOLE_ACTION_REQUIRED`. El [informe de Wave 3](WAVE3-CLOSEOUT.md) registra su aprobación parcial y el [informe Wave 5](WAVE5-CLOSEOUT.md) documenta la ejecución web sin escritura real.

## 16. Wave 5: workspace MDM web

Se amplió la ruta `/status` y la navegación MDM existentes con seis secciones: resumen, dispositivos, permisos y configuración, diagnósticos, correcciones, historial y auditoría. La sección de conexión y sincronización existente sigue en el mismo módulo. La API usa una proyección SQL de dispositivos GEOPS autorizados por `mdm.diagnostics.view` y ambos grants del tenant; incluye dispositivos sin snapshot y evita N+1. La asociación ManageEngine usa el vínculo de inventario por `geops_device_id`; el ID de cliente del proveedor no se equipara al tenant de GEOPS. Si existen dos propietarios autorizados ambiguos, el equipo se excluye de la agregación.

Los indicadores exponen recuentos y fuentes del backend. El campo de conformidad se entrega `null` hasta tener evidencia verificada del tenant ManageEngine. Un dispositivo sin telemetría, con diagnóstico antiguo o sin comunicación se muestra en estado separado. La matriz muestra permisos efectivos Android y valores MDM solo cuando existe lectura; FGS y recuperación tras reinicio quedan pendientes de señal remota individual. La línea temporal usa timestamps de snapshots, capturas/ACK y cambios observados entre snapshots, más auditoría autorizada; no inventa hora exacta de inicio FGS ni cambios de perfil no registrados. El snapshot v1 tampoco incluye último intento de transmisión o intervalos reales observados.

Las correcciones reutilizan vista previa y solicitud Wave 3 con login reciente, CSRF, RBAC, impacto y clave idempotente. La escritura operativa permanece bloqueada. La exportación JSON de hasta 100 dispositivos contiene alcance, fecha, fuente, estado y solicitudes de corrección solo con `mdm.audit.view`; excluye coordenadas y secretos. La petición remota inmediata sigue no soportada por el transporte actual: [propuesta acotada](WAVE5-REMOTE-DIAGNOSTIC-PROPOSAL.md). [Contratos](WAVE5-API-CONTRACT.md), [capturas y pruebas](WAVE5-CLOSEOUT.md).

## 17. Wave 6: preparación y límites de la primera ejecución

El usuario aprobó técnicamente Wave 5 y autorizó **inicialmente solo W6-A y lecturas disponibles de W6-B**. La [evidencia de preparación](WAVE6-A-READINESS.md) inventaría rama, contratos, migraciones, APK y staging; registra laboratorio aislado con PostGIS, API, portal, GPS v2, diagnóstico SPEC-05, autenticación y mock ManageEngine. La misma identidad PoP sintética transmitió posición GPS v2 con ACK y snapshot diagnóstico; el backend proyectó éste en lectura administrativa, workspace y línea temporal. Chrome verificó el portal con 20 checks. La readiness local comprueba la integridad de migraciones y PostGIS.

Staging observado no está al nivel de este worktree: sus rutas GET de diagnóstico y workspace Wave 5 devuelven 404; `/health/ready` cae en el HTML del portal y no prueba readiness de API. El digest de imágenes y ledger SQL instalados siguen desconocidos. Por tanto, no se afirma compatibilidad de la APK candidata con el backend instalado. La APK Corporate Wave 4 conserva paquete `com.geops.corporate`, versionCode 4, versionName `1.0.3-spec05-wave4`, firma debug y hash registrados en el informe; la instalación del Moto G06 sigue sin verificar. ManageEngine real, dispositivo, causa raíz y 24 horas continúan bloqueados o sin ejecutar, sin inferencias desde las fixtures sintéticas.

Antes de cambiar staging o el teléfono se requieren inventario de imágenes y SQL efectivos, backup con restore aislado, ensayo de migración y rollback supervisado, tenant ManageEngine de lectura y metadatos/firma de la APK **instalada**. El gate de instalación pide además backend compatible, preservación de identidad, enrolamiento, datos y cola GPS, y autorización explícita para un único Moto G06. No hay cambio GPS justificado todavía; `mdm_write_disabled` permanece. La rama aislada no toca `main` ni producción y Wave 7 no empieza.

## 18. W6-R1: auditoría staging, descubrimiento MDM y compatibilidad APK

El usuario aprobó W6-A y autorizó W6-R1, limitado a preparación y lectura. El [inventario staging](WAVE6-R1-STAGING-INVENTORY.md) obtuvo acceso SSH de lectura y estado del controlador protegido: API/Web/PostGIS healthy, proyecto `geops-spec02-staging`, 40 migraciones, gate abierto y referencias activas por digest. El hash del prefijo candidato 0001–0040 coincide exactamente con el ledger reportado; 0041 y 0042 son las únicas migraciones SPEC-05 nuevas. La consulta HTTP mostró 404 JSON para diagnóstico y workspace SPEC-05, mientras otras rutas `/v1` devolvieron 401. El release activo corresponde al commit base anterior a esos archivos; confirmar labels OCI con el operador completa la cadena de procedencia. `/health/ready` público retorna HTML del portal y no valida la API.

La [matriz de compatibilidad](WAVE6-R1-STAGING-COMPATIBILITY.md) bloquea la APK Corporate Wave 4 contra el backend actualmente observado. Se preparó un [plan de release](WAVE6-R1-STAGING-RELEASE-PLAN.md) con workflow CI manual sin publicación y recuperación supervisada; un ID de imagen local no sustituye digest GHCR. Un [ensayo sintético](WAVE6-R1-BACKUP-RESTORE-EVIDENCE.md) validó `pg_dump`/`pg_restore` de esquema 0040, preservación de identidad y migración 0041/0042 en DB aislada. Falta backup/restore del staging real y el controlador actual no está probado para cambio de esquema. No se promovió nada.

El [descubrimiento ManageEngine](WAVE6-R1-MANAGEENGINE-DISCOVERY.md) separa endpoints públicos documentados de capacidades del tenant, todavía desconocidas; la configuración visible de Compose declara MDM false y no hay grant READ verificable. Se revalidó la [candidata y la referencia APK](WAVE6-R1-APK-COMPATIBILITY.md), ambas con el mismo certificado debug, pero la APK **instalada** sigue desconocida. Las [acciones restantes](WAVE6-R1-OPERATOR-ACTIONS.md) están consolidadas y ordenadas. W6-R1 no cambió el motor GPS, políticas, dispositivos, `main` ni producción, y se detiene antes de promoción staging, instalación Moto G06 y Wave 7.
