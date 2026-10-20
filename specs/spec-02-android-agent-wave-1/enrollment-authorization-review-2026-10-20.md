# W1-E2 — autorización de inscripción supervisada

**Rama:** `codex/spec-02-wave-1`. **Estado:** `CONDITIONAL_PASS` para pruebas sintéticas locales; revisión independiente y validación física pendientes. La modalidad sin MDM conserva invitación de un uso, PoP, código de emparejamiento y confirmación presencial en Web. La activación de la instalación GPS continúa separada.

## Hallazgo y corrección

`requireAdmin` comprobaba sesión, Origin y CSRF, pero las rutas de emisión, evidencia y activación de identidad solo llamaban a ese control. La autorización del inventario exigía capacidad, pero no acceso tenant; la activación y retiro de instalación GPS también carecían de comprobación tenant. Una sesión administrativa por sí sola no concede esas operaciones.

La API ahora requiere `gps.installation.manage` vigente **y** ambas concesiones activas de `gps_data_tenant_access` y `gps_health_tenant_access` para el tenant del binding. La consulta exige además que coincida con `geops_operating_tenant`, que representa la empresa inicial aprobada. La comprobación se realiza dentro de la transacción y bloquea las filas de capacidad y concesiones mientras se confirma la mutación; una revocación concurrente no puede intercalarse silenciosamente. La respuesta de rechazo es HTTP 403 con código genérico `gps_forbidden`; la auditoría guarda acción, resultado y código, nunca secreto, QR ni código de emparejamiento.

| Operación administrativa | Control aplicado |
| --- | --- |
| Inventario, borrador y estado MDM sintético | Sesión, capacidad y acceso al tenant `synthetic`; Origin/CSRF en mutaciones. |
| Emitir y revocar invitación | Además del control anterior, binding del mismo dispositivo; emisión auditable y un uso. |
| Registrar evidencia y activar identidad | Además del control anterior, claim y binding correspondientes; permanece código físico y excepción de atestación explícita para prueba sintética. |
| Revocar dispositivo | Capacidad y tenant antes de modificar estado, binding, invitación, clave o sesión; reintento autorizado sobre dispositivo ya revocado conserva respuesta idempotente. |
| Activar o retirar instalación GPS | Capacidad y acceso al tenant del binding o instalación; no se crea identidad de dispositivo en este paso. |

Los endpoints Android de claim, proof, sesión y PoP no cambian. Tampoco cambian las estructuras de respuesta, el orden de firmas ni las migraciones. OpenAPI aclara la condición administrativa de acceso.

## Evidencia sintética y límites

La suite de inscripción en PostgreSQL/PostGIS desechable cubre administrador con y sin capacidad, acceso a otro tenant, ausencia de grant, Origin/CSRF, invitación cancelada y vencida, claim concurrente de dos claves, prueba PoP inválida, código incorrecto, repetición, revocación durante claim, activación sin autorización y auditoría permitida/rechazada. `identity-edge.mjs` conserva límites de tiempo, reemisión, atestación inválida y carreras. `integration-smoke.mjs` recorre invitación → claim → proof → confirmación → sesión PoP → revocación. `gps-operations.integration.mjs` comprueba que la instalación no se activa ni retira sin acceso tenant y que un binding de otro tenant no puede reutilizarla.

Estas pruebas usan datos y claves sintéticos. No prueban la conducta en un teléfono, un MDM real, custodia humana, TLS de Staging ni la revisión independiente. El rate limit local de claim/proof sigue siendo por proceso; su eficacia detrás de varios procesos o proxy requiere validación operativa. El consentimiento, avisos Android, política horaria y permisos GPS siguen siendo gates separados.

## Modalidad MDM futura: requisitos, sin implementación

La presencia de un agente MDM no basta para auto confirmar. Antes de proponer ese cambio deben existir: identidad MDM verificada por canal servidor confiable, correspondencia inequívoca con registro y tenant autorizados, evidencia vinculada a la instalación y a su clave PoP cuando sea técnicamente posible, vigencia y revocación comprobadas al confirmar, protección contra replay y carrera, manejo de bindings conflictivos y ruta manual para evidencia insuficiente. Requiere revisión de amenazas, pruebas físicas multimarca y aprobación SDD/Seguridad. No se elige proveedor ni se altera ADR-014.
