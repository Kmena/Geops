# GPS-HEALTH-001 — decisión contractual para backend sintético

**Adenda W1-E1 (2026-10-19):** la configuración PoP ya entrega `health_interval_s` y ancla tenant/binding; un lote de salud con esa ancla obtuvo ACK persistido y lectura administrativa autorizada en PostgreSQL desechable. El parser Kotlin leyó el snapshot real. [Evidencia](w1-e1-readiness-2026-10-19.md). El texto histórico de configuración pendiente más abajo describe el corte anterior; siguen pendientes activación operativa, sesiones/posiciones, scheduler, Web E2E y revisión independiente.

**Estado (2026-10-19):** diseño aceptado para implementación y pruebas **sintéticas** en esta rama. El delta queda registrado en el SDD y `openapi.design.yaml`; no es aprobación de seguridad independiente, privacidad, producto ni despliegue. Los contratos aprobados de SPEC-00/01 no se reemplazan. Ningún dispositivo real queda autorizado.

## Evaluación previa

El `Heartbeat` de W1-A solo expresa `location_state`, `network_state`, versión y backlog. No puede representar porcentaje de batería, carga, cargador, ahorro de energía, momento previsto/real de muestreo ni estado del FGS. Ampliarlo silenciosamente rompería el contrato congelado y mezclaría cadencia de comunicación con observación de salud. Se propone una **entidad y cola separadas**, con un endpoint de ingesta y una proyección de último estado. W1-C solo genera y conserva muestras sintéticas; no invoca un endpoint operativo inexistente.

| Cambio propuesto | Regla de diseño | Gate |
| --- | --- | --- |
| `gps_device_health_event` | ID UUID idempotente, dispositivo y tenant derivados de PoP + vínculo MDM activo, instalación/versión, ancla/boot, `due_at` y `observed_at` UTC, batería 0–100 o desconocida, carga/cargador, ahorro, GPS, red y servicio; sin coordenadas. | Migración 0010 y prueba PostgreSQL sintética completadas; registro operativo de instalación pendiente. |
| `POST /v1/device/health/batches` | Bearer + PoP SPEC-01, 1–100 eventos y 128 KiB, ACK después de COMMIT, sin 202, 422 atómico y 409 por ID/digest distinto; cuota 6/min por dispositivo. | HTTP/PostgreSQL sintéticos probados; carga sostenida y cliente Android real pendientes. |
| `GET /v1/admin/devices/{id}/health` | Última muestra y serie paginada con `gps.session.read`, concesión explícita de tenant y motivo 8–240 caracteres; lectura auditada. Sin concesiones automáticas. | Contrato y lectura sintéticos probados; flujo operativo de concesión/revocación y Web pendientes. |
| Retención | Purga por lotes a 90 días desde observación; recibos a 90 días desde persistencia y cuota a 2 días. | Método probado en DB desechable; scheduler, backups y plazo final sujetos a privacidad/restore. |
| Frecuencia | `health_interval_s` 60–3600 s, predeterminado 300 s, independiente de captura y sync; campo opcional en entrada por compatibilidad con W1-A. | Escritura/lectura de revisión integrada; consumo de configuración real y batería por OEM pendientes. |

El agente no inferirá `NO_COMMUNICATION`: el servidor lo calcula por ausencia de mensajes dentro de ventana, con umbral y última observación. `BATTERY_LOW` y `BATTERY_CRITICAL` son etiquetas sobre muestras directas (umbrales propuestos 15% y 5%), no diagnósticos de apagado. Una última muestra al 2% seguida de silencio permite **posible** agotamiento, jamás causa confirmada. GPS sin Internet y red sin GPS son estados distintos. Si se agota la cuota local, la captura se detiene y se registra el fallo; no se borra evidencia sin ACK.

El [OpenAPI delta](openapi.health.proposed.yaml) conserva su nombre histórico, y sus rutas/esquemas están incorporados a [OpenAPI de diseño](openapi.design.yaml) y a la copia de `api-contracts`. La API de esta rama registra las rutas solo cuando se inyectan identidad, admin y servicio GPS; no hay publicación operativa.

La muestra solo se crea dentro de una instancia UTC autorizada, incluso sin coordenada. `due_at` y `observed_at` miden retraso; 60 s GPS y 300 s salud son objetivos, no garantía de ejecución exacta. El envío posterior a la jornada conserva hora original y exige identidad vigente. El backend coteja ancla, boot, delta monotónica, instalación, tenant/binding fijados al emitir el ancla, sesión programada y vigencia. `GET /v1/device/config` sigue sin implementación en esta rama: la publicación y el consumo extremo a extremo de `health_interval_s` quedan pendientes.

## Trazabilidad y decisión pendiente

GPS-HEALTH-001 extiende S02-R07, S02-T08, S02-P07/P08/P09/P11 y ADR-016/017. El ACK de salud confirma solo los IDs persistidos de este lote; el heartbeat no los confirma. No se declara W1-C completa ni E1 lista. Quedan abiertos la revisión independiente, el consentimiento/retención y backups, el flujo de concesión de tenant, el registro de instalación durante activación, configuración PoP, prueba Kotlin nueva e integración Web/Android.
