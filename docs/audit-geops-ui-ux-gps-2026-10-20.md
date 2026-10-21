# GEOPS — auditoría UI/UX, GPS y administración de dispositivos

> Nota posterior: esta auditoría describe la interfaz anterior a Wave 1. La propuesta de MapLibre quedó sustituida por la decisión de Leaflet; véase [migración de Leaflet](development/leaflet-migration-2026-10-20.md). La evidencia original se conserva.

**Fecha:** 20/10/2026 · **Rama revisada:** codex/spec-02-wave-1 · **Alcance:** diagnóstico y propuesta, sin cambios funcionales.

## Dictamen ejecutivo

GEOPS ya conserva controles relevantes de autorización, tenant, PoP, auditoría y confirmación presencial. La experiencia operativa todavía no permite responder con rapidez a tres preguntas básicas: **qué equipo estoy viendo, dónde estuvo y qué está pasando con sus lecturas pendientes**. La vista GPS activa muestra UUID como nombres, un gráfico relativo sin cartografía y datos de salud que pueden ser anteriores al momento de consulta. La administración Web no expone la retirada de la instalación GPS ni la revocación de identidad que sí tienen rutas de API.

La demora observada tiene dos componentes distintos. El hueco de **9 min 34 s** entre las horas de captura mostradas no demuestra retraso de red: pueden existir lecturas locales aún pendientes entre ambos extremos. La política pide una lectura cada 60 s, pero Android no garantiza esa cadencia; el envío se intenta cada 300 s y puede demorarse más por dependencia de sesión, reintentos, conectividad o ACK. La interfaz Web además no se refresca sola y puede mostrar resultados de filtros anteriores. Sin identificadores de evento y horas de recepción del caso real no es posible atribuir el hueco a una sola causa.

### Evidencia y límites

| Fuente | Qué se verificó | Límite |
| --- | --- | --- |
| UIAudit, flujo empaquetado Impeccable audit | Se ejecutó el detector sobre apps/web/src con el motor local; resultado JSON: **[]**, salida 0. | El detector busca patrones mecánicos; no valida el recorrido de negocio ni certifica accesibilidad. |
| Impeccable 4.3.1, flujo audit complementario | Se ejecutó su launcher sobre apps/web/src con el mismo motor local; resultado JSON: **[]**, salida 0. | Ambas extensiones usaron el motor local 4.0.0; sus resultados no son dos mediciones independientes. |
| Contexto y auditoría de código | Se leyeron las guías audit web y native Android; se contrastaron componentes, CSS, app Android, cola, API y esquema. | La app Android se auditó desde fuente y las capturas aportadas, sin instalar APK. |
| Navegador local | Vite local abrió el acceso. A 1280, 768 y 390 px no hubo desbordamiento horizontal del login; orden de Tab: correo → contraseña → Entrar. | Las vistas autenticadas no se probaron en navegador porque no se inició sesión ni se consultó el backend; las dos capturas del usuario son evidencia visual de esas vistas. |
| Capturas aportadas | Android: política autorizada, servicio GPS activo, cero lecturas al primer diagnóstico. Web: salud recibida, RUNNING, sin posiciones en el período y sesión seleccionados. | Son observaciones puntuales, no un registro continuo. |

El valor **[] no equivale a “sin problemas UX”**. No se consultó PostgreSQL, AWS ni los cinco dispositivos; no se alteró su estado.

### Salud técnica de la interfaz, evaluación manual según las rúbricas de audit

| Superficie | Accesibilidad | Rendimiento | Responsive/adaptividad | Tema/apariencia | Integridad/plataforma | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Web | 2/4 | 3/4 | 2/4 | 1/4 | 2/4 | **10/20 — aceptable con trabajo significativo** |
| Android de prueba | 2/4 | 3/4 | 1/4 | 1/4 | 2/4 | **9/20 — deficiente para operación general** |

Son puntuaciones de revisión de fuente y evidencia parcial, no una declaración de conformidad WCAG ni de rendimiento físico. A favor: controles Web semánticos, etiquetas en formularios, enlace para saltar al contenido, foco visible, estados de carga y vacío, y separación explícita de datos sintéticos. En Android, el flujo exige acción visible, permiso y notificación; no hay arranque oculto.

## 1. Seguimiento GPS: dónde aparece la demora

| Etapa | Comportamiento comprobado | Señal necesaria para el caso real |
| --- | --- | --- |
| Captura Android | GeopsLocationService.kt:47–58 registra LocationManager.GPS_PROVIDER con el intervalo solicitado; no garantiza callbacks cada 60 s. AgentRuntime.kt:96–110 registra la última entrega de Android. | Hora de cada callback y motivo de aceptación o descarte. |
| Validación y almacenamiento | TrackingController.kt:72–105 exige ventana, sesión, tiempo, coordenadas, precisión e intervalo; solo al guardar incrementa locationsCaptured. AgentStore.kt:84–115 cifra y reemplaza el archivo local de forma atómica. | Contador de descartes por motivo y evento guardado, sin registrar coordenadas en logs. |
| Cola | AgentState.pending conserva SESSION, LOCATION y HEALTH, reintentos y cuarentena. “Pendientes” en el diagnóstico cuenta solo LOCATION **no** en cuarentena. | Cantidad, antigüedad del más viejo, intentos y cuarentena por tipo. |
| Planificador | AgentRuntime.kt:132–178 ejecuta un ciclo cada 30 s; el envío por tipo ocurre al alcanzar syncIntervalS (300 s en la captura). Primero intenta SESSION, luego LOCATION, luego HEALTH. | Inicio/fin de cada intento y siguiente intento previsto. |
| Dependencia de sesión | BatchSync.kt:33–39 no envía posiciones mientras el evento STARTED continúe pendiente. Es una barrera de integridad válida que puede agregar un ciclo. | Estado ACK de STARTED para la sesión afectada. |
| Lotes y respuesta | BatchSync.kt:40–126 selecciona hasta 100 eventos, 256 KiB para LOCATION; solo retira la cola tras ACK completo con batch_id, persisted_at y todos los event_id. Reintenta fallos, 202, 429 y respuestas no válidas; 409/422 pueden poner eventos en cuarentena. | batch_id, códigos HTTP, accepted/duplicate/invalid_event_ids y persisted_at. |
| Servidor | gps-event-service.ts:373–487 devuelve ACK tras persistir; gps-event-service.ts:717–792 valida sesión y guarda position_event. | Relación event_id ↔ captured_at ↔ received_at ↔ ACK. |
| Consulta Web | gps-event-service.ts:903–1001 filtra por captured_at en intervalo [desde, hasta), y opcionalmente session_id; devuelve también received_at. GpsLiveWorkspace.tsx:187–211 hace una consulta inicial; luego solo actualiza al pulsar el botón. | Parámetros aplicados realmente, hora de consulta, próxima página y latencia captura→recepción. |

**Intervalos de las cinco horas proporcionadas:** 68 s, 72 s, 574 s y 67 s en orden cronológico. Los 574 s son un hueco entre posiciones **visibles por captured_at**. Pueden explicar parte del hueco las posiciones locales pendientes, una falta de callbacks GPS, descartes por validación, otra sesión, un filtro o una consulta Web anterior; ninguna está probada como causa única.

**Semántica de contadores.** “Capturadas” aumenta al guardar una posición local aceptada; “confirmadas” aumenta cuando un lote recibe ACK válido, incluidos duplicados reconocidos; “pendientes” cuenta LOCATION no aisladas en cuarentena. El archivo cifrado y sus contadores sobreviven una actualización de APK, por lo que la frase Android “desde esta versión” es engañosa. Los 9 capturados, 5 pendientes y 5 visibles **no forman necesariamente una suma del mismo corte temporal, sesión ni instalación**. No se concluye pérdida ni recepción de las cuatro posiciones restantes. AgentStore.kt:17–29, TrackingController.kt:97–105, BatchSync.kt:76–92 y AgentRuntime.kt:299–312 sustentan esta lectura.

**Hipótesis priorizadas para verificar, sin alterar datos:**

1. Extraer una línea temporal con los event_id del conjunto observado: callback, aceptación local, intento de lote, respuesta y hora de recepción. Comparar captured_at con received_at para cada evento, no entre eventos diferentes.
2. Confirmar si las posiciones de 15:54–16:02 están en cola, cuarentena o una sesión distinta. El servidor filtra por sesión y por un límite superior exclusivo.
3. Revisar si STARTED obtuvo ACK antes de los lotes LOCATION y si hubo 202, 429, 409, 422, fallo de red o ACK inválido. El reintento individual tiene backoff, pero el planificador solo vuelve a llamar a sync al siguiente ciclo de 300 s: un fallo puede añadir al menos otro ciclo.
4. Verificar en el teléfono la última lectura entregada por Android y la última decisión de captura. Si nunca hubo callback, la red no es la causa de ese hueco.
5. En Web, comparar la hora de la última consulta con la de recepción y consultar sin filtro de sesión. No asumir actualización automática.

## 2. Defectos y propuestas de experiencia

### Mapa y datos temporales

El componente PositionTrack de GpsLiveWorkspace.tsx:33–86 proyecta los puntos en un SVG de coordenadas normalizadas y dibuja una línea y círculos. **No hay mapa cartográfico, capas de teselas, calles ni georreferenciación visual.** gps.css:365–381 solo da dimensiones al SVG. La API sí entrega latitud, longitud, precisión, captured_at y received_at. El punto final se colorea, pero su antigüedad y precisión no se visualizan en el gráfico. El mapa ausente es un defecto confirmado de la funcionalidad esperada; no es un fallo de carga de tiles.

**Propuesta:** vista cartográfica como área principal; lista/selector por nombre a un lado; marcadores con precisión (círculo), último punto destacado con etiqueta “capturada hace… / recibida hace…”, trazado del período, huecos de datos marcados como interrupciones y tabla accesible equivalente. Al seleccionar un punto, mostrar captura, recepción, precisión y sesión. Mantener la autorización y el motivo de consulta por solicitud. Un motor abierto como [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) soporta fuentes GeoJSON, marcadores y líneas; la fuente de teselas debe elegirse y aprobarse aparte. El servicio público de OSM tiene [política propia de uso](https://operations.osmfoundation.org/policies/tiles/); no se debe presumir capacidad operativa ni añadir un proveedor de pago sin decisión explícita.

**Filtros:** ofrecer Ahora, Hoy, Última hora, Últimas 6 horas, Últimas 24 horas, Ayer y Personalizado. El rango seleccionado debe reflejar siempre la consulta aplicada, con zona “America/Guatemala” visible y conversión a ISO UTC al llamar la API. La API acepta como máximo 24 h y usa final exclusivo; “Hoy” o “Ayer” que excedan el contrato requieren paginar en bloques de hasta 24 h. “Ahora” usa el reloj actual como fin, y un inicio predefinido útil; no es una ubicación instantánea.

**Defecto confirmado de filtros:** GpsLiveWorkspace.tsx:158–177 reinicia los datos al cambiar de dispositivo, pero no limpia filterSession. Una sesión del dispositivo anterior puede dejar vacía la consulta del nuevo. Cambiar sesión o fechas tampoco vuelve a consultar; hasta pulsar “Actualizar ubicaciones”, los campos visibles pueden describir un conjunto distinto del mostrado. La leyenda “últimas 23 horas” permanece aunque el usuario haya aplicado un rango personalizado. La conversión new Date(from).toISOString() interpreta datetime-local según la zona del navegador, mientras la vista formatea resultados en America/Guatemala: fuera de esa zona puede consultarse otra hora.

### Identidad legible y jerarquía

El inventario y EnrollmentPanel ya reciben display_label; es una base aprovechable. Sin embargo, gps-administration.ts:85–110 solo entrega device_id para la vista GPS. GpsLiveWorkspace.tsx:349–356 lo presenta en el selector; GpsPolicyEditor.tsx:329–345 en asignaciones; sesiones muestran session_id y el resumen de capacidades enumera nombres técnicos. Proponer un modelo de presentación que resuelva display_label para dispositivos y nombre de política, con identificadores en “Detalles técnicos” copiables y en auditoría. Usar nombre más sufijo corto solo para desambiguar duplicados. No tocar UUID ni claves del backend.

El recorrido actual combina inventario, EnrollmentPanel, cuatro rutas GPS y una vista previa de fixtures accesible desde la misma pantalla. En vivo, GpsLiveWorkspace.tsx:273–322 antepone banner técnico, botón general, lista de capacidades y tenant antes del dispositivo. La edición completa de política está en la misma ruta que la lista. En escritorio, la barra lateral ocupa 210 px y el contenido aplica hasta 40 px laterales; en móvil se transforma en una fila horizontal. La prioridad propuesta para Dispositivos es: selector/nombre + estado con hora → mapa y período → cola/sincronización → salud → detalles técnicos. Mantener los controles de demostración solo en un espacio de prueba claramente separado de la operación.

### Estados y administración

El esquema de identidad admite DRAFT, INVITED, PENDING_CONFIRMATION, ACTIVE, SUSPENDED, REVOKED y RETIRED (migración 0003_device_identity.sql:1–7). En las rutas revisadas hay creación, invitación, confirmación y **revocación**, pero no transición operativa de suspender/reactivar/retirar identidad. La API sí ofrece retirar la **instalación GPS** (gps-administration.ts:181–221, :434–440), y la Web solo expone su activación (api/client.ts:248–257). La API también permite revocar la **identidad** (device-identity/routes.ts:235–244), sin control Web equivalente. La lista GPS incluye solo identidad ACTIVE y binding ACTIVE (gps-administration.ts:85–110); los inventarios de inscripción y básico excluyen binding REVOKED (repository.ts:111–119, :144–159). Así, un equipo revocado puede desaparecer de la gestión aunque su historial siga existiendo. Los cuatro “inactivos” citados por el usuario no se clasificaron individualmente porque no se consultó la base.

**Modelo de acciones propuesto:**

| Acción | Alcance y resultado esperado | Disponibilidad actual |
| --- | --- | --- |
| Detener seguimiento / retirar instalación GPS | Cierra autorización de una instalación sin borrar identidad ni historial; comprobar cierre de sesión y rechazo de nuevos lotes. | API disponible; Web ausente. |
| Suspender dispositivo | Estado reversible con bloqueo de nuevas sesiones/PoP y motivo auditado; reactivar solo tras comprobar binding, clave y política. | Estado en esquema; flujo API/Web por diseñar y revisar. |
| Revocar identidad | Cancela invitaciones/claims, revoca clave y sesiones; conserva historial auditable y no permite nuevo envío. | API disponible; Web ausente. |
| Retirar del inventario operativo | Oculta de vista activa, conserva “Historial/retirados” con permisos y retención. | No hay flujo Web completo. |

ACTIVE significa identidad inscrita y válida, **no** servicio GPS en marcha ni posición reciente. Una instalación activa tampoco acredita que Android haya producido lectura. La UI debe mostrar estados separados: identidad, instalación, servicio observado, conectividad observada y frescura del último dato.

### Accesibilidad y Android

- El acceso local tiene etiquetas, foco visible y orden de teclado coherente. La vista GPS usa un SVG con aria-label, pero necesita tabla equivalente, descripción de rango/huecos y alternativa cuando el mapa no cargue.
- En styles.css:174–180, el texto #667b87 sobre blanco da aproximadamente **4.42:1**, inferior a 4.5:1 para texto normal. Es un ejemplo puntual medido, no un barrido exhaustivo. La tipografía secundaria de 0.71–0.82 rem y botones gps de unos 40 px de alto en gps.css:242–251 merecen comprobación de zoom, contraste y objetivos táctiles en las vistas autenticadas.
- El estado de red, cola y frescura no está explicado como una secuencia comprensible. “ONLINE” proviene de una observación y puede mantenerse hasta que el umbral de silencio produzca una inferencia; el timestamp debe acompañarlo siempre y destacar cuando envejece (gps-health-service.ts:543–584).
- La Activity Android es un ScrollView lineal largo. EnrollmentActivity.kt:149–212 coloca diagnóstico extenso antes de escaneo y activación, usa campos técnicos y actualiza el mensaje de estado de forma asíncrona sin anuncio accesible explícito. El padding de 24 se pasa como píxeles, no dp. Proponer una pantalla inicial de estado con acción principal, flujo guiado de QR y un panel de diagnóstico ampliable; verificar TalkBack, fuentes grandes, teclado y pantalla compacta en dispositivo.
- Hay colores rígidos y sin variantes oscuras en CSS; Android usa Theme.Material.Light.NoActionBar. La auditoría no verificó un tema oscuro funcional.

## 3. Matriz P0/P1/P2

Cada fila distingue **C** defecto confirmado en fuente, **O** observación visual, o **H** hipótesis que requiere datos del caso. Las rutas son relativas al repositorio.

| ID | Prioridad y tipo | Pantalla / impacto | Causa y evidencia | Solución propuesta | Archivos / dependencia | Prueba de aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| MAP-01 | **P0 C** | Ubicaciones: no se puede ubicar un equipo en contexto cartográfico. | PositionTrack es SVG relativo, sin mapa base (GpsLiveWorkspace.tsx:33–86). | Mapa autorizado, última posición, precisión, recorrido y tabla equivalente. | GpsLiveWorkspace.tsx, gps.css; decisión de teselas y privacidad. | Ver marcadores geográficos correctos, precisión y huecos con 0/1/muchos puntos; comparación con API. |
| DEV-01 | **P0 C** | Administración: no se puede retirar GPS ni revocar identidad desde Web; inactivos salen de listas. | Rutas API existentes; Web sin controles; consultas filtran ACTIVE/binding no revocado. | Acciones por estado con motivo, revisión y vista de historial/retirados. | EnrollmentPanel.tsx, api/client.ts, gps-administration.ts, repository.ts; permisos/auditoría. | Retiro y revocación permitidos solo a rol autorizado; sesiones nuevas bloqueadas; historial visible según permiso. |
| GPS-01 | **P1 H** | Seguimiento: posiciones pueden aparecer después de varios ciclos. | Captura solicitada 60 s, envío 300 s, barrera STARTED y backoff; faltan tiempos de eventos reales. | Instrumentar línea temporal segura y diagnóstico de cola por etapa; después ajustar cadencia solo con evidencia. | AgentRuntime.kt, BatchSync.kt, TrackingController.kt, API; prueba física. | Para cada event_id de prueba se explica captura→intento→ACK→recepción→vista; no hay pérdidas silenciosas. |
| GPS-02 | **P1 C** | Ubicaciones: “vacío” puede ser filtro obsoleto. | filterSession no se limpia al cambiar dispositivo; cambios de filtro no actualizan consulta (GpsLiveWorkspace.tsx:158–177, :483–525). | Estado de filtros aplicado separado del borrador, reset de sesión, resumen del período consultado. | GpsLiveWorkspace.tsx, remote.test.ts; contrato de sesión. | Cambiar dispositivo no conserva sesión ajena; lista y etiqueta siempre reflejan consulta aplicada. |
| GPS-03 | **P1 C** | Estado: salud antigua se interpreta como seguimiento actual. | Se muestra ONLINE/RUNNING observado, sin edad ni relación con última captura (GpsLiveWorkspace.tsx:402–480). | Tarjetas con captura local, recepción, ACK, pendientes y última comunicación, cada una con hora/fuente. | GpsLiveWorkspace.tsx, AgentRuntime.kt, gps-health-service.ts; contrato de diagnóstico. | Un reporte antiguo se marca “último estado conocido”; no aparece “en vivo” sin evidencia reciente. |
| DATE-01 | **P1 C** | Recorridos: rango manual, zona ambigua y posible desfase. | datetime-local parseado en zona del navegador; formateo fijo Guatemala; fin exclusivo (GpsLiveWorkspace.tsx:19–25, :249–251; gps-event-service.ts:903–968). | Presets, zona explícita, UTC en API y división de rangos >24 h. | GpsLiveWorkspace.tsx, remote.ts; QA zonas/DST. | Presets y “Ahora” consultan el intervalo correcto en Guatemala y otra zona, incluidos límites de día. |
| NAME-01 | **P1 C** | GPS, asignaciones y sesiones: UUID dificultan reconocer el equipo. | El endpoint GPS omite display_label y la UI imprime IDs. | Resolver nombres desde API/contrato y relegar IDs a detalles avanzados. | gps-administration.ts, remote.ts, GpsLiveWorkspace.tsx, GpsPolicyEditor.tsx; tenant. | En todas las vistas se selecciona por nombre, se desambiguan duplicados y se conserva ID auditable. |
| FLOW-01 | **P1 C/O** | Operación: mapa y acción central quedan bajo datos técnicos y editor largo. | Banner/capacidades primero, rutas separadas, fixtures en navegación operativa; captura Web confirma mucho desplazamiento. | Entrada “Seguimiento” orientada a mapa, filtros y estado; mover configuración/diagnóstico a vistas secundarias. | GpsWorkspace.tsx, GpsLiveWorkspace.tsx, GpsPolicyEditor.tsx, styles.css. | En 1280×800 y tableta se alcanzan mapa, selector y período sin desplazamiento largo; móvil mantiene acciones accesibles. |
| ENR-01 | **P1 C/O** | Inscripción Android: fallo genérico y acción QR alejada tras diagnóstico. | EnrollmentActivity.kt:153–212, :286–300; captura Android. | Flujo por etapas, mensaje con fase y error seguro, diagnóstico ampliable, estado anunciado a TalkBack. | EnrollmentActivity.kt; revisión de seguridad para no filtrar secretos. | Operador distingue error local/red/claim/proof sin volver a reclamar a ciegas; TalkBack anuncia resultado. |
| A11Y-01 | **P1 C** | Web: lectura pequeña y algún contraste insuficiente. | #667b87/blanco ≈4.42:1; tamaños secundarios y botones de ~40 px. | Tokens semánticos, contraste AA, objetivos ≥44 CSS px en controles táctiles y tabla accesible del mapa. | styles.css, gps.css; pruebas con zoom/teclado. | AA 4.5:1 texto normal, foco visible, zoom 200 %, teclado y lector de pantalla en vistas protegidas. |
| THEME-01 | **P2 C** | Consistencia: colores rígidos, sin tema oscuro probado. | CSS usa hex repetidos; Android fuerza tema claro. | Definir roles semánticos y validar claro/oscuro donde se soporte. | styles.css, gps.css, tema Android; diseño. | Estados, foco y contraste consistentes en ambos temas; sin regresión en claro. |
| RESP-01 | **P2 O/H** | Móvil y tableta: densidad de controles y scroll. | CSS tiene breakpoints; login no desborda, pero las vistas protegidas no se verificaron en navegador. | Prototipo responsive de la vista prioritaria y QA real de anchos 390/768/1280 px, zoom y teclado. | gps.css, styles.css; entorno autenticado de prueba. | Sin desbordamiento no previsto ni controles ocultos; orden de lectura y acciones verificadas. |

**Total:** 2 P0, 8 P1 y 2 P2. Ningún P0 implica por sí solo que se hayan perdido ubicaciones. Los hallazgos automáticos son cero; la matriz procede de código, capturas y evaluación manual. Algunas filas agrupan varios detalles de una misma tarea para evitar una lista de retoques aislados.

## 4. Diseño de recorrido objetivo

1. **Inventario por nombre y estado:** distinguir borrador, pendiente, identidad activa, instalación GPS activa, servicio observado y último contacto. Filtro “Activos / Pendientes / Suspendidos / Revocados / Todos con permiso”.
2. **Inscripción guiada:** registrar → emitir invitación → escanear → prueba PoP → mostrar código → confirmar presencia → activar identidad → preparar instalación. El paso presente y el siguiente deben ser visibles. No eliminar confirmación física ni ampliar privilegios.
3. **Política:** escoger una política por nombre, revisar zona/horario y asignación por nombre de equipo; mostrar resumen de impacto antes de publicar. UUID en detalles.
4. **Inicio:** la app Android muestra permiso, ventana y estado de servicio; después separa “esperando primera lectura”, “lectura guardada”, “esperando sincronización” y “confirmada”.
5. **Supervisión:** selector persistente, mapa, período rápido y resumen de frescura; al abrir un equipo se ven posiciones y huecos, luego salud y detalle técnico. Una consulta nueva conserva motivo auditado y permisos.
6. **Administración:** acción contextual según estado, motivo y consecuencia explícitos; la revocación conserva historial, bloquea sesiones y requiere confirmación adecuada. Nada se ejecuta automáticamente sobre los cinco equipos existentes.

## 5. Plan por etapas y puertas de verificación

| Etapa | Entrega pequeña | Criterio de cierre |
| --- | --- | --- |
| 0. Evidencia GPS | Línea temporal read-only de un dispositivo de prueba, con event_id y timestamps sin coordenadas en logs; comparar cola y ACK. | El intervalo de 574 s queda explicado como captura, cola, transmisión, filtro o combinación, con evidencia de cada evento. |
| 1. Veracidad de estado | Separar captura/recepción/ACK/cola, edad del dato, mensajes basados en evidencia y filtro aplicado. | Datos antiguos nunca se etiquetan como actuales; vacío indica período, sesión y última consulta. |
| 2. Identidad y fechas | display_label en contrato GPS y Web; presets temporales y conversión UTC. | Operador resuelve nombres sin UUID; pruebas de fecha en Guatemala y otra zona. |
| 3. Cartografía | Mapa con proveedor de teselas aprobado, puntos, precisión, recorrido y tabla accesible. | Pruebas con 0/1/muchos puntos, sin señal y carga fallida; sin dependencia de pago no autorizada. |
| 4. Gestión de dispositivos | Retirar instalación y revocar identidad desde Web con permisos; después diseñar suspensión/reactivación con revisión de seguridad. | API rechaza equipo revocado; historial conserva acceso autorizado; auditoría registra acción y motivo. |
| 5. Navegación y accesibilidad | Priorizar mapa/selector, simplificar Android, separar fixtures, tokens y pruebas de teclado/TalkBack/responsive. | Recorrido completo validado por administrador no técnico en escritorio, tableta y teléfono; pruebas regresivas de autorización/tenant/PoP. |

Antes de implementar, validar con producto y seguridad las definiciones de “suspendido”, “retirado”, “sin comunicación” y la fuente de teselas. No agregar eliminación física, auto confirmación MDM ni procesos ocultos de captura.

## 6. Verificaciones realizadas y pendientes

- **Realizadas:** motores UIAudit e Impeccable; lectura de código y contratos; contraste puntual; navegador local en tres anchuras para login y orden de teclado; capturas aportadas.
- **Pendientes para una auditoría visual completa:** recorrido autenticado con cuenta y datos sintéticos autorizados, capturas de cada ruta a 390/768/1280 px, zoom 200 %, lector de pantalla, TalkBack y prueba física GPS con timestamps de evento. No se infiere un resultado de estas pruebas faltantes.
- **Integridad de esta auditoría:** ningún archivo de aplicación, base, dispositivo o despliegue se modificó; solo se añadió este informe.
