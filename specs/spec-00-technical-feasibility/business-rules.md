# Reglas de negocio y casos límite

**Estado:** diseño propuesto para desarrollar [PRD RN-01–RN-09 y RF-02, RF-04, RF-07–RF-13](../prd/GEOPS-PRD-v1.1.md). Los umbrales no presentes en el PRD no se convierten en hechos; se registran en [open-questions.md](open-questions.md). Las evaluaciones usan `captured_at`, zona IANA y versiones vigentes en ese instante.

## Dispositivos, asignación y jornada

- **BR-01 / RN-01:** máximo inicial parametrizado de 25 dispositivos activos administrados. El piloto usa dos. Un dispositivo tiene identidad propia y a lo sumo una asignación activa a empleado por instante. Reasignar cierra la vigencia anterior; no cambia el dueño histórico de posiciones ni visitas.
- **BR-02 / RF-04, RN-07:** calendario por dispositivo con días, franjas, excepciones y zona IANA. Una franja que cruza medianoche es un intervalo continuo desde fecha local de inicio hasta fecha local siguiente. Días festivos/no laborables y cambios de zona usan versión efectiva; no se reinterpreta el pasado con la configuración nueva.
- **BR-03 / RN-07:** fuera de jornada el agente cancela solicitudes de ubicación y no guarda posición ordinaria. Se permite subir backlog sin pedir ubicación si la política lo aprueba. Si la ubicación se capturó fuera de jornada, se descarta como no autorizada y se audita solo el diagnóstico mínimo; una ubicación capturada dentro de jornada que llegue después del cierre conserva su hora original. Cambios de horario durante desconexión requieren política de vigencia y caducidad de configuración por aprobar.

## Pines, establecimientos, clientes y rutas

- **BR-04 / RF-08:** pin con coordenada, radio, prioridad, permanencia y vigencia. Radio y precisión son parámetros por tipo/pin; no existe un valor universal confirmado. Versionar cambios para que una visita anterior se evalúe con la regla anterior.
- **BR-05 / RF-11, RN-08:** un resultado Overpass/OSM es candidato con procedencia/licencia. Deduplicar por ID de origen cuando exista y por revisión de proximidad/nombre para otras fuentes; nunca fusionar automáticamente dos clientes. Un humano clasifica pendiente, cliente, prospecto, descartado o duplicado.
- **BR-06 / RF-12:** CSV/XLSX se valida antes de aplicar; importación atómica o por filas con informe de errores según decisión de producto. La cédula comercial llega de catálogo autorizado y se conserva como texto; no se infiere desde mapas ni se asume integración en línea con otro sistema. Prospecto puede carecer de cédula.
- **BR-07 / RF-10:** ruta asignada a dispositivo/empleado y versionada por vigencia; pines ordenados o no según configuración. Una reasignación o cambio de ruta afecta solo obligaciones futuras salvo instrucción explícita auditada. La ruta realizada se deriva de evidencia, no de un trazo artificial entre puntos faltantes.

## Recurrencia y verificación

- **BR-08 / RN-03:** cada regla recurrente genera obligaciones por ventana local y calendario laboral: por semana o cada N días laborales, con ancla y fecha límite definidas en la regla. No se duplica una obligación al recalcular. Faltan decisiones sobre ancla, tolerancia, feriados y vencimiento exacto.
- **BR-09 / RN-02:** una visita se **verifica** solo con evidencia suficiente: varias posiciones de calidad aceptable, distancia compatible con radio y permanencia mínima. Una propuesta conservadora es exigir `distancia_al_pin + accuracy_m <= radio_m` en muestras relevantes y un lapso observado que cubra la permanencia; el criterio final requiere calibración física. No se verifica por una sola muestra ni por mera ruta planificada. La señal fusionada puede ser imprecisa o tardía.
- **BR-10 / RN-04:** estados de obligación: `pending` antes del plazo; `verified` con evidencia; `overdue` después del plazo **solo si** la cobertura de datos permite concluir ausencia de visita; `unverifiable` si faltan posiciones, precisión, comunicaciones o continuidad para concluir. La definición cuantitativa de “cobertura suficiente” queda abierta. Un vencimiento sin datos no implica incumplimiento del empleado.
- **BR-11 / RN-06:** posiciones recibidas tarde o fuera de orden disparan recálculo de las ventanas afectadas. Una obligación puede pasar de `overdue`/`unverifiable` a `verified`; se conserva historial de transiciones, cálculo anterior, evidencia y momento de llegada. Una corrección administrativa también se audita.
- **BR-12 / RF-07, RN-05:** ausencia de heartbeat tras umbral configurable **durante jornada** abre alerta de “sin comunicación”, con última ubicación y antigüedad. La causa se marca desconocida hasta contar con evidencia de dispositivo/operador. No se afirma apagado solo por silencio; fuera de jornada no se genera alerta por no emitir heartbeat. Tras reconexión se cierra o recalifica sin borrar el historial.

## Indicadores e historial

- **BR-13 / RF-13:** cumplimiento = verificadas / exigibles evaluables en período; las no verificables se muestran aparte y no se convierten silenciosamente en incumplimientos. Dashboard filtra por empleado, dispositivo, cliente, ruta, territorio y período usando vigencias históricas. “Clientes sin cobertura” exige definir ventana y denominador; prospectos cuentan solo tras aprobación.
- **BR-14 / RF-14:** posiciones crudas individuales se purgan a 90 días desde captura; exportación y consultas sensibles se auditan. Plazo de respaldos y datos derivados sigue abierto.
- **BR-15 / RN-09:** la optimización IA no participa en la asignación ni en los KPI de etapa 1.

## Matriz de casos límite

| Caso | Tratamiento propuesto | Pregunta de cierre |
| --- | --- | --- |
| GPS impreciso o solo ubicación aproximada | Conservar calidad; no verificar si no alcanza umbral; estado no verificable cuando corresponda. | Radio, accuracy y permanencia por pin. |
| Ubicación atrasada o fuera de orden | Ordenar por captura, recalcular y auditar transición. | Plazo máximo de atraso aceptable. |
| Reconexión tras vencimiento | Recalcular usando versiones históricas; no reescribir auditoría. | Fecha de congelamiento de reportes. |
| Cambio de horario/ruta | Versionar con `effective_from`; no aplicar retroactivamente por defecto. | Excepciones retroactivas autorizadas. |
| Duplicado de evento/lote | Unicidad `(device_id,event_id)`; mismo payload ACK duplicado, diferente payload conflicto. | Política de cuarentena. |
| Dispositivo reasignado | Asociar eventos/visitas al empleado válido en captura. | Manejo de entregas durante una ventana abierta. |
| Pérdida prolongada de Internet | Buffer local hasta límite aprobado; alerta servidor por silencio; no inventar posiciones. | Cuota local y respuesta al llenarse. |
| Horario cruza medianoche | Intervalo anclado al día local de inicio y convertido a UTC. | Regla de recurrencia al cruzar día. |
| Día no laboral/feriado | Sin rastreo salvo excepción; obligación se desplaza según calendario aprobado. | Fuente y autoridad del calendario. |
| Sin señal GNSS pero con Internet | Si FLP entrega posición fusionada, se conserva con su precisión y se evalúa; si no entrega ubicación válida, heartbeat informa ausencia de fix. No se inventa causa física. | Diagnóstico permitido y umbral. |
| Reloj del dispositivo alterado | Guardar captura y recepción, marcar anomalía, no usar para verificación automática. | Tolerancia y resolución manual. |
| Evento que llega después de 90 días | No retener ubicación cruda fuera de política; rechazo/cuarentena con mínima auditoría. | Política explícita de late data. |
