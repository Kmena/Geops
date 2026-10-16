# ADR-001 — Monorepo

**Estado:** decisión inicial; pendiente de validar durante el desarrollo.

## Contexto

GEOPS necesita tres aplicaciones con ciclos de construcción y despliegue diferentes, además de contratos y especificaciones compartidos.

## Decisión

Mantener `apps/android/`, `apps/api/` y `apps/web/` en un solo repositorio. Los contratos comunes se ubicarán en `packages/api-contracts/`; la infraestructura y las especificaciones tendrán directorios propios. Cada aplicación conservará su configuración y su ciclo de publicación independiente.

## Consecuencias

La trazabilidad entre contratos, código y documentación será más sencilla. La CI deberá limitar cada trabajo a los componentes pertinentes y evitar acoplamientos de compilación innecesarios. No se crean proyectos ni configuraciones de build en esta etapa.
