# Extracción y análisis privado del fin de semana GPS

## Alcance auditado

Fuente: `api/schema.sql`, `api/store.mjs`, `api/validation.mjs`, `api/app.mjs`, `api/server.mjs`, `infra/compose.cloud.yaml` y el servicio Android. `public.poc_location` contiene `device_id`, `event_id`, `captured_at`, `received_at`, `geom`, `accuracy_m` y `digest`; la identidad se verifica contra `public.poc_device.environment_id`. La clave `(device_id,event_id)` impide observar reintentos idénticos como filas duplicadas. No existe una tabla de sesiones ni eventos persistidos de inicio/detención. El servicio Android guarda contadores y estado de red localmente; no llegan a PostgreSQL. La API purga cada hora por `received_at` según `POC_RETENTION_HOURS` y también purga al iniciar. El valor de ejemplo es 72 horas; consultar el valor operativo sin imprimir otros secretos. La lectura histórica por API está limitada a 5000 filas, por eso esta herramienta consulta solo el servicio `poc-db` de la PoC.

## Requisitos y validación local

- Ubuntu 24.04, Node.js >=24 y Docker Compose; checkout en `/opt/geops-poc`.
- El proyecto `geops-weekend-poc` y el servicio `poc-db` deben estar activos. No se inicia ningún servicio ni se ejecuta migración.
- `infra/.env.local` debe existir como archivo regular privado, por ejemplo modo `600`. Compose usa sus credenciales existentes; la herramienta no las lee ni imprime.
- Desde `/opt/geops-poc/experiments/weekend-gps-poc`: `node --test --test-isolation=none analysis/analysis.test.mjs`.
- La comprobación del esquema vivo se realiza automáticamente, en transacción de solo lectura, justo antes de extraer. Hasta entonces la concordancia con el servidor no está verificada.
- Si falla, el comando indica la etapa y un código seguro (`ENV_PERMISSIONS`, `COMPOSE_CONFIG`, `DB_SERVICE_UNAVAILABLE`, `DB_AUTH`, `SCHEMA_MISMATCH`, `SCHEMA_SQL`, `QUERY_TIMEOUT` o `QUERY_FAILED`). Nunca muestra el stderr bruto de Compose/psql, que podría contener datos de conexión. Comprobar primero que el checkout está actualizado, que `infra/.env.local` tiene modo `600` y que `poc-db` está en ejecución dentro de `geops-weekend-poc`; no compartir el contenido del archivo de entorno.

## Extracción real — requiere autorización explícita previa

Los límites son instantes UTC con `Z`: inicio inclusivo y fin exclusivo. Elegir las fechas reales del experimento; no se asume qué fin de semana fue. La retención podría haber eliminado puntos anteriores. El comando no se ha ejecutado contra el servidor.

```bash
cd /opt/geops-poc/experiments/weekend-gps-poc
node analysis/extract.mjs --from 2026-10-17T00:00:00Z --to 2026-10-19T00:00:00Z
```

Para restringir a un dispositivo, añadir `--device UUID`. El UUID sirve solo como filtro y no se escribe en los extractos. La salida imprime la ruta privada creada y conteos, nunca coordenadas. Cambiar las fechas del ejemplo según la sesión autorizada. La herramienta rechaza fechas futuras, rangos inválidos, esquema inesperado y archivos de entorno con permisos abiertos. Limita la salida SQL a 100 MiB y la consulta a 5 minutos; si se excede, se debe dividir el período en rangos autorizados sin solaparlos.

## Análisis

Usar la ruta indicada por el extractor:

```bash
node analysis/analyze.mjs --input /opt/geops-poc/experiments/weekend-gps-poc/.private-gps-analysis/run-XXXXXXXXXX/positions.json
```

Parámetros opcionales: `--session-gap-min 10` y `--tolerance-sec 15`. El análisis genera `analysis.json` y `report.md` en el mismo directorio y rechaza sobrescribirlos. `positions.csv` y `positions.json` incluyen coordenadas, tiempos UTC de captura/recepción, precisión y seudónimo del dispositivo, sin `device_id`, `event_id`, hash, token o credenciales. El seudónimo `device_001` se asigna de nuevo en cada extracción y no enlaza ejecuciones. `manifest.json` contiene período y conteos. PostgreSQL conserva el instante de un `timestamptz`, no el offset ni la representación textual original; se exporta en UTC con seis decimales.

## Método e interpretación

- Los límites de sesión se infieren si el intervalo entre capturas consecutivas del mismo dispositivo es **mayor** a 10 minutos. Todas las sesiones se marcan `inferred_from_capture_gap`; no se usa la latencia de recepción para separarlas.
- Los intervalos entre sesiones se excluyen de la cadencia. Objetivo: 60 ± 15 segundos, inclusive. Una sesión de un punto no tiene porcentaje evaluable. Se informa media, mediana, p95 de rango más cercano y máximo.
- Una sincronización tardía es `received_at - captured_at > 120 s`. Es una observación de latencia, no prueba de pérdida de Internet. Latencias negativas se cuentan como posible desfase de reloj y se excluyen de los percentiles.
- Un tramo de hasta 180 s es estacionario si la distancia entre centros no supera la suma de precisiones. Es móvil si el desplazamiento mínimo tras restar esas precisiones es al menos 0.5 m/s. Un mínimo superior a 55 m/s es un salto sospechoso. Los demás tramos son inciertos. Más de 180 s nunca se une para estimar velocidad ni distancia.
- La distancia suma solo tramos móviles; se da la suma entre centros y una cota inferior descontando precisión. No es distancia real del trayecto. No se conectan sesiones.
- `exact_coordinate_time_duplicates` cuenta filas con la misma hora de captura y coordenadas exactas, no reintentos de `event_id`. Las coordenadas repetidas con tiempos distintos son compatibles con estar parado. `out_of_order_received_pairs` cuenta inversiones entre horas de recepción **distintas**; empates se informan como ambiguos.
- `capture_gaps` enumera pausas entre posiciones persistidas superiores a 75 s; `intervals_beyond_target_tolerance` las cuenta. No prueban ausencia de captura. Podrían faltar datos por retención, pérdida de fix, detención, rechazo o sincronización pendiente.

Consultar [seguridad](security.md) antes de manejar archivos y [plantilla](report-template.md) para completar evidencia del teléfono y del operador.
