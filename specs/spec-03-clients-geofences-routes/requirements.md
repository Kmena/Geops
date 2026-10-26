# Requisitos SPEC-03

**Estado:** especificación propuesta. Fuente: solicitud DEC-GEO-001/002, DEC-ROUTE-001 y PRD v1.1 RF-11–13, RN-02/04/06/07. Las decisiones funcionales marcadas DEC son confirmadas; parámetros numéricos son pendientes de calibración.

| ID | Requisito observable |
| --- | --- |
| FR-01 | Administrador autorizado crea, consulta, edita y desactiva clientes con código único por tenant, nombre, dirección, contacto opcional y auditoría. No se borran clientes con historia. |
| FR-02 | Un cliente puede tener uno o varios puntos de visita identificables; una geozona circular pertenece a un punto. Esta propuesta separa cliente comercial de sede física y evita duplicar clientes de varias sedes. |
| FR-03 | La Web permite ubicar centro, ajustar radio en metros, previsualizar círculo, definir permanencia mínima, consultar y publicar una versión de geozona. No hay polígonos. |
| FR-04 | Rutas reutilizables contienen paradas de puntos de visita, obligatorias u opcionales, tiempo mínimo y orden visual opcional. El orden no condiciona la validez. Cliente/punto puede figurar en varias rutas. |
| FR-05 | Cada publicación de ruta genera versión inmutable. Asignaciones capturan ruta, paradas, regla y geozona vigentes; editar catálogo no reescribe historia. |
| FR-06 | Asignaciones diarias vinculan agente, fecha local, zona IANA, jornada [inicio,fin), ruta versionada y dispositivo opcional. Ofrecen semana, regla por días ISO, excepciones, cancelación futura, reasignación auditada y calendarios por agente/ruta. |
| FR-07 | Motor backend suma estimaciones conservadoras de permanencia en intervalos observables disjuntos dentro de la misma visita y jornada. Salir y regresar conserva saldo. Una muestra aislada aporta cero segundos. |
| FR-08 | Evaluación usa `captured_at`, tolera lotes fuera de orden/reenvíos, recalcula por evidencia tardía, conserva revisión y fuentes, y separa estado operativo de resultado final. |
| FR-09 | Sin evidencia suficiente o pendiente de sincronización, resultado `UNVERIFIABLE`; jamás convertir silencio offline automáticamente en incumplimiento. |
| FR-10 | La ruta solo alcanza `COMPLETED` cuando cada parada obligatoria alcanza `COMPLETED`; visitas opcionales no bloquean. |
| FR-11 | Dashboard administrativo muestra mapas, rutas, calendario, cumplimiento por agente/ruta, tiempo, historia y evidencia con frescura y cobertura. El agente Android no recibe controles de visita. |
| FR-12 | Cambios de estado, publicación, reasignación y consulta de ubicación sensible registran actor, hora, motivo y correlación sin coordenadas en auditoría general. |

## Requisitos no funcionales

| ID | Criterio propuesto y verificación |
| --- | --- |
| NFR-01 | Aislamiento por tenant y capacidad en cada lectura/escritura; pruebas negativas de otro tenant y sin concesión. |
| NFR-02 | GPS v2 y cadencia de captura no cambian. Pruebas de contrato existentes deben conservar resultados; dispositivo físico se valida aparte. |
| NFR-03 | Reproceso determinista: misma evidencia/versiones produce mismos intervalos y resultado; reenvío no incrementa segundos. Prueba de permutaciones, duplicados y ejecuciones concurrentes. |
| NFR-04 | Ningún segundo fuera de la intersección [jornada de ruta, ventana GPS autorizada, vigencia agente–dispositivo) entra en el cálculo. Pruebas de bordes y DST. |
| NFR-05 | La evaluación nunca bloquea el ACK de ingestión; retraso y backlog del worker visibles. Objetivo inicial a medir en datos sintéticos: p95 de evaluación de una asignación de 12 h < 5 s y backlog < 5 min en carga de 25 dispositivos; no es SLA confirmado. |
| NFR-06 | Historial de regla, snapshots y decisiones reconstructibles durante la retención aprobada. Coordenadas crudas siguen política de 90 días actual; política de evidencia derivada requiere aprobación. |
| NFR-07 | Paginación con límites 1–100, orden estable y cursor; mutaciones con ETag y clave idempotente, sin cambios parciales. |
| NFR-08 | Accesibilidad Web: mapa acompañado por formulario/tabla operables por teclado, foco visible, error textual y unidades explícitas; prueba de teclado y automatizada. |

## Definiciones de estado

`PENDING` e `IN_PROGRESS` son operativos mientras la ventana está abierta o puede llegar backlog. `COMPLETED` es resultado verificable reversible mediante nueva evaluación auditada si cambia evidencia válida. `INCOMPLETE` requiere cobertura suficiente para afirmar permanencia menor al umbral; `NOT_VISITED` requiere cobertura suficiente para afirmar ausencia de intervalos calificados. `UNVERIFIABLE` indica huecos, baja calidad, identidad ambigua o sincronización pendiente; `CANCELLED` proviene de cancelación autorizada. No se afirma resultado final hasta cierre + plazo de sincronización aprobado + watermark de ingestión, con posibilidad de corrección posterior.
