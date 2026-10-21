# GPS-CONTINUITY-001 — coordinación contractual API/Web (propuesta)

**Estado: PROPOSED, pendiente de aprobación API/Web/Seguridad/Privacidad.** R4-A fue aceptada como `CONDITIONAL_PASS` sintético. Este documento no aprueba R4-B, no publica una ruta HTTP, no cambia OpenAPI y no modifica Web. Corte de lectura: worktree `codex/gps-resilience` en `c27f656c71a82eee31e2bf281bb98eaf473be067` más cambios locales R1–R4-A; checkout principal `codex/spec-02-wave-1` en `c230a87361cf7a55a7605d2d6325ce03d7103988` con cambios Android/documentales sin confirmar. El estado del frontend es mutable y debe comprobarse de nuevo antes de integrar.

## Hallazgo contractual y decisión propuesta

El OpenAPI del worktree y el del HEAD principal actual declaran `GET /v1/admin/gps-alerts` y `AlertList` con la misma forma relevante, pero no hay ruta implementada. `AlertList` solo requiere `items`/`next_cursor`; el motivo de cada ítem admite `COMMUNICATION_MISSING|UNKNOWN` y no define severidad, origen, resolución ni horas de evidencia. R4-A persiste `CAPTURE_STALE|COMMUNICATION_MISSING`, `WARNING|CRITICAL` y `source=SERVER_INFERENCE`. Extender el enum del endpoint dibujado podría romper consumidores estrictos. **Proponer una ruta aditiva distinta:**

`GET /v1/admin/gps-continuity/alerts` → `GpsContinuityAlertListV1` (`schema_version: 1`).

Mantener `/v1/admin/gps-alerts`, `AlertList`, `GPS-HEALTH-001`, `/v1/admin/devices/{id}/health` y todos sus enums/respuestas sin cambio. El nuevo nombre y el esquema versionado están sujetos a conformidad del responsable Web. No reutilizar `UNKNOWN` como supuesto motivo de R4-A: si no hay evidencia suficiente durante gracia, no hay alerta.

| Campo en `AlertList` de diseño | Necesidad R4-A | Resolución aditiva propuesta |
| --- | --- | --- |
| `items[].device_id` | Dispositivo del episodio | Conservar UUID y añadir `alert_id`/`scheduled_session_id`; no exponer binding. |
| `items[].reason_code` (`COMMUNICATION_MISSING|UNKNOWN`) | También `CAPTURE_STALE` | Enum nuevo solo en `GpsContinuityAlertListV1`; no cambiar el existente. |
| `items[].last_received_at` | Separar recepción de posición y de salud, además de hora original de captura/observación | Objeto `observed`; no colapsar cuatro marcas en una sola. |
| `items`, `next_cursor` | Estado, severidad, fuente, evidencia, umbral, resolución, paginación filtrada | Mantener nombres de envoltorio, añadir `schema_version:1` y tipo de ítem nuevo. |

En el checkout principal actual, la pantalla `/gps/devices` usa `GpsDeviceWorkspace.tsx`: ya solicita capacidades, sesiones y salud por dispositivo, y posiciones solo con `gps.location.read`. No llama alertas de continuidad. El archivo y su flujo pertenecen al trabajo Web activo.

## Solicitud y seguridad propuesta

| Elemento | Semántica v1 propuesta |
| --- | --- |
| Autenticación | Sesión administrativa SPEC-01 vigente, mismo origen HTTPS; ninguna ruta anónima ni cookie de dispositivo. |
| Capacidad | `gps.session.read` **y** `gps.location.read`, como la lectura interna actual; ambos `gps_data_tenant_access` y `gps_health_tenant_access` vigentes por tenant. Requiere revisión de Seguridad por sensibilidad de horas de captura. |
| Motivo | Cabecera `X-GEOPS-Access-Reason`, 8–240 caracteres, nunca query string. Para revisión operativa normal, Web podría enviar un motivo fijo claro y visible en auditoría, sujeto a aprobación de Privacidad; no pedir texto hexadecimal o técnico al operador. |
| Aislamiento | Tenant derivado de concesiones vigentes del administrador; ningún `tenant_id` de cliente selecciona autoridad. El filtro `device_id` solo devuelve dispositivos dentro de esas concesiones. La respuesta omite `tenant_id`, `installation_id`, binding, coordenadas y diagnósticos locales. |
| Auditoría | Registrar lectura permitida/denegada, actor, hora, request ID, motivo, filtros y número de resultados; nunca coordenadas, tokens, cookies ni payload completo. `Cache-Control: no-store`, `Vary: Cookie`, límites de tasa. |
| Errores | `401` sesión ausente; `403` capacidad/concesión insuficiente; `404` dispositivo inexistente o no visible con `device_id` filtrado; `422` filtro, motivo o cursor inválido; `429` cuota con `Retry-After`; `503` gate/servicio no disponible. Un `403` nunca se presenta como “sin alertas”. |

Filtros opcionales: `device_id` UUID; `status=OPEN|RESOLVED|ALL` (predeterminado `OPEN`); `severity=WARNING|CRITICAL`; `reason_code=CAPTURE_STALE|COMMUNICATION_MISSING`; `opened_from` y `opened_before` RFC 3339 UTC, con intervalo `[from,before)` y ambos límites obligatorios cuando se consulte histórico `RESOLVED`/`ALL`. Rechazar rangos invertidos y consultas históricas sin límite temporal. `limit` entero 1–100, predeterminado 25; `cursor` opaco de longitud acotada. Orden estable `(opened_at DESC, alert_id DESC)`; `next_cursor` es `null` al terminar. El cursor debe vincular filtros y alcance autorizado, tener expiración y verificarse contra concesiones actuales en cada página; cambios concurrentes de estado pueden requerir refrescar desde la primera página. La especificación precisa de caducidad y ventana máxima de histórico queda pendiente de API/Privacidad. No usar cursor como credencial.

## Esquema de respuesta v1 propuesto

`GpsContinuityAlertListV1` exige `schema_version` (entero constante `1`), `items` (array) y `next_cursor` (string opaco o `null`). En v1, todos los campos enumerados de la envoltura, ítem y objetos anidados son obligatorios; los desconocidos llevan `null`, nunca se omiten. El esquema de respuesta cierra claves adicionales (`additionalProperties: false`) y una ampliación incompatible exige otra versión. Cada ítem exige:

| Campo | Tipo y significado |
| --- | --- |
| `alert_id`, `device_id`, `scheduled_session_id` | UUID. Identifican episodio, dispositivo y ventana programada; la ventana **no** prueba una sesión efectiva. |
| `status` | `OPEN|RESOLVED`, derivado de `resolved_at`. |
| `reason_code` | `CAPTURE_STALE|COMMUNICATION_MISSING`. Es inferencia, nunca diagnóstico causal. |
| `severity` | `WARNING|CRITICAL`, última evaluación almacenada; no reinterpretar como estado observado del teléfono. |
| `source` | Constante `SERVER_INFERENCE`. |
| `observed` | Objeto separado: `tracking_state: RUNNING|STOPPED|null`, `last_position_captured_at`, `last_position_received_at`, `last_health_observed_at`, `last_health_received_at` (todas RFC 3339 UTC o `null`). Son máximos por dimensión, no necesariamente del mismo evento. `tracking_state` es el último declarado en salud y puede estar anticuado. |
| `inference` | Objeto: `evidence_at: timestamp|null`, `age_s: integer>=0`, `threshold_s: integer>0`, `evaluated_at: timestamp`. `age_s` se calcula **en** `evaluated_at`; no es un cronómetro en vivo. `evidence_at=null` significa que se usó el inicio de ventana como base, no que se observó un evento. Para `COMMUNICATION_MISSING`, la evidencia de comunicación puede ser posición, salud, sesión o descarga de configuración autenticada. |
| `opened_at`, `updated_at` | RFC 3339 UTC. `updated_at` es la última evaluación persistida del episodio. |
| `resolved_at` | RFC 3339 UTC o `null`. |
| `resolution_reason` | `EVIDENCE_RECOVERED|WINDOW_ENDED|POLICY_CHANGED|DEVICE_INACTIVE|INSTALLATION_CHANGED|null`; `null` si `OPEN`. |

No exponer `last_batch_persisted_at` como ACK conocido: R4-A lo guarda `null` porque la persistencia del servidor no demuestra que Android recibió el ACK, y `gps_sync_status.last_ack_at` no tiene procedencia suficiente por tenant/instalación. Tampoco exponer `last_ack_known_at` hasta instrumentar evidencia atribuible del cliente. No añadir `ONLINE`, “GPS apagado”, “sin Internet” o “app cerrada” como inferencias. Si se desea última comunicación explícita o estado de gracia en esta respuesta, R4-B debe definir fuente/consulta adicional y volver a revisar contrato; no sintetizarlo desde `last_health_received_at` porque una descarga de configuración o evento de sesión también cuenta como comunicación.

**Brecha de esquema/consulta que debe resolverse en R4-B:** `gps_continuity_alert.updated_at` cambia al resolver, mientras `age_s` y `threshold_s` conservan la última evaluación; por ello no puede utilizarse como `inference.evaluated_at` en alertas resueltas. R4-A tampoco devuelve `resolution_reason` en `listForAdmin` y solo lista alertas abiertas, sin filtros ni cursor. El contrato propuesto requiere preservar la hora de la última inferencia (probable migración incremental o una derivación demostrablemente exacta), ampliar la lectura autorizada y probar historial. No afirmar que estos campos ya están disponibles por HTTP.

`null` distingue desconocido de cero y de `STOPPED`. Todas las horas de respuesta son UTC con sufijo `Z`; Web convierte a zona local solo para mostrar. La forma de error no especial conserva el sobre actual de la API, por ejemplo `{"error":{"code":"gps_forbidden","message":"Forbidden","request_id":"req-sintetico"}}` para un `403`; no incluir detalles del tenant o dispositivo denegado. El código concreto por error y el identificador real se fijan en OpenAPI aprobado antes de implementar el handler.

### Ejemplo A: alerta abierta con telemetría reciente y captura estancada

```json
{
  "schema_version": 1,
  "items": [
    {
      "alert_id": "11111111-1111-4111-8111-111111111111",
      "device_id": "22222222-2222-4222-8222-222222222222",
      "scheduled_session_id": "33333333-3333-4333-8333-333333333333",
      "status": "OPEN",
      "reason_code": "CAPTURE_STALE",
      "severity": "WARNING",
      "source": "SERVER_INFERENCE",
      "observed": {
        "tracking_state": "RUNNING",
        "last_position_captured_at": "2026-10-20T14:00:00Z",
        "last_position_received_at": "2026-10-20T14:00:10Z",
        "last_health_observed_at": "2026-10-20T14:05:00Z",
        "last_health_received_at": "2026-10-20T14:05:02Z"
      },
      "inference": {
        "evidence_at": "2026-10-20T14:00:00Z",
        "age_s": 360,
        "threshold_s": 300,
        "evaluated_at": "2026-10-20T14:06:00Z"
      },
      "opened_at": "2026-10-20T14:05:00Z",
      "updated_at": "2026-10-20T14:06:00Z",
      "resolved_at": null,
      "resolution_reason": null
    }
  ],
  "next_cursor": null
}
```

### Ejemplo B: episodio resuelto por fin de ventana, sin evidencia de comunicación

```json
{
  "schema_version": 1,
  "items": [
    {
      "alert_id": "44444444-4444-4444-8444-444444444444",
      "device_id": "22222222-2222-4222-8222-222222222222",
      "scheduled_session_id": "55555555-5555-4555-8555-555555555555",
      "status": "RESOLVED",
      "reason_code": "COMMUNICATION_MISSING",
      "severity": "CRITICAL",
      "source": "SERVER_INFERENCE",
      "observed": {
        "tracking_state": null,
        "last_position_captured_at": null,
        "last_position_received_at": null,
        "last_health_observed_at": null,
        "last_health_received_at": null
      },
      "inference": {
        "evidence_at": null,
        "age_s": 600,
        "threshold_s": 600,
        "evaluated_at": "2026-10-20T16:59:00Z"
      },
      "opened_at": "2026-10-20T16:54:00Z",
      "updated_at": "2026-10-20T17:00:00Z",
      "resolved_at": "2026-10-20T17:00:00Z",
      "resolution_reason": "WINDOW_ENDED"
    }
  ],
  "next_cursor": null
}
```

Los UUID y horarios de ambos ejemplos son sintéticos. La combinación de tiempos del ejemplo B ilustra un snapshot de decisión, no una traza real. Una lista vacía válida usa `{"schema_version":1,"items":[],"next_cursor":null}`; no equivale a “seguimiento sano” fuera de una ventana autorizada ni durante una gracia.

## Matriz de compatibilidad

| Consumidor / servidor | Resultado esperado |
| --- | --- |
| Web actual / API actual | Usa salud, sesiones y posiciones existentes. No solicita continuidad; sin cambio. |
| Web actual / API con ruta nueva | Ignora la ruta; `GPS-HEALTH-001` y `AlertList` existentes conservan forma y enums. |
| Web nueva / API anterior | Sondear primero la lista **sin** `device_id`. Bajo el contrato propuesto, un `404` de esa solicitud significa ruta ausente y muestra “Alertas aún no disponibles”, conservando salud existente. Después de un 200 de descubrimiento, un `404` con `device_id` es dispositivo inexistente/no visible. `401`, `403`, `429`, `503` y red conservan sus estados propios; nunca traducirlos a “sin alertas”. Probar este supuesto de enrutamiento en API y proxy antes de utilizarlo. |
| Web nueva / API nueva | Valida `schema_version=1`, enums y `null`; separa observado/inferido; pagina y refresca sin convertir alertas resueltas en estado actual. |
| Android anterior o nuevo / API nueva | Sin cambio en `GPS-HEALTH-001`, sesión, posiciones, PoP ni aceptación histórica; esta ruta es solo administrativa. |

## Retención y privacidad: validación de propuesta

| Dato | Estado de código y propuesta | Condición antes de uso operativo |
| --- | --- | --- |
| Alertas `OPEN` | R4-A no implementa purga. Propuesta: conservar hasta resolución; las ventanas terminadas, cambios de política o inactividad deben resolverlas incluso tras reinicio. | Probar barrido y fallos del scheduler para evitar alertas abiertas indefinidamente. Definir tratamiento de pérdida de identidad/binding, eliminación solicitada y límite excepcional; no borrar alertas abiertas por un TTL ciego. |
| Alertas `RESOLVED` | R4-A no implementa purga. Propuesta: 90 días **desde `resolved_at`**. | Aprobar por Privacidad/Seguridad, implementar purga acotada, auditar conteos, probar índices, reintentos y backups. La auditoría tiene régimen separado y no debe eliminarse por la misma consulta sin decisión. |
| Diagnósticos Android | R1 cifra un diario local en directorio privado excluido de backup; filtra 24 h y limita a 256 eventos/128 KiB. | El filtrado de 24 h ocurre al leer/escribir; puede quedar un archivo cifrado sin tocar más de 24 h. Si el límite es eliminación física estricta a las 24 h, requiere mecanismo de borrado/reclave adicional y prueba Android. No enviar diario crudo al backend por este contrato. |
| Posiciones y salud GPS | Los servicios existentes purgan tras 90 días (`position_event.captured_at` y salud `observed_at`); no se propone extensión. | Validar cadencia de purga, réplicas/backup y que alertas no reconstruyan trayectorias. Conservar solo horas de evidencia, nunca coordenadas. |

Las marcas de captura, recepción y comunicación pueden revelar hábitos laborales aunque no contengan coordenadas. La propuesta exige minimización, acceso limitado, auditoría, respuesta sin caché y aprobación de retención. Los valores 300/600 s y las gracias son **provisionales**, no SLO. Validar contra `health_interval_s`, sincronización diferida, Doze y dos Android reales para evitar falsos positivos. Una alerta de comunicación ausente no prueba que el equipo dejó de capturar offline.

## Dependencias concretas de la pantalla de dispositivos

1. En `GpsDeviceWorkspace.tsx`, unir alertas por `device_id` con el nombre ya obtenido por inventario; no mostrar UUID como etiqueta principal ni pedir hexadecimal. Consultar `status=OPEN&device_id=...` solo si ambas capacidades y concesiones están confirmadas.
2. Mostrar un rótulo como “Posiciones sin actualizar” o “Sin comunicación reciente” con “inferido por servidor”, severidad, hora de evaluación y última evidencia conocida; mostrar `tracking_state` en bloque “Observado por dispositivo” con su hora. No mezclar `STOPPED` observado con causa inferida.
3. Durante gracia o fuera de horario, ausencia de alerta es “sin evaluación aplicable” si esa información de ventana se conoce; no pintar verde por lista vacía. El endpoint de alertas por sí solo no devuelve una evaluación saludable ni la ventana actual.
4. Errores de permisos, endpoint no disponible, red y lista vacía tienen estados visuales distintos. Si el acceso no cumple `gps.location.read`, mantener la vista de salud que ya permite `gps.session.read`, sin revelar horas de captura de alerta.
5. El panel puede refrescar bajo demanda o con sondeo acotado; no duplicar alertas por episodio. Para una vista de flota consultar una página global filtrada por concesiones, no hacer 25 consultas por dispositivo. No incluir coordenadas en tarjetas/alertas.

## Decisiones pendientes y secuencia R4-B recomendada

| Decisión | Estado | Responsable/gate |
| --- | --- | --- |
| Ruta y forma `GpsContinuityAlertListV1` | **CONDITIONAL** | API + responsable Web aprueban path, campos, enum, límites y vectores viejo/nuevo. Después se edita OpenAPI en cambio separado. |
| Capacidad dual y motivo fijo operativo | **CONDITIONAL** | Seguridad/Privacidad validan minimización y razón auditada. Si cambia permiso, actualizar servicio interno y pruebas antes de exponer ruta. |
| Retención de alertas resueltas 90 días y abiertas hasta resolución | **CONDITIONAL** | Privacidad/Seguridad aprueban período, borrado, backups y auditoría; luego implementar purga/test de recuperación. |
| Diagnóstico local 24 h/256 eventos como límite legal/operativo | **CONDITIONAL** | Privacidad confirma si filtro diferido basta o exige eliminación física programada. |
| Umbrales 5/10 minutos y gracias | **CONDITIONAL** | Operación/QA miden cadencia real y falsos positivos; parametrización ya existe en R4-A, ruta de edición no propuesta aquí. |
| Último ACK conocido | **BLOCKED** | Falta evidencia cliente atribuible a tenant/instalación; no convertir `last_batch_persisted_at` en ACK. |
| Inicio diario automático/MDM/permiso background | **BLOCKED** | Estudio MDM y autorización separados; fuera de R4-B. |

Tras aprobación contractual: (1) congelar SHA/diff del frontend y verificar ownership; (2) añadir OpenAPI aditivo y pruebas de contrato sin tocar `AlertList`; (3) adaptar lectura backend de R4-A con filtros, cursor, control de acceso y auditoría; (4) implementar purga aprobada de resueltas; (5) entregar fixtures y pruebas de estados al frontend en su rama; (6) ejecutar PostGIS descartable, tests de autorización/paginación/retención, E2E viejo/nuevo, carga de 25 dispositivos y revisión independiente. **No empezar R4-B ni Web por este documento.**

### Instrucciones de coordinación para el responsable frontend

Compartir este documento como propuesta, junto al SHA/base y el OpenAPI actual. Pedir una revisión escrita de `path`, tipos, enums, filtros, permisos, `schema_version`, estados 401/403/404/429/503, razón de acceso y tratamiento de lista vacía. Solicitar que señale contratos Web ya en curso y archivos bajo su propiedad; no integrar copias parciales ni resolver conflictos con `ours/theirs`. Una vez aprobado el delta API/Web/Seguridad, coordinar commits separados de contrato, API y Web y probar ambas direcciones de compatibilidad. Esta tarea no envía mensajes a otra conversación ni altera su checkout.
