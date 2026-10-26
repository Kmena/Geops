# ADR-027 — Identidad GEOPS para agente, dispositivo y GPS

**Fecha:** 2026-10-26. **Estado:** implementación técnica local; aprobación operacional pendiente. **Complementa:** ADR-012, ADR-016, ADR-025.

## Contexto

`geops_device.id` es la identidad estable del teléfono en GEOPS; `gps_device_installation.installation_id` cambia al reinstalar y `mdm_binding.id` identifica una relación con ManageEngine. Ninguno identifica al agente. La ingesta previa exigía binding MDM activo y el motor Wave 4A solo tenía vínculo sintético.

## Decisión

Un administrador con permisos explícitos crea `agent_device_link` por tenant con intervalo `[valid_from,valid_to)`, motivo, autor y control de concurrencia. Excluir solapamiento por dispositivo y, conservadoramente, por agente; mantener historia tras cierre/reasignación/revocación. Un dueño canónico `geops_device_tenant` evita que retirar MDM cambie silenciosamente el tenant del dispositivo.

El GPS resuelve primero el binding MDM activo. Sin binding, únicamente usa la instalación GEOPS activada y el dueño de tenant probado; conserva autenticación de clave/sesión, política, ventana, deduplicación y ACK. Una nueva posición nunca crea un vínculo de agente. La atribución a agente se hace con `captured_at`, no con `received_at`.

## Consecuencias y límites

La ruta sin MDM en backend comienza con una clave GEOPS ya activa: no prueba la ceremonia de aprovisionamiento de una APK nueva. La regla de un dispositivo simultáneo por agente puede revisarse con decisión funcional y migración futura; evita atribución ambigua hoy. La evaluación sigue `TECHNICAL_ONLY` con parámetros sintéticos. Retención, monitor de continuidad sin MDM, calibración y pruebas físicas requieren cierre separado. Ninguna parte de esta ADR autoriza despliegue ni cambio de APK.
