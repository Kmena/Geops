# Registro de decisiones y riesgos — SPEC-03

**Corte:** 2026-11-03. **Autoridad:** responsable del proyecto GEOPS, según la instrucción de esta conversación. Aprobación de diseño/documentación únicamente; no autoriza W1, código, migraciones o despliegue. Estas decisiones son locales a SPEC-03 y no sustituyen ADR transversales vigentes.

| ID | Estado | Fecha | Autoridad | Alternativa seleccionada | Requisitos / pruebas |
| --- | --- | --- | --- | --- | --- |
| D-01 | APROBADA | 2026-11-03 | Responsable del proyecto | Catálogo CSV/XLSX autorizado como autoridad; KMZ geográfico; vínculo manual excepcional. | IR-04/07; P06/07/09 |
| D-02 | APROBADA; calibración pendiente | 2026-11-03 | Responsable del proyecto | 50 m y 250 m configurables solo para candidatos de prueba. | IR-04/05; P06/08/09 |
| D-03 | APROBADA | 2026-11-03 | Responsable del proyecto | Paradas candidatas; ruta en borrador hasta vínculo y reglas operativas. | IR-08/12; P11/18 |
| D-04 | APROBADA | 2026-11-03 | Responsable del proyecto | Polígonos y línea solo en staging inicial. | IR-01/03/08; P01/09/11 |
| D-05 | APROBADA CON PARÁMETROS TÉCNICOS PENDIENTES | 2026-11-03 | Responsable del proyecto | Cuotas configurables y máximos duros; propuesta inicial abajo. | IR-02/03; P02/03/16 |
| D-06 | APROBADA CON VALIDACIÓN DE POLÍTICA PENDIENTE | 2026-11-03 | Responsable del proyecto | 30 días propuestos para archivo y staging; retención de auditoría separada. | IR-01/11; P04/17 |
| D-07 | APROBADA | 2026-11-03 | Responsable del proyecto | Capacidades separadas para leer, corregir y confirmar; sin auto-grants. | IR-07/10/11; P07/12/17 |
| D-08 | APROBADA | 2026-11-03 | Responsable del proyecto | Actualización por campos seleccionados con motivo y versión. | IR-07/09/10/11; P07/08/13/15 |

## Justificación, consecuencias y parámetros pendientes

### D-01 — Identidad comercial

El KMZ contiene ubicaciones y nombres, pero cinco códigos repetidos entre 650 puntos; no acredita cédula. Customer y su identificador comercial dependen del CSV/XLSX autorizado o de vínculo manual explícito. El KMZ puede proponer establishment/pin candidato, nunca fusionar clientes. Riesgo: aparentar identidad confirmada sin fuente. Pendiente: muestra, diccionario, namespace, vigencia y responsable del catálogo (SPEC-00 Q-11); sin ellos queda bloqueada la ingestión de identidad comercial.

### D-02 — Coincidencias

≤ 50 m es banda inicial alta; > 50 y ≤ 250 m es banda ampliada; > 250 m no crea candidato por distancia sola. Ambas son configurables y versionadas. Ni proximidad ni nombre bastan para fusión o aceptación automática; un caso ambiguo requiere revisión. Riesgo: falsos positivos/negativos. Pendiente: calibración con pares etiquetados por negocio; P06 cubre bordes y negocios distintos en la misma coordenada.

### D-03 — Semanas y paradas

SEMANA 1–5 no define calendario, recurrencia ni vigencia. WEEKLY_STOP permanece candidata hasta vínculo explícito con cliente; route_version permanece DRAFT hasta validación operativa. No crea obligaciones ni cambia visitas históricas. Riesgo: planificación ficticia. Pendiente: responsable de calendario/recurrencia/vigencia y asignación futura.

### D-04 — Polígonos y línea

Los 763 Placemark poligonales y la LineString del archivo de referencia conservan geometría, origen y jerarquía solo en staging. No crean geozona, ruta ni recorrido realizado. Una capa visual separada es fase posterior. Riesgo: costo espacial e interpretación errónea. No hay publicación de estas geometrías en el alcance inicial.

### D-05 — Cuotas de carga

La muestra mide 7.065.418 bytes comprimidos, 24.785.245 expandidos, nueve entradas, profundidad ZIP 2, XML 13, 45.261 nodos, 2.012 Placemark, 727.545 tuplas de coordenadas y máximo de 26.466 en un elemento. ZIP y XML se leyeron en modo solo lectura, sin ejecutar contenido ni cargar recursos externos. La lectura local tardó ~3,1 s y el parseo XML aislado ~0,15 s; no son presupuestos del servidor.

| Recurso | Propuesta inicial para pruebas W2, NO validada para producción | Muestra |
| --- | --- | --- |
| KMZ comprimido | 32 MiB | ~6,74 MiB |
| Suma expandida / entrada individual | 128 MiB | ~23,64 MiB |
| Entradas ZIP / segmentos de ruta | 128 / 8; rechazar ZIP/KMZ anidado | 9 / 2 |
| Razón expandida por entrada | 50:1, además del máximo de bytes | 3,51:1 |
| Profundidad XML / nodos | 32 / 250.000 | 13 / 45.261 |
| Placemark | 10.000 | 2.012 |
| Tuplas totales / por elemento coordinates | 2.000.000 / 100.000 | 727.545 / 26.466 |
| Texto por nodo | 2 MiB | ~0,69 MiB |

Cuotas configurables por entorno más máximos duros del servidor, streaming y rechazo temprano; no elevar el bodyLimit JSON global. Riesgo: rechazo de archivos legítimos mayores o consumo de memoria desproporcionado. **PENDING_VALIDATION:** memoria pico, CPU/tiempo, concurrencia de cargas y comportamiento del parser productivo; medir P16 en entorno aislado. Los números son parámetros técnicos propuestos, no aprobados como límites definitivos.

### D-06 — Retención

TTL propuesto de 30 días desde carga para KMZ y staging; avisar antes de expirar, impedir confirmación vencida y marcar EXPIRED. CANCELLED y EXPIRED entran en limpieza futura verificable; no ejecutar limpieza en W0. No aplicar ese plazo a audit_event, decisiones, ledger o catálogo. Riesgo: borrar evidencia necesaria o retener datos de más. Pendiente: política autorizada de datos, backups e incidentes y responsable de aprobación.

### D-07 — Permisos

catalog.import.read lista y consulta; catalog.import.write carga, corrige y cancela; catalog.import.confirm valida y confirma con auditoría. Confirmación requiere lectura del plan. Reutilizar sesión admin, origen/CSRF y admin_permission. La migración futura debe extender el CHECK y la lista permitida de gestión de usuarios sin otorgar permisos por defecto. Riesgo: privilegios excesivos o grants insuficientes. Pendiente: matriz de roles y responsable de concesión/revocación.

### D-08 — Actualización selectiva

UPDATE_SELECTED_FIELDS exige destino, lista de campos, versión/ETag, motivo y aprobación explícita; muestra y audita antes/después. Campo ausente en KMZ conserva valor actual. Similitud geográfica nunca modifica cliente. Riesgo: pérdida por carrera o campo mal elegido; P07/P08/P13/P15. Pendiente: lista permitida de campos según esquema autorizado.

## Riesgos y controles

| Riesgo | Control propuesto | Evidencia requerida |
| --- | --- | --- |
| Duplicados por códigos repetidos o copias Heredia | Namespace, matching explicable, revisión humana, ledger e idempotencia. | P06/P09/P14/P15. |
| Corrupción o publicación parcial | Transacción única, rollback inyectado, revisión catalog_revision, commit recuperable. | P08/P13–P15. |
| ZIP bomb, XXE, traversal, HTML KML | Streaming con cuotas, parser sin DTD/red, rutas no confiables nunca usadas para escribir, sanitización. | P02/P03/P16. |
| Rutas semanales confundidas con planes | Grupos separados, borrador explícito, parada vinculada, cero visitas al importar. | P11/P18. |
| Cambios concurrentes o dos revisores | If-Match en fila/plan, catalog_revision, lock y respuesta 409/rebase. | P08/P10/P15. |
| Datos de clientes en logs, backups o fixtures | Acceso por capacidad, redacción, TTL, política de retención y fixture autorizado. | P17 y revisión de seguridad. |
| Degradación de GPS o evaluación histórica | Sin escrituras GPS; tests de regresión y versiones futuras de ruta/pin. | P18. |

## Estado de cierre documental

D-01–D-08 quedaron registradas como decisiones de diseño aprobadas. Calibración D-02, parámetros operativos D-05, política D-06 y responsables/campos D-07/D-08 permanecen pendientes según se detalla arriba. La autorización posterior permitió exclusivamente W1-A; su evidencia está en [w1-a-evidence.md](w1-a-evidence.md). **W1-B y W2–W6 pendientes.**
