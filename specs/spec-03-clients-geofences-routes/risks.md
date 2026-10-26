# Riesgos, dependencias y decisiones pendientes

| ID | Riesgo / dependencia | Mitigación y gate |
| --- | --- | --- |
| R-01 | `gps-event-service.ts:119-132` exige binding MDM activo, incompatible con aceptar GPS APK-first sin MDM. | Frente de ingestión/identidad debe demostrar aceptación autorizada sin MDM; no alterar APK ni GPS v2 aquí. Hasta entonces el motor evalúa solo posiciones aceptadas. |
| R-02 | El catálogo de agente existe desde Wave 3, pero no hay vínculo agente–dispositivo temporal seguro. | Definir tenant canónico del dispositivo y vigencias explícitas; no inferir desde admin o dispositivo actual. Bloquea integración GPS, no planificación local. |
| R-03 | Retención GPS y edad aceptada limitan evidencia tardía; FKs de evidencia podrían impedir purga. | Acordar retención y minimización; pruebas de purga y reproceso previo. Bloquea Wave 4. |
| R-04 | Offline y huecos reducen cobertura; clasificación de ausencia podría falsear incumplimiento. | Estado `UNVERIFIABLE`, watermark, criterios de cobertura calibrados y visibles. |
| R-05 | Radio pequeño frente a precisión, multitrayecto y borde. | Umbral por sede, regla `d+accuracy<=radius`, piloto físico; no radio universal. |
| R-06 | Cambios de política, geozona y ruta durante jornada. | Snapshots al crear asignación, revisiones append-only; cambios urgentes requieren evento de reemplazo explícito. |
| R-07 | Doble acreditación en geozonas solapadas y visitas repetidas a una sede. | Mostrar conflicto y decidir regla de negocio antes de Wave 4. |
| R-08 | Tenant `synthetic` fijado en migración 0015 y permisos GPS con CHECK cerrado. | Coordinar migraciones aditivas con frente seguridad; no cambiar OAuth/MDM aquí ni conceder permisos automáticamente. |
| R-09 | Worker no existe; ACK GPS puede preceder evaluación y outbox. | Enlace transaccional o barrido reconciliador probado, watermark y lag visible; no bloquear ingesta. |
| R-10 | DST, cruce de medianoche, solapes y reasignación. | Guardar límites UTC y zona IANA, rechazo de hora ambigua y exclusión temporal; pruebas de calendario. |
| R-11 | Mapa Leaflet usa teselas externas configurables. | Fuente aprobada, atribución y fallback tabular; no exponer coordenadas a proveedor no autorizado. |
| R-12 / TD-EXT-01 | Deuda técnica externa: una ejecución previa del lint global en esta rama registró 29 errores y 12 advertencias en archivos GPS/scripts que permanecen sin cambios respecto a HEAD y son ajenos a SPEC-03. | El lint dirigido de los 14 archivos de código del módulo y del fixture E2E pasa sin diagnósticos. La deuda pertenece a los frentes propietarios GPS/scripts y debe resolverse antes de exigir un gate global verde en integración; no bloquea el gate técnico de Wave 1. |
| R-13 | La migración 0022 se asignó tras observar 0021 en worktree MDM, pero las ramas concurrentes pueden avanzar antes de integrar. | Reconciliar numeración y checksums con el frente MDM en una rama de integración; no aplicar 0022 a base persistente desde este worktree. |
| R-14 | La migración Wave 2 usa 0023 tras observar hasta 0021 en worktrees MDM/GPS y 0022 local. | Reconciliar otra vez antes de integración; nunca renumerar frente ajeno ni aplicar en base persistente desde esta rama. |
| R-15 | Claves idempotentes de rutas se conservan sin purga automática, igual que el catálogo Wave 1. | Definir retención y limpieza supervisada antes de operación sostenida; evitar purga que permita reejecución inesperada. |

## Decisiones por resolver antes de implementación

| ID | Responsable propuesto | Pregunta y salida requerida |
| --- | --- | --- |
| P-01 | Producto/Operaciones | ¿Fuente y ciclo de vida del agente, y si un agente puede tener dos dispositivos simultáneos? Identificador estable y regla de solape. |
| P-02 | Producto/GIS | Radios mínimo/máximo por tipo de sede, precisión admisible, `max_gap`, `credit_cap`, guardia y cobertura mínima medidos físicamente. |
| P-03 | Producto | ¿Permite sede sin geozona, varias visitas al mismo sitio en una jornada y acreditación simultánea de zonas superpuestas? |
| P-04 | Seguridad/Privacidad | Retención de evaluaciones, evidencia y eventos purgados; alcance de motivos de consulta y acceso a coordenadas. |
| P-05 | Operaciones/GPS | Plazo máximo de sincronización tardía, watermark de cierre y tratamiento de lote posterior a retención. |
| P-06 | Identidad/MDM | Ruta autorizada para aceptar GPS sin MDM y tenant operativo no sintético, sin cambiar contrato v2. |
| P-07 | Producto | Reasignación durante jornada: conservar minutos del agente anterior, reiniciar obligación o dividirla; no transferir automáticamente. |
| P-08 | Producto | Semántica de `INCOMPLETE` vs `NOT_VISITED`, denominador del KPI y cobertura suficiente. |
| P-09 | Arquitectura | Hora DST ambigua/no existente y vigencia de reglas recurrentes ante cambios de zona o plantilla. |

Los ADR de este paquete registran decisiones **propuestas**. Solo las tres DEC recibidas se consideran confirmadas. Ninguna propuesta autoriza producción ni cierra los bloqueos.

**Resolución parcial P-02 (Wave 1):** el usuario eligió límites configurables. `GEOPS_CATALOG_MAX_RADIUS_M` y `GEOPS_CATALOG_MAX_DWELL_S` permiten restringir los topes sin otra migración; la base mantiene un techo técnico de 100000 m y 86400 s. Los valores operativos, precisión admisible y reglas del motor siguen pendientes de calibración física. Esto no bloquea el catálogo sintético, pero sí el uso operativo y Wave 4.

**Resolución Wave 2 de P-03 para plantillas:** una ruta exige sede existente, activa y con última revisión de geozona activa; una misma sede aparece una vez por ruta; sedes distintas del mismo cliente son visitas distintas; una sede puede aparecer en varias rutas; publicación exige al menos una parada obligatoria. La política de visitas repetidas en una jornada y zonas solapadas queda pendiente para Waves 3–4. `TD-EXT-01` permanece externa: lint dirigido Wave 2 pasa sin errores ni advertencias nuevos; no se tocaron archivos GPS/scripts para corregir lint global.

**Wave 3:** R-02 se resuelve solo para el catálogo de agentes: la relación histórica agente–dispositivo continúa pendiente. `geops_device` no ofrece tenant canónico independiente de `mdm_binding`; introducir una FK sin esa garantía permitiría atribución entre tenants. Las asignaciones quedan en planificación sin validación GPS completa. La migración 0024 se verificó únicamente contra PostGIS descartable y deberá reconciliar numeración/checksum con MDM/GPS antes de integrar. La ventana de materialización se limita a 31 fechas civiles por solicitud; su ejecución periódica sostenida queda para un frente operativo futuro. La deuda `TD-EXT-01` es ajena a SPEC-03.

**Wave 4A:** `0025` y `dwell-pair-v1` son aditivos/locales. La vinculación `visit_lab_agent_device_link` es exclusivamente sintética, creada por fixture SQL; no demuestra identidad física ni independencia MDM de ingestión. La cola permite reprocesar por asignación/día y el worker sintético detecta más posiciones persistidas por conteo; todavía no existe disparo transaccional desde GPS ni programador operativo: la proyección puede quedar obsoleta hasta la siguiente invocación. El conteo no detecta correcciones de una misma fila, por lo que esos cambios requieren reproceso explícito. Los parámetros son de laboratorio y pueden subestimar o sobreestimar presencia entre dos muestras. La conservación indefinida de revisiones, intervalos e IDs de eventos carece de plazo de privacidad aprobado; tras la purga GPS no se puede reconstruir detalle, aunque sobreviva el resultado histórico. No habilitar uso real hasta aprobar identidad, retención, cobertura, calibración física y activación/observabilidad. Reconciliar numeración y checksum 0025 con ramas MDM/GPS al integrar.
