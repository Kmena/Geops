# Arquitectura de referencia y límites operativos

**Estado:** diseño propuesto, sin implementación. **Base:** [PRD v1.1](../prd/GEOPS-PRD-v1.1.md) RF-01–RF-07, RF-14–RF-15; [ADR-002](../architecture/adr/ADR-002-gps-propio.md), [ADR-003](../architecture/adr/ADR-003-ingesta-gps.md), [ADR-004](../architecture/adr/ADR-004-infraestructura.md), [ADR-006](../architecture/adr/ADR-006-privacidad-administracion.md), [ADR-007](../architecture/adr/ADR-007-mdm-externo.md), [ADR-008](../architecture/adr/ADR-008-buffer-offline.md), [ADR-009](../architecture/adr/ADR-009-datos-geoespaciales.md).

## Flujo y fronteras

```text
ManageEngine / Android Enterprise ──aprovisiona, instala, aplica política──> Android
                                                            │
Android: horario → Location FGS → Fused Location → Room cifrado (pendiente de selección)
                                                            │
                            lote HTTPS autenticado + reintentos │
                                                            ▼
Reverse proxy → API Node.js/TypeScript → transacción PostgreSQL/PostGIS
                                             │            │
                                             │            └─ posición + outbox durables
                                             ▼
                                    acuse tras COMMIT
                                                          outbox → Worker idempotente
                                                                       │
                                                visitas/alertas/indicadores → API admin → React/Leaflet
```

La API de ManageEngine, si está disponible en la licencia concreta, solo alimentará inventario/estado MDM y diagnóstico. El GPS de negocio llega directamente del agente. No se comparten credenciales, datos ni despliegues con Inventori/Billing. No se introduce broker ni microservicios para la carga inicial; un worker separado dentro del backend y una tabla outbox transaccional bastan como diseño de partida. [research R02–R03, R14](research.md)

## Captura Android

1. Un calendario **versionado por dispositivo** contiene zona IANA, franjas y excepciones. Antes de cada solicitud de ubicación y al recibir cada callback se comprueba si la marca de tiempo pertenece a la jornada autorizada. Al terminarla se eliminan solicitudes FLP y se detiene el servicio. La API vuelve a validar la configuración efectiva del evento; un reloj alterado se registra como anomalía.
2. Durante jornada se solicita un `location` Foreground Service con notificación visible y Fused Location Provider a intervalo objetivo de 60 s. Se registran hora de captura, precisión horizontal, fuente fusionada y metadatos necesarios. La app puede prescindir de acceso cotidiano desde el launcher solo si el flujo de aprovisionamiento, permisos y recuperación queda probado; la notificación/indicadores del SO permanecen visibles. El intervalo y la precisión son **best effort**; jamás se rellena una posición ausente con la última conocida. [research R07–R09](research.md)
3. El callback escribe primero un evento con ID estable en Room. El almacenamiento local debe cifrarse con una solución compatible con la versión elegida, clave protegida en Android Keystore y política de backup que excluya datos y credenciales sensibles. **Room no cifra por sí solo**; la librería/estrategia concreta sigue abierta. [research R10, R15](research.md)
4. WorkManager agenda trabajo único con requisito de red y backoff para lotes pendientes; sirve para trabajo persistente y recuperación, no como cron de 60 s. Durante jornada el servicio puede disparar carga oportunista. Fuera de jornada puede sincronizar datos históricos sin realizar nuevas consultas de ubicación, si la política de privacidad lo aprueba.
5. Ante pérdida de Internet se continúa guardando **solo posiciones disponibles**; si FLP no entrega ubicación válida se registra un estado diagnóstico sin coordenadas. La falta de señal GNSS puede dejar disponible una ubicación fusionada de otra fuente; se evalúa su calidad en vez de asumir ausencia de posición. Ante reinicio, se restauran calendario y trabajos, se reevalúan permisos y se intenta reanudar únicamente por una vía permitida por la versión Android. La app propia no recibe automáticamente privilegios DPC por estar distribuida por MDM. Inicio exacto de turno y reinicio siguen **PENDING_PHYSICAL_VALIDATION**. [research R08–R10](research.md)
6. Se vigilan tamaño de cola, eventos más antiguos, batería y fallos. Si el almacenamiento está próximo al límite, se alerta y se aplica una política aprobada; no se descartan datos silenciosamente.

## Ingesta y procesamiento

- Una identidad lógica `device_id` se crea al registrar un teléfono. [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md) fija invitación temporal de un uso, clave P-256 por instalación en Android Keystore, activación con confirmación física, sesiones cortas ligadas a clave, firma por solicitud y revocación inmediata. El vínculo MDM se verifica por API cuando esté probada en Free, o mediante proceso manual auditado si se aprueba. Las credenciales MDM y GPS son distintas; el servidor almacena claves públicas, HMAC de invitación y hash de sesión, nunca secretos recuperables.
- La API autentica, limita tamaño/rate, valida el lote completo y usa una transacción para insertar posiciones nuevas mediante unicidad `(device_id,event_id)` y tareas outbox. Solo tras COMMIT responde con IDs aceptados y duplicados. Si se pierde el acuse, el cliente reenvía los mismos IDs. Un mismo ID con contenido diferente es conflicto, no reemplazo.
- Se conserva `captured_at` y `received_at` por separado. Se ordena por `captured_at,event_id` para consulta y cálculo. Lotes y capturas pueden llegar fuera de orden; el worker recalcula ventanas afectadas con versiones de horario, ruta, asignación y regla vigentes **al momento de captura**, y registra transiciones de estado.
- El worker consume outbox al menos una vez con bloqueo y reintento. Sus escrituras derivadas usan claves de obligación/regla/versiones para ser idempotentes. Si falla, la ingesta continúa; si la cola crece, se alerta. La reparación reejecuta desde eventos persistidos dentro de los 90 días. Backups requieren restauración probada.
- El contrato candidato, acuses, errores y límites están en [api-contracts.md](api-contracts.md). No se promete orden de llegada ni entrega inmediata. La confirmación significa **persistencia**, no visita ya calculada.

## Seguridad, privacidad y operación

La web tendrá autenticación de administradores, sesiones con expiración y auditoría de cambios y consultas sensibles. Todos los usuarios autorizados tienen rol administrador según PRD; aun así se separan identidades humanas, de dispositivo y de integración MDM, con credenciales de mínimo alcance. HTTPS/TLS termina en el reverse proxy; tráfico interno y secretos se configuran independientemente. No habrá claves en repositorio, APK o logs. La clave privada de firma se genera en Android Keystore; el token de sesión corto vive solo en memoria y se renueva tras reinicio mediante challenge firmado. La base GPS sigue pendiente de selección de cifrado y se excluye del backup. La rotación/revocación y el borrado de equipo siguen [device-provisioning.md](device-provisioning.md).

Se muestra aviso de seguimiento laboral y los indicadores obligatorios de Android. El MDM podrá mantener Location Services habilitado según política compatible, pero el agente no captura fuera de horario. Se registran versiones de horario y cambios de administrador. La ubicación individual se elimina a 90 días; el plazo de respaldos y datos derivados requiere decisión de privacidad. [data-model.md](data-model.md)

GEOPS desplegará procesos, base, usuario de base, secretos, backups y red propios sobre un servidor que podría compartir hardware. Se documentarán restauración y migración antes de producción. La capacidad real de CPU, disco, certificados, dominio y monitoreo está pendiente de auditar.

## Carga de referencia

25 dispositivos × 60 posiciones/hora × 8–12 horas = **12.000–18.000 posiciones por día laboral**. A 90 días continuos equivalen a **1,08–1,62 millones de filas**; con 5 días/semana serían menos, pero no se usa esa reducción para dimensionar. Promedio durante jornada: 1.500 posiciones/hora ≈ **0,42 eventos/s**. Una cola de 7 días a 12 h/día puede concentrar ~126.000 eventos; con lotes candidatos de 100 requiere ~1.260 peticiones de recuperación. A 1 KiB por fila más índices como aproximación preliminar, 90 días ocupan ~1,0–1,5 GiB antes de WAL, réplicas y backups. Medir tamaño real e IOPS antes de fijar capacidad. [data-model.md](data-model.md)

## Decisiones que siguen abiertas

Edición/tenant/API ManageEngine, entrega MDM de la invitación y vinculación física, forma de iniciar el servicio al turno y tras reinicio, concesión de permisos por OEM, cifrado Room, límites finales de lote/rate, umbrales GPS/visitas y política de backups. El protocolo base de credencial está decidido en ADR-012; su integración y piloto están pendientes. [open-questions.md](open-questions.md)
