# GEOPS — PRD v1.1

**Producto:** Plataforma de rastreo corporativo y gestión territorial
**Estado:** Alcance funcional confirmado; viabilidad técnica sujeta a validación
**Fecha base:** 15 de octubre de 2026
**Uso:** Documento fuente para SPEC-00 y las waves del repositorio `geops`

> GEOPS es independiente funcionalmente de Inventori y Billing. Puede compartir infraestructura cloud, con aislamiento y migración independientes.

Estado: Alcance funcional definido; dependencias técnicas sujetas a prueba de concepto. Proyecto independiente de Inventori y Billing.


## 1. Resumen ejecutivo

Plataforma web de administración de hasta 25 teléfonos Android corporativos, con agente GPS propio, control MDM, registro de recorridos durante horarios laborales por dispositivo, catálogo territorial de negocios, rutas, verificación recurrente de visitas y tableros de efectividad. Se alojará inicialmente en infraestructura cloud compartida físicamente con otros proyectos, con aislamiento completo de datos, servicios y credenciales y capacidad de migración independiente.


## 2. Objetivos y alcance

Confirmar visitas recurrentes a clientes y detectar puntos vencidos o no verificables.

Proteger el agente Android contra desinstalación ordinaria y modificaciones de políticas mediante Android Enterprise Fully Managed y MDM compatible.

Descubrir y clasificar establecimientos como clientes, prospectos, pendientes, descartados o duplicados.

Medir efectividad por empleado, dispositivo, cliente, ruta, territorio y período.

Recopilar datos operativos para optimización futura de rutas con IA (etapa 2).


### Fuera de alcance v1.1

Optimización automática de rutas con IA, comercialización multiempresa, facturación, integración funcional con Inventori o Billing y garantía de rastreo ininterrumpido o indetectable.


## 3. Actores y acceso

Todos los usuarios autorizados son administradores con acceso completo a dispositivos, rutas, pines, catálogos, alertas y reportes. Se exige autenticación, auditoría de operaciones y control de sesiones. Los empleados portan dispositivos corporativos, sin requerir acceso al panel.


## 4. Requisitos funcionales


| ID | Módulo | Requisito |
| --- | --- | --- |
| RF-01 | MDM | Asistente con enlaces para registro en ManageEngine, vinculación Android Enterprise, autorización API y diagnóstico de conexión. |
| RF-02 | Dispositivos | Importar/sincronizar hasta 25 dispositivos inscritos; asociarlos con empleados; mostrar estado MDM, última conexión y ubicación. |
| RF-03 | Agente Android | Aplicación Kotlin propia, obligatoria por MDM, sin acceso directo de uso cotidiano cuando sea compatible; respetar indicadores de privacidad del SO. |
| RF-04 | Horarios | Definir por dispositivo días, franjas laborales, excepciones y zona horaria; rastreo ordinario exclusivamente dentro de ellas. |
| RF-05 | GPS | Objetivo de captura de una ubicación por minuto, con precisión, timestamps y metadatos; frecuencia real sujeta a prueba técnica. |
| RF-06 | Offline | Almacenar posiciones localmente cifradas sin Internet, si hay señal GPS; sincronizar en orden e idempotentemente al reconectar. |
| RF-07 | Alertas | Alertar por ausencia de heartbeat después de umbral configurable, mostrar última ubicación y distinguir causa confirmada de causa desconocida. |
| RF-08 | Pines | Crear, editar, importar y clasificar pines con coordenadas, categoría, radio, prioridad y requisitos de permanencia. |
| RF-09 | Visitas | Definir frecuencia recurrente por pin/asignación; verificar cumplimiento por dispositivo según evidencias GPS y horarios aplicables. |
| RF-10 | Rutas | Asignar conjuntos ordenados o no ordenados de pines a dispositivos; visualizar rutas planificadas y realizadas. |
| RF-11 | Captación | Descubrir negocios por territorio/categoría usando fuentes abiertas OSM/Overpass; revisión humana y deduplicación. |
| RF-12 | Clientes | Importar catálogo autorizado CSV/XLSX; vincular cliente a cédula del sistema comercial actual; prospectos sin cédula vinculada. |
| RF-13 | Dashboard | Indicadores de cumplimiento, vencidas, no verificables, permanencia, clientes sin cobertura y prospectos. |
| RF-14 | Historial | Conservar posiciones individuales 90 días, con purga automática y controles de exportación y acceso. |
| RF-15 | Auditoría | Registrar altas, modificaciones, cambios de política, importaciones, asignaciones, alertas y consultas sensibles. |


## 5. Reglas de negocio

RN-01: El límite inicial es de 25 dispositivos administrados; se parametriza para crecimiento posterior.

RN-02: Una visita es verificable únicamente con posiciones suficientemente precisas dentro del radio y permanencia mínima configurable; un solo punto ambiguo no garantiza cumplimiento.

RN-03: Cada pin asignado tendrá una frecuencia recurrente configurable (por ejemplo, cada N días laborales o por semana); el cómputo de vencimiento se define por calendario laboral y zona horaria.

RN-04: Estados de ciclo: pendiente, visitado/verificado, vencido y no verificable; ausencia de GPS no equivale automáticamente a incumplimiento.

RN-05: Sin conectividad se conserva última ubicación recibida, claramente etiquetada con su antigüedad. El servidor genera alerta por ausencia de comunicación, no por apagado confirmado salvo evidencia específica.

RN-06: Al reconectar, el sistema recalcula visitas y alertas a partir de timestamps originales, preservando historial de cambios de estado y auditoría.

RN-07: Fuera del horario laboral no se recolecta ubicación ordinaria mediante el agente; se revisarán por separado capacidades de localización del MDM.

RN-08: Los datos externos de establecimientos requieren procedencia, deduplicación, revisión y respeto a licencias de origen; no se infiere una cédula desde datos de mapas.

RN-09: La IA de rutas queda en etapa 2; la etapa 1 genera datos confiables y métricas agregadas para su futura evaluación.


## 6. Arquitectura de referencia

Android Kotlin (servicio de ubicación y buffer Room cifrado) → API HTTPS Node.js/TypeScript → PostgreSQL/PostGIS → motor de visitas recurrentes, alertas y dashboard React/Leaflet. MDM ManageEngine + Android Enterprise administra la instalación y las restricciones. Descubrimiento territorial mediante OpenStreetMap y Overpass, con adaptadores para fuentes adicionales. Importación CSV/XLSX para catálogos comerciales. Se separan procesos, bases de datos, credenciales, redes y despliegues de los otros proyectos del servidor.


### Integración MDM

La API y las funcionalidades de la edición gratuita de ManageEngine deben validarse con una cuenta real. La aplicación GPS propia envía datos directamente a Node.js y no depende de que el MDM exponga GPS por API. El MDM sigue siendo necesario para administración de equipos y protección de la aplicación.


## 7. Requisitos no funcionales

Seguridad: HTTPS/TLS, credenciales por dispositivo revocables, secretos cifrados, auditoría y controles contra suplantación y repetición de lotes.

Resiliencia: reintentos exponenciales, cola persistente, deduplicación, monitoreo, respaldo y restauración probada.

Privacidad: seguimiento laboral comunicado, minimización, restricción temporal, política de retención 90 días y evaluación legal en Costa Rica.

Rendimiento: dimensionamiento inicial para 25 dispositivos y captura objetivo por minuto, con métricas de latencia e ingestión.

Portabilidad: contenedores, configuración externa, migraciones versionadas, backups independientes y procedimiento de traslado a otra nube.

Cartografía: Leaflet y datos OSM, con proveedor de teselas apto para producción; respetar límites de Overpass público y obligaciones ODbL.


## 8. Indicadores del dashboard


| Indicador | Definición funcional |
| --- | --- |
| Cumplimiento | Visitas recurrentes verificadas / visitas exigibles evaluables en el período. |
| Visitas vencidas | Obligaciones de visita cuyo plazo terminó sin visita confirmada, con evidencia suficiente. |
| No verificables | Obligaciones con falta o insuficiencia de datos para concluir cumplimiento. |
| Permanencia | Tiempo estimado dentro del radio de un punto, con calidad de evidencia. |
| Clientes sin cobertura | Clientes activos sin visitas verificadas en su ventana de recurrencia. |
| Prospectos identificados | Establecimientos aprobados como prospectos, filtrables por territorio y categoría. |


## 9. Criterios de aceptación


| ID | Escenario | Resultado esperado |
| --- | --- | --- |
| CA-01 | Dispositivo inscrito Fully Managed | Agente obligatorio y desinstalación ordinaria bloqueada en modelos validados. |
| CA-02 | Sin Internet, con GPS | Capturas en buffer persistente y sincronización sin duplicados al reconectar. |
| CA-03 | Sin GPS | No inventa posiciones; indica intervalo sin evidencia. |
| CA-04 | Sin heartbeat por umbral | Alerta y última ubicación con timestamp; causa desconocida salvo evidencia. |
| CA-05 | Fuera de jornada | Agente no realiza rastreo ordinario y aplica excepciones configuradas. |
| CA-06 | Pin recurrente visitado | Visita confirmada si radio, precisión y permanencia cumplen reglas. |
| CA-07 | Pin recurrente sin visita | Genera estado vencido o no verificable según calidad de datos. |
| CA-08 | Importación de negocios | Valida esquema, detecta duplicados, conserva procedencia y permite revisión. |
| CA-09 | Dashboard | Filtros por empleado, dispositivo, cliente, ruta, territorio y período; cifras reconciliables. |
| CA-10 | Retención | Elimina posiciones al cumplir 90 días conforme a política y respaldos. |
| CA-11 | Separación | No existe acceso a datos ni secretos de Inventori/Billing. |
| CA-12 | Visibilidad Android | Sin icono de uso cotidiano si es compatible, manteniendo avisos obligatorios del SO. |


## 10. Dependencias y validaciones pendientes


| Tema | Validación / decisión pendiente |
| --- | --- |
| MDM | Licencia gratuita, API OAuth, inscripción, instalación obligatoria, restricciones por marca/modelo y políticas de localización. |
| Android | Captura por minuto, reinicios, ahorro de batería, permisos, notificación de primer plano, buffer offline y límites por fabricante. |
| Alertas | Umbrales y escalamiento; diferenciación entre apagado, batería y pérdida de cobertura. |
| Recurrencia | Precisar unidad de período, calendario laboral, tiempo mínimo y radios por tipo de negocio. |
| Fuentes geográficas | Cobertura OSM por territorio, volumen de consultas, licencia, teselas de producción y fuentes complementarias. |
| Clientes | Esquema real del catálogo y formato de importación (CSV/XLSX), cédulas y proceso de reconciliación. |
| Cloud | Capacidad del servidor compartido, dominio, backups, seguridad y costos incrementales. |
| Legal | Aviso de monitoreo, legitimidad de tratamiento, acceso a ubicaciones y retención bajo normativa aplicable. |


## 11. Entregas y etapas


| Etapa | Entregable |
| --- | --- |
| Prueba de concepto | 2 dispositivos reales; MDM, protección, GPS/minuto, offline y desconexión. |
| Etapa 1A | Agente Android, backend, gestión MDM, horarios, mapa e historial. |
| Etapa 1B | Pines, recurrencias, rutas, captación territorial, importación de clientes y dashboard. |
| Etapa 1C | Pruebas de aceptación, hardening, despliegue y operación hasta 25 dispositivos. |
| Etapa 2 | Optimización de rutas con IA/algoritmos, usando datos históricos y restricciones comerciales; costos de modelos por definir. |


## 12. Control de cambios v1.0 → v1.1

Se establece explícitamente el desarrollo de un agente Android GPS propio, con buffer offline y sincronización.

Se incorpora alerta por ausencia de comunicación y diagnóstico posterior de posible causa.

Se agrega captación territorial con OSM/Leaflet/Overpass e importación de catálogos externos.

Se detallan los KPI de efectividad de visitas y clasificación comercial cliente/prospecto.

Se traslada optimización inteligente de rutas a etapa 2.

Se precisa la mínima visibilidad del agente, sin prometer indetectabilidad absoluta.

Se confirma frecuencia recurrente de visitas por pin como modalidad principal.


## 11. Aclaraciones posteriores confirmadas para la planificación

- **Piloto y despliegue:** comenzar con dos dispositivos Android reales y ampliar gradualmente hasta 25 tras validar el funcionamiento.
- **Código y distribución:** monorepo `geops` con `apps/android`, `apps/api`, `apps/web`, `packages/api-contracts`, `infrastructure` y `specs`; builds y despliegues independientes.
- **Fuente primaria de GPS:** agente Kotlin propio. ManageEngine/Android Enterprise administran instalación y políticas; no son el canal principal de ingesta de coordenadas.
- **Ingesta:** HTTPS REST por lotes; autenticación individual por dispositivo; eventos con ID único, marca temporal de captura, deduplicación, confirmación solo después de persistencia y reintentos seguros.
- **Carga estimada:** 25 dispositivos × 8 horas × 60 capturas/hora = 12.000 posiciones por día laboral; hasta 1.080.000 en 90 días si todos los días se rastrean ocho horas. Dimensionar índices, particionado si resulta necesario y política de purga.
- **Sin conectividad:** el agente almacena coordenadas disponibles en buffer local persistente; sincroniza al recuperar Internet. Ausencia de Internet y ausencia de señal GNSS son fallos distintos.
- **Desconexión:** alertar tras un umbral configurable sin heartbeat, mostrando la última ubicación y su antigüedad. No afirmar apagado confirmado sin evidencia; registrar posibles causas al reconectar.
- **Agente Android:** mínima interacción, sin acceso directo de lanzamiento cuando sea compatible, instalación obligatoria y restricciones MDM; no ocultar indicadores o avisos obligatorios de uso de ubicación.
- **Captación comercial:** comenzar con Leaflet + OpenStreetMap + Overpass, sujeto a cobertura y condiciones de uso; admitir importación CSV/XLSX y catálogo propio con procedencia y deduplicación.
- **Revisión comercial:** clasificar como pendiente, cliente, prospecto, descartado o duplicado. Los clientes se vinculan a la cédula provista por el sistema comercial existente mediante carga autorizada; no se asume integración directa.
- **Dashboard:** cumplimiento por empleado, dispositivo, cliente, ruta, territorio y período; visitas vencidas, no verificables, permanencia, clientes sin cobertura y prospectos identificados.
- **IA:** optimización de rutas expresamente diferida a etapa 2. En etapa 1 solo se recolectan datos y métricas útiles, sin integrar APIs de modelos.

## 12. Incertidumbres y puertas de validación para SPEC-00

| Código | Tema | Validación requerida |
| --- | --- | --- |
| VAL-01 | ManageEngine Free | Confirmar condiciones actuales de la licencia, acceso API y políticas disponibles para 25 equipos. |
| VAL-02 | Fully Managed | Probar inscripción real y restricciones en marcas/versiones concretas. |
| VAL-03 | GPS cada minuto | Medir cadencia real con pantalla bloqueada, ahorro de batería y horario laboral. |
| VAL-04 | Buffer offline | Probar persistencia, reinicio, retransmisión, orden e idempotencia. |
| VAL-05 | Sin comunicación | Validar alertas y distinción entre cobertura, apagado y causas desconocidas. |
| VAL-06 | Datos OSM | Revisar cobertura de categorías, límites de Overpass, atribución y ODbL. |
| VAL-07 | Seguridad y privacidad | Validar protección MDM, notificación de seguimiento y restricciones legales aplicables. |
| VAL-08 | Infraestructura | Verificar capacidad y aislamiento del servidor cloud compartido, y procedimiento de migración. |

## 13. Waves previstas

| Wave | Objetivo |
| --- | --- |
| W0 | Fundamentos, arquitectura, seguridad e integración MDM. |
| W1 | Agente Android, horarios, captura GPS, buffer y sincronización. |
| W2 | Ingesta, mapa, historial y alertas de desconexión. |
| W3 | Captación territorial, importación y clasificación comercial. |
| W4 | Rutas, recurrencias, visitas verificadas y vencimientos. |
| W5 | Dashboard de efectividad y reportes. |
| W6 | Integración, pruebas con dos dispositivos y despliegue progresivo. |

## 14. Política de evidencia

Toda afirmación sobre comportamiento de Android, restricciones MDM, licencia gratuita, cadencia GPS y precisión de visitas debe etiquetarse como **confirmada por prueba**, **documentada pero no probada** o **pendiente de validación**. No marcar pruebas físicas como aprobadas sin ejecutarlas.
