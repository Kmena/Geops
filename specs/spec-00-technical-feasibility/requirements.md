# Requisitos y trazabilidad

**DEC-GPS-OFFLINE-001 (2026-10-21):** [ADR-020](../architecture/adr/ADR-020-ultima-politica-valida-offline.md) agrega a RF-04/RF-06 la evaluación local de la última política válida, incluidas nuevas jornadas sin Internet dentro de vigencia explícita. MDM sigue siendo gestión de dispositivo, no dependencia de cada captura. Android puede impedir un inicio automático desde fondo. La factibilidad física y la compatibilidad del contrato actual permanecen abiertas.

**Fuente primaria:** [PRD v1.1](../prd/GEOPS-PRD-v1.1.md). **Fecha:** 2026-10-16. “Confirmado” describe la necesidad de producto; la factibilidad se evalúa por separado. Los parámetros no presentes en el PRD permanecen abiertos en [open-questions.md](open-questions.md).

| PRD | Requisito confirmado | Diseño / evidencia SPEC-00 | Viabilidad |
| --- | --- | --- | --- |
| RF-01 | Asistente MDM: registro, Android Enterprise, API y diagnóstico | [research](research.md), [architecture](architecture.md) | API en Free UNKNOWN; cuenta real requerida |
| RF-02 | Hasta 25 dispositivos, asociación y estados | [data-model](data-model.md), [api-contracts](api-contracts.md), [vínculo MDM](device-provisioning.md) | Importación API Free y vínculo operativo UNKNOWN |
| RF-03 | Agente Kotlin administrado, mínima interacción | [architecture](architecture.md), [identidad v1](identity-api-contract.md), [pilot](pilot-test-plan.md) | Protocolo decidido; entrega/attestation PENDING_PHYSICAL_VALIDATION |
| RF-04 | Horarios por dispositivo, días, excepciones y zona | [business-rules](business-rules.md), [architecture](architecture.md) | Diseño propuesto; inicio automático pendiente |
| RF-05 | Objetivo de una ubicación por minuto | [research](research.md), [pilot](pilot-test-plan.md) | No garantizado por Android |
| RF-06 | Buffer local cifrado y sincronización idempotente | [architecture](architecture.md), [api-contracts](api-contracts.md) | Cifrado concreto y hardware pendientes |
| RF-07 | Alertas por ausencia de heartbeat | [business-rules](business-rules.md), [data-model](data-model.md) | Umbral pendiente |
| RF-08 | Pines con radio, categoría, prioridad y permanencia | [data-model](data-model.md), [business-rules](business-rules.md) | Umbrales pendientes |
| RF-09 | Recurrencia y verificación de visitas | [business-rules](business-rules.md), [data-model](data-model.md) | Semántica propuesta; criterios pendientes |
| RF-10 | Rutas asignadas y realizadas | [data-model](data-model.md), [business-rules](business-rules.md) | Orden y cambios versionados propuestos |
| RF-11 | Captación OSM/Overpass con revisión | [research](research.md), [business-rules](business-rules.md) | Cobertura territorial pendiente |
| RF-12 | Importación CSV/XLSX y cédula comercial | [data-model](data-model.md), [business-rules](business-rules.md) | Esquema real pendiente |
| RF-13 | Dashboard y filtros | [business-rules](business-rules.md), [data-model](data-model.md) | Fórmulas y ventanas por acordar |
| RF-14 | Historial GPS 90 días y purga | [data-model](data-model.md), [architecture](architecture.md) | Diseño propuesto; respaldo pendiente |
| RF-15 | Auditoría de operaciones y consultas sensibles | [architecture](architecture.md), [data-model](data-model.md) | Política de acceso y retención pendiente |

## Reglas y aceptación

| Identificadores PRD | Documento que los desarrolla |
| --- | --- |
| RN-01, RN-05, RN-07, RN-09 | [business-rules.md](business-rules.md), [architecture.md](architecture.md) |
| RN-02, RN-03, RN-04, RN-06, RN-08 | [business-rules.md](business-rules.md), [data-model.md](data-model.md) |
| CA-01–CA-05, CA-10–CA-12 | [pilot-test-plan.md](pilot-test-plan.md), [wave-readiness.md](wave-readiness.md) |
| CA-06–CA-09 | [business-rules.md](business-rules.md), [pilot-test-plan.md](pilot-test-plan.md) |
| VAL-01–VAL-08 | [research.md](research.md), [risks.md](risks.md), [pilot-test-plan.md](pilot-test-plan.md) |

## Requisitos no funcionales confirmados

HTTPS/TLS, credenciales individuales revocables, auditoría, datos separados de Inventori/Billing, retención de 90 días, respaldo y restauración, portabilidad, privacidad laboral y capacidad para el piloto de 2 y escala inicial de 25. El PRD sitúa la evaluación legal en Costa Rica; este spec no sustituye esa revisión. La optimización de rutas con IA queda en etapa 2; no se diseña una integración de modelos en etapa 1.

## Parámetros que no se deben inventar

Radios y permanencia por pin, precisión mínima, tolerancia de huecos GPS, umbral de desconexión, calendario laboral, semántica exacta de recurrencia, formato de cédula, columnas de importación, SLA, políticas de retención de backups, modelos Android y edición/tenant MDM. Se registran en [open-questions.md](open-questions.md).

## Requisitos MDM de decisión de negocio — 2026-10-19

Los requisitos originales de esta solicitud permanecen **vigentes sin cambio** hasta aprobación formal de negocio. Su [matriz y evidencias](mdm-business-decision.md) no sustituyen RF-01–RF-03 ni RN-07 del PRD.

| ID | Requisito original | Estado de viabilidad al corte |
| --- | --- | --- |
| MDM-001 | GEOPS no puede ser desinstalado por un usuario estándar. | DOCUMENTADO_CONDICIONAL según modo y distribución; pendiente en A/B. |
| MDM-002 | El usuario no puede desactivar la ubicación durante el horario laboral. | DOCUMENTADO_CONDICIONAL en Device Owner; Work Profile/COPE no acreditan el control global; pendiente en A/B. |
| MDM-003 | Conservar las aplicaciones y los datos existentes sin restablecimiento de fábrica. | `NO_CUMPLE` con alta ordinaria Fully Managed en equipos usados; ADB sin reset `UNKNOWN` para preservación íntegra. |
| MDM-004 | Compatibilidad con 25 teléfonos Android multimarca. | `UNKNOWN` hasta inventario de 25 y pruebas por familias; Knox no cubre por sí solo otras marcas. |
| MDM-005 | Administración centralizada desde GEOPS Web. | `UNKNOWN`: API Free, scopes de escritura y estado aplicado no validados. |
| MDM-006 | Respetar indicadores y notificaciones obligatorios de Android y las políticas de privacidad aplicables. | Requisito vigente; revisión de avisos, seguridad y privacidad pendiente. |
