# Wave 4B — protocolo de validación física pendiente

**Estado:** `PHYSICAL_VALIDATION = PENDING`. Este documento es un procedimiento para ejecutar **solo después** de autorización específica, acceso a los teléfonos y aprobación del entorno/datos de prueba. No se ejecutó desde esta rama.

## Preparación y trazabilidad

1. Registrar autorización, responsable, ventana, tenant de prueba, versión APK, identificador `geops_device.id`, instalación activa, estado y evidencia de inscripción MDM. No usar clientes reales.
2. Crear agente, cliente y sede sintéticos, geozona circular, ruta publicada, asignación diaria y jornada autorizada. Registrar IDs, revisiones, `snapshot_hash`, radio, permanencia y versión de algoritmo.
3. Vincular agente ↔ dispositivo con motivo, autor, `valid_from` y `valid_to` previstos. Verificar exclusión temporal y permisos. Si el dispositivo cambia, cerrar el vínculo anterior y abrir el nuevo; nunca reutilizar la identidad del agente como identidad del teléfono.
4. Correlacionar para cada posición: `device_id`, `installation_id`, `mdm_binding_id` si existe, `session_id`, `event_id`, `captured_at`, `received_at`, `batch_id`, ID/estado de ACK, asignación, evaluación e intervalo acreditado. Guardar evidencia con acceso restringido y período de conservación aprobado.

## Escenarios

| Escenario | Preparación | Observación obligatoria |
| --- | --- | --- |
| A: Xiaomi POCO, Android 16, sin MDM | Verificar por separado la ceremonia inicial de clave GEOPS en la APK, propiedad de tenant, instalación, política y sesión GPS sin ManageEngine. Backend admite clave previamente activa, probado solo con datos sintéticos; no se ha demostrado el aprovisionamiento inicial en POCO. | Captura, cola local, subida, ACK exacto, fila `position_event` con binding nulo, vínculo por `captured_at`, evaluación y evidencia. No iniciar hasta autorizar el ensayo físico y comprobar la ceremonia de clave. |
| B: Huawei P40 con ManageEngine | Confirmar inscripción MDM real, inventario, `mdm_binding`, instalación GEOPS y política autorizada. | Los mismos identificadores de extremo a extremo, incluyendo correspondencia del dispositivo externo MDM sin usarlo como agente. |
| Offline y sincronización tardía | Capturar antes y después del cambio agente A→B, aislar red, reconectar. | ACK por evento; evidencia recibida tarde sigue atribuyéndose al vínculo vigente en `captured_at`, no en `received_at`. |
| Reenvío y reinicio | Duplicar lote y reiniciar worker durante cola pendiente. | ACK/idempotencia GPS intactos; una sola atribución por evento; evaluación sin duplicar revisión si las fuentes no cambian; reintento recuperable. |
| Perímetro y huecos | Medir permanencia conocida dentro/fuera, bordes, precisión variable y pérdida de señal. | Comparar segundos acreditados con cronómetro y tolerancias aprobadas; registrar falsos positivos/negativos y muestras inciertas. |

## Secuencia de evidencia

Para cada visita registrar una cadena verificable:

`Android captura → almacenamiento local → envío → ACK exacto → position_event → agent_device_link vigente en captured_at → sesión GPS efectiva/programada → snapshot assignment_visit → visit_evaluation → visit_evaluation_interval`.

No sustituir IDs por contadores de pantalla. La lectura de coordenadas exige permiso y motivo auditado. Una muestra aislada, hueco prolongado o precisión insuficiente no demuestra permanencia. Si no hay vínculo inequívoco, el resultado esperado es `UNATTRIBUTABLE`; no concluir `NOT_VISITED`.

## Calibración y cierre

Medir precisión, cadencia efectiva, variación de perímetro, huecos, permanencia conocida y acreditada, y comportamiento offline en ambos teléfonos. Documentar modelo, versión Android, versión APK, entorno, hora y zona IANA, radio, parámetros, resultados observados y criterio de aceptación acordado. Proponer una **nueva** revisión `APPROVED` del algoritmo solo tras revisión de producto, GIS, privacidad y seguridad; no editar la revisión técnica existente.

Detener la prueba si el dispositivo no está autorizado, la captura vulnera la jornada, el ACK no corresponde a los eventos o se requiere un cambio remoto no aprobado. El cierre `WAVE4B_OPERATIONAL_PASS` requiere evidencia completa de ambos escenarios y aprobación de retención/calibración. Una ejecución parcial se informa por escenario, sin cerrar el estado operacional global.
