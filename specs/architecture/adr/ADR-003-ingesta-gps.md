# ADR-003 — Ingesta GPS

**Estado:** decisión inicial; detalles del contrato pendientes.

## Contexto

Los dispositivos pueden pasar períodos sin conexión y reenviar datos. La ingesta debe tolerar duplicados y mantener un tiempo de respuesta predecible.

## Decisión

Los dispositivos enviarán ubicaciones por lotes a una API REST sobre HTTPS. La API autenticará cada dispositivo, validará el contenido, aplicará idempotencia y persistirá posiciones en PostgreSQL/PostGIS. El procesamiento de visitas y alertas quedará desacoplado de la recepción de lotes.

## Consecuencias

Antes de implementar habrá que especificar identificadores estables de muestra/lote, límites, marcas de tiempo, política de reintentos, manejo de errores, retención y la forma de procesar eventos posteriores. Los contratos vivirán en `packages/api-contracts/` cuando se definan.
