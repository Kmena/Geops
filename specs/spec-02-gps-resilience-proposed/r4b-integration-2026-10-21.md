# R4-B — integración de alertas de continuidad GPS

**Estado:** `CONDITIONAL_PASS` sintético en `codex/geops-integration`; no hay prueba física, revisión independiente ni despliegue. Baseline auditado: merge `5339b811bc2b62274b669ab60ae055718216b6a7`, árbol limpio antes de R4-B. El frontend dejó de editarse en paralelo. R1–R4-A y la regla de captura limitada a la ventana autorizada se conservaron; R4-B no modifica Android ni la aceptación histórica de posiciones.

## Decisión contractual GPS-CONTINUITY-001

Se adoptó la ruta aditiva `GET /v1/admin/gps-continuity/alerts` con `schema_version:1`, sin modificar `/v1/admin/gps-alerts`, `AlertList` ni GPS-HEALTH-001. Las dos copias OpenAPI permanecen idénticas. El acceso requiere sesión administrativa, `gps.session.read`, `gps.location.read`, concesiones vigentes de datos **y** salud para el tenant, y `X-GEOPS-Access-Reason` de 8–240 caracteres. Un `device_id` de otro tenant responde 404 sin revelar su existencia; 403 cubre falta de capacidades/concesiones. La lectura se audita y se sirve con `Cache-Control:no-store` y `Vary:Cookie`.

Filtros: `device_id`, `status=OPEN|RESOLVED|ALL`, `severity`, `reason_code`, `opened_from`, `opened_before`, `limit` y `cursor`. El histórico exige ambos límites UTC, intervalo `[from,before)` no mayor de 90 días. `limit` es 1–100 (predeterminado 25). Orden estable `(opened_at DESC,id DESC)`. El cursor HMAC expira a los 15 minutos, se vincula al administrador y filtros, y **no** concede acceso: cada página vuelve a comprobar capacidades y tenants. Límite: 60 lecturas/minuto por administrador, con `429` y `Retry-After:60`. Los contadores de cuota se borran tras 24 horas.

`observed` separa el estado declarado por Android y las horas de recepción; `inference` identifica la deducción del servidor, evidencia, antigüedad, umbral y última evaluación. No se exponen coordenadas, tenant, binding, instalación, tokens ni supuesto ACK del teléfono. `COMMUNICATION_MISSING` no diagnostica Internet, batería, GPS ni cierre de la app. Los timestamps HTTP son UTC; Web los presenta en la zona elegida.

**Desviación justificada del borrador contractual:** R4-A ya persistía `resolved_at`; el problema era que `updated_at` pasaba a ser hora de resolución y dejaba de representar la última inferencia. La migración 0017 agrega `evaluated_at` independiente. Para filas previas a 0017, el valor queda `null` porque no existe fuente fiable para reconstruirlo; la Web muestra “No disponible”. En registros nuevos y reevaluados es un timestamp UTC. `updated_at` significa última modificación del episodio (evaluación o resolución), `resolved_at` la resolución real. El esquema v1 declara `evaluated_at` requerido pero nullable para no inventar historia.

## Persistencia y visualización

La migración 0017 añade columna, índice de paginación y cuota de lectura. No altera 0016 ni purga alertas. El monitor registra `evaluated_at` al abrir o reevaluar; al resolver solo actualiza `resolved_at`/`updated_at`. La Web consulta una página global de alertas abiertas, luego páginas del dispositivo seleccionado e historial detectado en los últimos 30 días. Muestra severidad, motivo, evidencia y hora de evaluación, conserva la fuente observada por separado y permite filtrar severidad y paginar. Una lista vacía **no** significa salud: “actividad reciente observada” exige ventana programada, captura reciente y telemetría reciente observada directamente por Android con servicio `RUNNING`; fuera de horario se indica explícitamente. La UI diferencia 401, 403, 404 de ruta antigua, 404 de dispositivo, 429, error de red y respuesta inválida.

## Verificación sintética

| Prueba | Resultado |
| --- | --- |
| Migración 0016→0017 en PostGIS descartable, alerta resuelta preexistente, checksums/readiness e idempotencia | PASS; `resolved_at`/`updated_at` conservados y `evaluated_at` anterior desconocido. |
| Monitor/API PostGIS: autenticación, capacidades, tenant, revocación, historial, orden/cursor, 429, 25 dispositivos sintéticos | PASS, 44 aserciones. |
| Web: modelo de estados, contrato de cliente, compatibilidad 404, permisos y regresiones existentes | PASS, 46 pruebas. |
| API: inferencia y regresiones enfocadas | PASS, 21 pruebas. |
| OpenAPI, typecheck, build API/Web, escaneo de secretos y diff check | PASS local. |
| Browser E2E responsive/accesibilidad, carga sostenida y teléfono físico | PENDIENTE; no se infiere PASS de pruebas unitarias. |

## Gates y privacidad

- **Retención:** abiertas hasta resolución y resueltas 90 días siguen siendo propuestas sujetas a Seguridad/Privacidad. No se implementó eliminación irreversible. La política del historial de posiciones de 90 días no cambió.
- **Diario Android:** 24 horas/256 eventos limita lecturas/escrituras, pero la eliminación física de un archivo cifrado no tocado más de 24 horas requiere decisión y prueba aparte. R4-B no cambia Android.
- **Umbrales:** aviso 5 min, crítico 10 min y períodos de gracia son configurables, todavía provisionales. Validar falsos positivos, Doze, sincronización diferida y dos teléfonos de fabricantes distintos.
- **Release:** 0017 es aditiva, pero el comprobador de migraciones exige manifest exacto; una imagen API anterior no es rollback compatible tras migrar. Preparar upgrade supervisado con gate cerrado y ensayo de recuperación antes de Staging. Ninguna migración se aplicó allí.
- **Seguridad:** revisar independientemente permisos duales, motivo fijo auditable, metadatos temporales, cursor, cuota, retención y UI. No autorizar operación real por esta evidencia sintética.
