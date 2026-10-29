# B32 — cobertura GPS, calibración y preparación de promoción

Fecha: 2026-10-29. Base: `codex/b32-staging-promotion`, commit previo `9421a79`.
No se consultó ni modificó staging ni producción; las únicas bases usadas fueron PostGIS desechables.

## Decisiones y alcance de la revisión

- `DEC-VISIT-001` aprobó permanencia **acumulada** dentro de la ventana: los intervalos válidos se suman y una sola posición acredita cero. El mínimo de 600 s del caso procede del snapshot `assignment_visit.min_dwell_effective_s` y puede variar por visita.
- `DEC-VISIT-002` aprobó incumplimiento condicionado a cobertura. Cobertura porcentual sola nunca basta. La nueva revisión 3 de `dwell-pair-v1` registra ambas decisiones, `default_required_s=600`, modo `ACCUMULATED`, política `POTENTIAL_INSIDE`, fecha de activación nula, evidencia de calibración nula y scope `TECHNICAL_ONLY`.
- Los parámetros de cobertura de la revisión 3 son `coverage_min_fraction=null` y `non_compliance_enabled=false`. Se mantienen los parámetros técnicos heredados (`max_gap_s=300`, `credit_cap_s=300`, `max_accuracy_m=25`, `boundary_tolerance_m=0`, `max_speed_m_s=50`, `uncertainty_guard_s=0`) **sin afirmar calibración de campo**. No se insertó ninguna revisión `APPROVED` en datos reales.
- El scheduler y la acción manual solo consideran una revisión `APPROVED` con referencia de calibración y `activated_at` vigente. Esto es un control técnico de presencia; la revisión humana de la evidencia sigue siendo obligatoria.

## Invariantes del cálculo

Sea `W` la duración observada de la ventana en segundos, `I` el tiempo acreditado dentro, `O` el tiempo acreditado fuera y `U = W - I - O` el tiempo desconocido. Se exige `I≥0`, `O≥0`, `U≥0`, `I+O+U=W`; los intervalos acreditados no se solapan ni exceden la ventana. `I` suma pares interiores consecutivos, acotados por cadencia, precisión, identidad, sesión, barreras, velocidad y cap. Huecos, posiciones aisladas y pares inciertos permanecen en `U`.

Dos capturas fuera no certifican todo el trayecto intermedio. Para cada extremo se calcula la distancia mínima al borde después de restar precisión y tolerancia. Dividirla por el límite de velocidad produce el tramo inicial o final que físicamente no podría haber alcanzado la geozona; solo esos tramos se agregan a `O`. Esta cota depende de un límite de velocidad físicamente válido, aún pendiente de calibración. `P = I + U` es el máximo conservador que podría haberse pasado dentro. La decisión es:

1. `I ≥ required_s` → `COMPLIANT` (`COMPLETED` en el contrato existente).
2. Tras cierre, política numérica activada, cobertura `(I+O)/W` al menos el umbral **y** `P < required_s` → `NON_COMPLIANT` (`INCOMPLETE` en el contrato existente).
3. En otro caso → `INSUFFICIENT_EVIDENCE`; antes/durante la ventana → `PENDING`/`IN_PROGRESS`. Los fallos técnicos permanecen en el estado `FAILED` del job y se muestran como error de procesamiento.

La migración aditiva `0033_visit_coverage_calibration.sql` conserva las 32 anteriores, añade métricas nulas para evaluaciones antiguas y referencias inmutables de intervalos acreditados fuera. La lectura auditada de evidencia expone esos intervalos y los identificadores de sus eventos sin copiar coordenadas. El snapshot histórico sigue siendo la geozona aplicada; la actual se muestra solo como comparación. Las líneas de mapa entre capturas son punteadas y se describen como conexiones visuales, no recorrido observado. El mapa enumera los huecos de más de cinco minutos y cambios de sesión dentro de la ventana autorizada.

## Calibración reproducible

Herramienta: `node --import tsx apps/api/scripts/calibrate-visits.ts input.json`. El JSON incluye casos con `source=FIELD|SYNTHETIC`, `truth`, `truth_reference`, snapshot, muestras GPS completas, barreras y configuraciones candidatas. La salida reporta distribución p50/p95 de cadencia, precisión y retraso de recepción; duplicados; matriz por candidato, errores de clasificación e indeterminados. No selecciona ni aprueba un umbral automáticamente.

Demostración: `node --import tsx apps/api/scripts/calibrate-visits.ts --synthetic-demo`:

| Configuración explorada | Casos reales | Casos sintéticos | Falsos cumplimientos | Falsos incumplimientos | Indeterminados |
| --- | ---: | ---: | ---: | ---: | ---: |
| Conservadora, incumplimiento deshabilitado | 0 | 2 | 0 | 0 | 1 |
| 90 % exploratorio, **no aprobado** | 0 | 2 | 0 | 0 | 0 |

La demostración utilizó 63 posiciones sintéticas; p50/p95 de intervalo 60 s, precisión 5 m, retraso 60 s. En la visita sintética exterior, `I=0`, `O=3540`, `U=60`, cobertura 98,33 % y `P=60 < 600`. Las métricas de falsos positivos/negativos sintéticos no predicen rendimiento en campo.

El agente Android acepta `captureIntervalS` entre 30 y 300 s (`PolicyEngine.kt`), registra la cadencia configurada mediante `TrackingController.kt`, y `gps-policy-service.ts` usa 60 s como valor inicial. Eso es objetivo de captura, no garantía. Falta un conjunto real etiquetado con entradas/salidas verificadas, precisión cerca del borde, interrupciones, reinicios, duplicados y retrasos de sincronización. Hasta entonces `CALIBRATION_STATUS=FIELD_EVIDENCE_MISSING` y no se habilita incumplimiento automático.

## Caso del 28/10/2026 — consultas de solo lectura

Ejecutar únicamente con autorización de lectura, tenant conocido y cliente SQL con parámetros enlazados. Las consultas siguientes usan variables de `psql`; establecer `tenant_id`, `assignment_id` y `stop_id` antes de cada paso. Iniciar `BEGIN READ ONLY; SET LOCAL statement_timeout='10s';` y terminar con `ROLLBACK;`.

```sql
SELECT a.id AS assignment_id,v.stop_id,a.agent_id,a.agent_name,a.route_name,
       a.starts_at,a.ends_at,a.time_zone,v.client_name,v.site_id,v.site_name,
       v.geofence_revision,v.latitude,v.longitude,
       v.radius_m,v.min_dwell_effective_s
FROM route_assignment a JOIN assignment_visit v
  ON v.tenant_id=a.tenant_id AND v.assignment_id=a.id
WHERE a.tenant_id=:'tenant_id' AND a.local_date=DATE '2026-10-28'
  AND a.agent_name ILIKE '%Paco%' AND v.site_name ILIKE '%Sede principal%';

SELECT j.state,j.algorithm_id,j.algorithm_revision,j.attempts,j.last_error_code,
       j.requested_at,j.started_at,j.finished_at,e.id AS evaluation_id,
       e.status,e.credited_s,e.outside_credited_s,e.unknown_s,e.coverage_percent,
       e.potential_inside_upper_s,e.evaluated_at
FROM route_assignment a LEFT JOIN visit_evaluation_job j
  ON j.tenant_id=a.tenant_id AND j.assignment_id=a.id
LEFT JOIN visit_evaluation_current c ON c.tenant_id=a.tenant_id AND c.assignment_id=a.id
  AND c.stop_id=:'stop_id'::uuid
LEFT JOIN visit_evaluation e ON e.id=c.evaluation_id
WHERE a.tenant_id=:'tenant_id' AND a.id=:'assignment_id'::uuid;

SELECT l.id AS link_id,l.device_id,l.valid_from,l.valid_to,l.state,
       p.event_id,p.session_id,p.captured_at,p.received_at,p.accuracy_m,p.quality_state,
       es.started_at AS effective_start,es.stopped_at AS effective_stop,
       ss.start_at AS scheduled_start,ss.end_at AS scheduled_end,
       ST_Distance(p.geom,ST_SetSRID(ST_MakePoint(v.longitude,v.latitude),4326)::geography)
         AS distance_from_historical_center_m
FROM route_assignment a JOIN assignment_visit v
  ON v.tenant_id=a.tenant_id AND v.assignment_id=a.id
JOIN agent_device_link l ON l.tenant_id=a.tenant_id AND l.agent_id=a.agent_id
  AND l.state<>'REVOKED' AND l.valid_from<a.ends_at
  AND coalesce(l.valid_to,'infinity'::timestamptz)>a.starts_at
LEFT JOIN position_event p ON p.tenant_id=a.tenant_id AND p.device_id=l.device_id
  AND p.captured_at>=greatest(a.starts_at,l.valid_from)
  AND p.captured_at<least(a.ends_at,coalesce(l.valid_to,'infinity'::timestamptz))
LEFT JOIN gps_effective_session es ON es.tenant_id=p.tenant_id
  AND es.device_id=p.device_id AND es.id=p.session_id
  AND es.assignment_version=p.assignment_version
LEFT JOIN gps_scheduled_session ss ON ss.device_id=es.device_id
  AND ss.id=es.scheduled_session_id AND ss.assignment_version=p.assignment_version
WHERE a.tenant_id=:'tenant_id' AND a.id=:'assignment_id'::uuid
  AND v.stop_id=:'stop_id'::uuid
ORDER BY p.captured_at,p.event_id;

-- Tras confirmar el dispositivo por una fuente independiente, esta consulta
-- encuentra puntos recibidos aunque falte el vínculo de atribución.
SELECT p.device_id,p.event_id,p.session_id,p.captured_at,p.received_at,
       p.accuracy_m,p.quality_state
FROM position_event p JOIN route_assignment a ON a.tenant_id=p.tenant_id
WHERE a.tenant_id=:'tenant_id' AND a.id=:'assignment_id'::uuid
  AND p.device_id=:'device_id'::uuid
  AND p.captured_at>=a.starts_at AND p.captured_at<a.ends_at
ORDER BY p.captured_at,p.event_id;

SELECT r.device_id,r.kind,r.persisted_at,cardinality(r.accepted_event_ids) AS accepted,
       cardinality(r.duplicate_event_ids) AS duplicates
FROM gps_event_batch_receipt r JOIN agent_device_link l ON l.device_id=r.device_id
JOIN route_assignment a ON a.tenant_id=l.tenant_id AND a.agent_id=l.agent_id
WHERE a.tenant_id=:'tenant_id' AND a.id=:'assignment_id'::uuid
  AND r.persisted_at BETWEEN a.starts_at - INTERVAL '1 day' AND a.ends_at + INTERVAL '1 day'
ORDER BY r.persisted_at;

SELECT r.device_id,r.persisted_at,cardinality(r.accepted_event_ids) AS accepted,
       cardinality(r.duplicate_event_ids) AS duplicates
FROM gps_mixed_batch_receipt r JOIN agent_device_link l ON l.device_id=r.device_id
JOIN route_assignment a ON a.tenant_id=l.tenant_id AND a.agent_id=l.agent_id
WHERE a.tenant_id=:'tenant_id' AND a.id=:'assignment_id'::uuid
  AND r.persisted_at BETWEEN a.starts_at - INTERVAL '1 day' AND a.ends_at + INTERVAL '1 day'
ORDER BY r.persisted_at;
```

Confirmar además sesiones efectivas/programadas y backlog local del agente, si hay acceso autorizado. No es posible inferir backlog Android desde una tabla de posiciones del servidor. La posición visible a las 21:59 debe verificarse contra `captured_at`, ventana, vínculo, sesión y snapshot. No hay identificadores ni filas reales disponibles en esta sesión; no se ejecutó evaluación real ni se alteró historial.

## Staging y Git

El checkout está en `codex/b32-staging-promotion`. Los artefactos sin seguimiento `scripts/deploy/b32-staging/`, `.github/workflows/deploy-b32-images.yml` y `b32-staging-candidate.json` ya estaban presentes. Su manifiesto fija `fe495994...`, 32 migraciones hasta `0032`, controlador máximo 32, publicación `PENDING` y digests API/Web nulos. El workflow fija el mismo SHA y verifica exactamente 32 migraciones. Estos artefactos **no son compatibles** con esta línea de 33 migraciones; no se modificaron ni ejecutaron.

Preparación requerida, en orden: revisar y fusionar el commit de esta corrección con la línea fuente autorizada; crear un nuevo manifiesto y paquete de controlador firmado para el commit exacto y la cadena 0001–0033; validar los checksums de 0032 sin alterarla; obtener respaldo y plan de recuperación supervisada para schema 33; aprobar publicación versionada de API/Web/recovery; registrar digests; ejecutar `doctor/status/prepare/begin/migrate/verify` mediante el guard y controlador revisados; verificar `/health/ready`, logs de scheduler, acción manual, mapa e historial en staging. El esquema 33 no admite downgrade de base; rollback de aplicación requiere imagen compatible con 33 o recuperación supervisada de respaldo. Ninguno de esos pasos operativos se ejecutó.

## Validación local

- `npm run build`, `npm run typecheck`, `npm run lint` y `npm test`: aprobados. `npm test` ejecutó 135 pruebas (72 API, 53 Web, 5 contratos, 2 migración, 1 restauración, 2 réplica). Lint informa 12 advertencias y ningún error.
- PostGIS desechable: 57 catálogo + 76 rutas + 70 programación + 41 evaluación + 62 identidad/operación = 306 comprobaciones. Incluye migración 0033, replay, persistencia de métricas y gate de activación.
- Navegador: 15 + 14 + 28 = 57 comprobaciones en escritorio y 390 px. Regresión GPS: 48 + 37 + 58 = 143 comprobaciones.
- Pruebas del motor: 17, incluidas 120 secuencias generadas para comprobar determinismo, no solapamiento, cotas de ventana e imposibilidad de `NON_COMPLIANT` cuando los desconocidos permiten llegar al mínimo. El demo de calibración fue ejecutado y su matriz está arriba.

## Estado de cierre

| Dimensión | Estado |
| --- | --- |
| `IMPLEMENTATION_STATUS` | `PARTIAL`: cálculo, persistencia y UI validados localmente; faltan calibración de campo y verificación de actualización de staging |
| `CALIBRATION_STATUS` | `FIELD_EVIDENCE_MISSING`: 0 casos reales etiquetados; demo sintético solamente |
| `RULE_APPROVAL_STATUS` | `FUNCTIONAL_APPROVED / TECHNICAL_ONLY`: DEC-VISIT-001/002 registradas; revisión 3 no activada |
| `STAGING_READINESS` | `BLOCKED`: controlador/manifiesto/imagen fijados a 32 migraciones y SHA anterior; estado del servidor no comprobado |
| `DEPLOYMENT_STATUS` | `NOT_DEPLOYED` |
