# ADR-005 — Mapas y captación

**Estado:** decisión inicial; fuentes y límites pendientes de validar.

## Contexto

La operación necesita visualizar recorridos y descubrir establecimientos candidatos sin introducir una dependencia temprana de un proveedor cartográfico cerrado.

## Decisión

La web usará React y Leaflet para mostrar datos sobre cartografía de OpenStreetMap. Overpass API será la fuente inicial de descubrimiento territorial, respetando sus condiciones de uso. No se dependerá de instancias públicas de Overpass para cargas masivas.

## Consecuencias

Se deberán validar atribución, proveedor de teselas, límites de consulta, calidad y actualización de datos, caché y una alternativa operativa para volúmenes mayores. Los resultados de Overpass serán candidatos para revisión, no establecimientos verificados automáticamente.
