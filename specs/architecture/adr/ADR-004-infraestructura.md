# ADR-004 — Infraestructura

**Estado:** decisión inicial; topología de despliegue pendiente.

## Contexto

GEOPS puede compartir inicialmente un servidor cloud, pero debe conservar autonomía operativa y permitir una migración futura.

## Decisión

GEOPS tendrá servicios, base de datos, credenciales, configuración y despliegues independientes. Se prevén Docker Compose y un reverse proxy para su ejecución. La documentación de despliegue deberá permitir trasladarlo a otro servidor sin depender de aplicaciones ajenas.

## Consecuencias

Habrá que definir redes, respaldo y restauración, observabilidad, manejo de secretos, dominios y capacidad antes del despliegue. Compartir el servidor no implicará compartir datos, credenciales ni pipelines de publicación.
