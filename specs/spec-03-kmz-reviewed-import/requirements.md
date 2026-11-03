# Requisitos y trazabilidad — SPEC-03

**Estado:** requisitos alineados con D-01–D-08 aprobadas el 2026-11-03; W1_A_TECHNICAL_PASS limitado al catálogo base según [w1-a-evidence.md](w1-a-evidence.md). W1-B y W2–W6 pendientes. IR identifica requisito; P identifica prueba en [test-plan.md](test-plan.md); D identifica sección de [design.md](design.md).

| ID | Resultado verificable | Origen | Diseño | Prueba |
| --- | --- | --- | --- | --- |
| IR-01 | Carga KMZ con hash y diagnóstico sin alterar tablas operativas. | PRD RF-08/12 | D1–D2 | P01–P04 |
| IR-02 | Rechaza ZIP/XML corrupto o peligroso mediante cuotas y extracción segura. | Seguridad | D2 | P02–P03 |
| IR-03 | Conserva estructura y valores originales mientras normaliza nombres, códigos y WGS84. | PRD RF-08/12 | D2–D3 | P01, P05 |
| IR-04 | Clasifica NEW, EXISTING_MATCH, POSSIBLE_DUPLICATE, CONFLICT e INVALID; 50/250 m configurables solo generan candidatos, nunca identidad. | PRD CA-08; D-01/02 | D3 | P05–P08, P19 |
| IR-05 | Detecta códigos repetidos, copias, outliers, ejemplos, ambigüedad y paradas sin cliente. | KMZ de referencia | D3 | P06, P09 |
| IR-06 | Ofrece tabla, comparación lado a lado y mapa sincronizados, accesibles y filtrables. | Solicitud | D4 | P10 |
| IR-07 | Permite crear candidato geográfico, vincular a cliente autorizado, corregir, actualizar solo campos seleccionados y excluir; nunca fusiona por similitud. | PRD RF-12; D-01/08 | D4 | P07, P10, P19 |
| IR-08 | Mantiene grupos separados de rutas; paradas candidatas exigen cliente/pin; polígonos/línea solo staging; ruta DRAFT sin visitas automáticas. | PRD RF-10, BR-07; D-03/04 | D5 | P09, P11 |
| IR-09 | Presenta plan exacto y bloquea conflictos no resueltos o catálogo obsoleto. | Integridad | D6 | P12 |
| IR-10 | Aplica en una transacción, con idempotencia y control de concurrencia. | Integridad | D6 | P13–P16 |
| IR-11 | Separa capacidades read/write/confirm; audita archivo, actores, originales, decisiones y resultados; TTL temporal propuesto de 30 días sujeto a política. | PRD RF-15; D-06/07 | D7 | P04, P17 |
| IR-12 | No cambia captura GPS, posiciones fuera de ruta ni visitas históricas. | ADR-003/010, BR-07/09 | D5–D6 | P18 |

## Criterios de aceptación

1. **CA-01:** carga, parseo, revisión, corrección, reanálisis, cancelación y expiración dejan sin cambios las tablas operativas.
2. **CA-02:** entradas corruptas o maliciosas se rechazan con motivo seguro; ninguna lectura sale del almacenamiento temporal ni resuelve recursos de red.
3. **CA-03:** cada fila conserva original y muestra propuesta, candidatos, distancia y regla de comparación; tabla y mapa se seleccionan mutuamente. Una geometría no representable continúa visible en tabla.
4. **CA-04:** una coincidencia ambigua nunca se fusiona o actualiza sin seleccionar explícitamente destino, campos y motivo. El KMZ no crea customer comercial sin fuente autorizada; campos ausentes no se sobrescriben.
5. **CA-05:** resumen previo y resultado posterior reconcilian cantidades por acción y entidad; una parada sin cliente no genera visita y un polígono/línea no se publica en el alcance inicial.
6. **CA-06:** dos confirmaciones equivalentes producen un solo efecto y el mismo resultado; clave reutilizada con plan diferente falla. Dos administradores no aplican planes divergentes.
7. **CA-07:** fallo antes de commit deja cero cambios; timeout posterior a commit se recupera por consulta o reintento sin duplicar.
8. **CA-08:** un cambio de catálogo durante revisión exige nueva comparación y aprobación. No hay reescritura histórica.
9. **CA-09:** auditoría permite reconstruir decisión y efecto por fila, sin volcar datos de clientes en logs generales; read/write/confirm se deniegan por defecto y expiración temporal no borra ledger.

## Fuera de alcance

Optimización automática, inferir cédula desde mapas, convertir toda carpeta en ruta, asignar visitas por mera importación, fusionar clientes automáticamente, cambiar políticas GPS o recalcular visitas pasadas. D-04 deja publicación de polígonos y línea fuera del alcance inicial.
