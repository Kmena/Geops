# W1-E1 Corte 2 — sesiones y posiciones sintéticas (2026-10-19)

**Estado: flujo HTTP/PostGIS sintético verificado; W1-E1 sigue BLOCKED para cierre.** Rama `codex/spec-02-wave-1`, HEAD inicial `d72cdb49d95915f8772ffcb6818698e4439c1a57`. Se preservaron los cambios heredados. No se usó GPS real, teléfonos, la PoC desplegada, ManageEngine ni bases compartidas; no hubo despliegue ni operaciones Git de publicación.

## Contrato implementado

| Ruta | Control | Resultado |
| --- | --- | --- |
| `POST /v1/device/gps-session-events/batches` | Sesión de dispositivo SPEC-01 y PoP por cuerpo exacto/nonce, identidad canónica, instalación/vínculo activo, lote 1–100 y 128 KiB. | `200` ACK solo tras COMMIT, `202` dependencia sin ACK, `409` conflicto, `410` expirado, `413`, `422`, `429`; revocación rechaza incluso duplicados. |
| `POST /v1/device/locations/batches` | Mismos controles; 256 KiB, latitud/longitud, precisión, UTC, ancla/boot, revisión y ventana programada. | PostGIS `geography(Point,4326)` asociado a instalación, tenant y sesión canónica. Rechaza capturas fuera de ventana, durante interrupción o posteriores al fin. |
| `GET /v1/admin/devices/{device_id}/gps-sessions` | Cookie administrativa, `gps.session.read`, concesión tenant explícita. | Ventanas programadas separadas de sesiones efectivas; `MISSED_START`, interrupciones y `UNKNOWN_END` distinguibles. Cursor y límite. |
| `GET /v1/admin/devices/{device_id}/locations` | Cookie, `gps.location.read`, concesión tenant, motivo de 8–240 caracteres, intervalo UTC máximo 24 h. | Historial limitado, filtrado por tenant y auditado; no se incluyen coordenadas en el log de auditoría. |

`START_ATTEMPT` y `MISSED_START` son diagnósticos, nunca prueba de inicio. `STARTED` vincula `client_session_id` a un UUID canónico del servidor. `STOPPED` conserva hora reportada; un nuevo inicio/revisión puede marcar el anterior `UNKNOWN_END` sin inventar `stopped_at`. Eventos atrasados se validan contra la ventana y ancla de la captura original. Un evento cuyo inicio aún no llegó queda cifrado en cuarentena y recibe `202`; **la reconciliación requiere reintento del agente**, no hay reprocesador autónomo. La dependencia vence a los siete días: se borra ciphertext, queda una huella de rechazo hasta 90 días y el reintento recibe `410`. Los ACKs de lote conservan digest e IDs; mismo lote distinto contenido o mismo evento distinto contenido produce `409`.

## Persistencia y controles

[Migración 0012](../../apps/api/src/db/migrations/0012_gps_events.sql) añade tenant/binding/boot/ancla a sesiones y eventos, tenant/instalación a posiciones, FKs compuestas, índices de tenant/tiempo, recibos idempotentes, cuota de seis solicitudes por dispositivo/tipo/minuto y cuarentena cifrada AES-256-GCM. Se conserva el índice GiST PostGIS de 0009. La clave `GEOPS_GPS_QUARANTINE_KEY` es específica y obligatoria en el entorno sintético; su custodia/rotación operativa está pendiente. La concesión `gps_data_tenant_access` deniega por defecto y fue creada manualmente **solo como fixture**; falta el flujo de doble control y revocación operativa. La migración requiere revisar/backfill de filas preexistentes antes de cualquier uso fuera de una base sintética vacía.

`purgeExpired()` aplica 90 días a posiciones y recibos, limpia cuotas vencidas y ciphertext de dependencias expiradas; se invocó en prueba, **no está programado**. El servidor rechaza otro tenant/binding al transferir un teléfono y vuelve a comprobar identidad y PoP antes de responder a reintentos. El cuerpo declara `device_id`, pero nunca lo usa como autoridad. El escaneo de secretos pasa; la revisión de seguridad independiente sigue abierta.

## Evidencia ejecutada

- PostgreSQL/PostGIS **desechable** `geops_verify_20261019`, migraciones 0001–0012. `gps:events:integration`: **67 aserciones**; política → publicación/asignación → configuración PoP → sesión efectiva → posición simulada → COMMIT/ACK → consulta autorizada. Incluye inicio adelantado, `202` y reintento, duplicados, concurrencia, rollback atómico de lote, revocación, replay de nonce, tenant, horario, cambio de revisión, `UNKNOWN_END`, cuota, tamaño y purga. Regresiones W1-B 44, configuración 24, salud 37.
- Backup `pg_dump` y restore a otra base **dentro del mismo contenedor desechable**: recuentos origen/restaurado idénticos, 12 migraciones, 3 sesiones efectivas, 7 eventos de sesión, 3 posiciones, 12 recibos, 1 cuarentena. `ALTER TABLE` seguido de `ROLLBACK` dejó cero columnas de prueba. No valida backups de producción ni restauración de claves.
- API build/typecheck, pruebas Node 18+12, contratos OpenAPI, lint y escaneo de secretos pasan. Lint conserva 12 advertencias heredadas en W1-B. `git diff --check` pasa con avisos de conversión CRLF, sin errores de espacios.
- Kotlin JVM compiló y pasó 14 pruebas del motor, más un test que consumió los **ACK y 202 exactos del backend**: buffer de sesión/posición, pendiente sin borrar, reintento y eliminación tras ACK. El transporte del agente es simulado; no se compiló APK de producto ni se probó PoP HTTP desde Android físico.

## Gates para completar W1-E1

Permanecen **BLOCKED** el scheduler que repone ventanas, vence asignaciones y ejecuta purga; activación de instalación/PoP y concesiones tenant operativas; integración Web E2E con navegador y autorización real; revisión independiente de seguridad/privacidad; carga y retención/backup operativos. W1-E2 y cualquier dispositivo físico siguen bloqueados. Este corte permite continuar el scheduler y el cableado Web sintético, sin declarar operación lista.
