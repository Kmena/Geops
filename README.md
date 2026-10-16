# GEOPS

GEOPS es una plataforma empresarial **planificada** para rastrear dispositivos Android durante jornadas laborales, gestionar rutas comerciales, captar establecimientos en un territorio y verificar visitas recurrentes. Este repositorio prepara el trabajo mediante especificaciones y decisiones arquitectónicas; **todavía no contiene aplicaciones ni servicios funcionales**.

El piloto comenzará con **2 dispositivos Android**. El alcance inicial contempla una incorporación gradual de **hasta 25 dispositivos**, sujeta a validar capacidad, consumo de batería, cobertura y operación.

## Objetivos funcionales

- Registrar y sincronizar posiciones de dispositivos autorizados dentro de horarios laborales configurables.
- Mostrar recorridos y posiciones en un mapa y evaluar alertas sobre los datos recibidos.
- Descubrir establecimientos candidatos para la captación territorial y gestionar su revisión.
- Planificar rutas comerciales y comprobar visitas recurrentes.
- Presentar indicadores y reportes para la operación.

Todos estos objetivos están **planificados, no implementados**. Los criterios detallados se incorporarán con el PRD v1.1 y las especificaciones de cada wave.

## Arquitectura prevista

```text
Android (Kotlin) ── lotes GPS por HTTPS ──> API REST (Node.js/TypeScript)
       │                                        │
       └── almacenamiento local (Room)          └── PostgreSQL + PostGIS
                                                      │
                                             Web (React/Leaflet)
```

El agente Android capturará ubicaciones con Fused Location Provider durante un servicio en primer plano, las guardará localmente y programará su sincronización con WorkManager. Cuando haya conectividad, enviará lotes a la API por HTTPS. La API autenticará al dispositivo, validará cada lote, aplicará idempotencia y persistirá los datos espaciales. El cálculo de visitas y alertas se diseñará desacoplado de la ingesta. La frecuencia de captura, la retención y las reglas de reintento están **pendientes de validación**.

**ManageEngine MDM y Android Enterprise** administrarán dispositivos, distribución de la aplicación y restricciones compatibles. **El agente Kotlin propio** realizará la captura y sincronización GPS. El MDM no sustituye la lógica de rastreo, y el agente respetará los indicadores obligatorios de privacidad de Android. El rastreo se limitará a horarios laborales configurables por dispositivo.

| Capa | Tecnología prevista | Responsabilidad |
| --- | --- | --- |
| Agente móvil | Kotlin, Fused Location Provider, Foreground Service, Room, WorkManager | Captura local y sincronización resistente a interrupciones. |
| API | Node.js, TypeScript, REST | Autenticación, validación e ingesta por lotes; servicios de negocio posteriores. |
| Web | React, TypeScript, Leaflet | Operación, mapas y reportes. |
| Datos | PostgreSQL + PostGIS | Persistencia transaccional y espacial. |
| Cartografía y captación | OpenStreetMap, Overpass API | Visualización y descubrimiento territorial inicial. |
| Administración | ManageEngine MDM, Android Enterprise | Aprovisionamiento y políticas de dispositivos. |
| Infraestructura y CI/CD | Docker Compose, reverse proxy, GitHub Actions | Despliegue y automatización independientes. |

El uso de Overpass respetará sus condiciones de uso; una instancia pública no se asumirá como fuente para cargas masivas. La selección del proveedor de teselas, sus límites y la atribución cartográfica están pendientes de validación.

## Organización del repositorio

| Ruta | Responsabilidad |
| --- | --- |
| `apps/android/` | Futura aplicación Android. |
| `apps/api/` | Futura API REST. |
| `apps/web/` | Futura aplicación web. |
| `packages/api-contracts/` | Futuros contratos compartidos de la API. |
| `infrastructure/docker/` | Futuras definiciones de imágenes. |
| `infrastructure/compose/` | Futura configuración de servicios GEOPS. |
| `infrastructure/nginx/` | Futura configuración del reverse proxy. |
| `specs/prd/` | PRD v1.1, fuente principal de requisitos para SPEC-00. |
| `specs/architecture/adr/` | Decisiones arquitectónicas iniciales. |
| `specs/spec-00-technical-feasibility/` | Investigación, contratos y plan de validación previos a las waves. |
| `specs/waves/` | Especificaciones, planes y tareas por wave. |
| `specs/acceptance/` | Criterios y evidencias de aceptación. |
| `docs/development/` | Guías futuras de desarrollo. |
| `docs/deployment/` | Guías futuras de despliegue y migración. |
| `docs/operations/` | Guías futuras de operación. |
| `scripts/` | Scripts de soporte cuando sean necesarios. |
| `.github/workflows/` | Futuras automatizaciones de GitHub Actions. |

Los archivos `.gitkeep` únicamente conservan directorios vacíos en Git. No representan componentes inicializados.

## Desarrollo, pruebas y despliegue

**Requisitos previstos de desarrollo:** Git; un JDK y Android Studio compatibles con la versión de Android que se seleccione; Node.js; PostgreSQL con PostGIS; Docker y Docker Compose. Las versiones, comandos de arranque y variables de entorno se definirán antes de crear cada aplicación. Hoy no hay dependencias que instalar ni proyectos que compilar.

**Estrategia de pruebas prevista:** pruebas unitarias para reglas y validación, integración para API y PostGIS, pruebas del agente con pérdida de conectividad y reinicios, pruebas de extremo a extremo para los flujos principales y un piloto real con 2 dispositivos antes de ampliar a 25. También se validarán consumo de batería, permisos, privacidad, idempotencia y recuperación de lotes. **No se han ejecutado pruebas funcionales** porque aún no hay implementaciones.

**Despliegue previsto:** GEOPS tendrá servicios, base de datos, credenciales, configuración y despliegues propios. Podrá compartir inicialmente un servidor cloud con otros proyectos, pero su configuración y sus datos deberán permitir migrarlo sin depender de ellos. Docker Compose y un reverse proxy se configurarán cuando haya servicios reales; no hay infraestructura desplegada.

## Trabajo guiado por especificaciones

El ciclo de trabajo es **PRD → Specify → Plan → Tasks → Implement → Verify → Archive**. Cada wave tendrá alcance y criterios de aceptación trazables antes de su implementación. El proceso y la secuencia prevista se describen en [specs/README.md](specs/README.md); las decisiones de base están en [los ADR](specs/architecture/adr/).

## Estado y próximos pasos

| Estado | Alcance |
| --- | --- |
| Preparado | Estructura del monorepo, convenciones y ADR iniciales. |
| En curso | SPEC-00 documentado; cierre BLOCKED por API Free y piloto físico pendientes. OAuth e inventario vacío pasaron solo en MSP Trial. |
| Planificado | Agente Android, API, web, mapas, captación, rutas, visitas, alertas y reportes. |
| Pendiente de validación | PRD v1.1, políticas MDM, permisos Android, horarios, retención, cadencia GPS, límites cartográficos y operación del piloto. |

El siguiente paso documental está en [SPEC-01](specs/spec-01-foundation-wave-0a/README.md). Las puertas de entrada permiten únicamente desarrollo sintético de Wave 0A; las validaciones Free y del piloto de [SPEC-00](specs/spec-00-technical-feasibility/README.md) permanecen pendientes.

## Seguimiento documental

El [informe de cierre documental de SPEC-00](specs/spec-00-technical-feasibility/closure-report.md) registra las pruebas OAuth/API realizadas en MSP Trial y mantiene **BLOCKED** la viabilidad operativa hasta validar Free y dos Android.
## SPEC-01 documental

[Wave 0A — Foundation, Device Identity & MDM Integration](specs/spec-01-foundation-wave-0a/README.md) ya tiene especificación, arquitectura, contratos OpenAPI, plan, tareas, pruebas y criterios de entrada. Su estado es **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** solo para datos y dispositivos sintéticos; pruebas de identidad, Free, piloto y producción mantienen las restricciones de [wave-readiness](specs/spec-01-foundation-wave-0a/wave-readiness.md). El diagnóstico OAuth existente en apps/api es una herramienta de desarrollo, no la API de producto; T01–T05 tienen implementación y pruebas locales documentadas; T02 espera validación CI remota.
