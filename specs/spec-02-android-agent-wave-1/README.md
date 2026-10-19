# SPEC-02 — Agente Android y políticas remotas GPS

**Estado: W1-A CLOSED_FOR_SYNTHETIC_IMPLEMENTATION — línea base de diseño aprobada solo para iniciar W1-B sintético.** Corte: 2026-10-19. SDD: [Specify](requirements.md) → [Plan](plan.md) → [Tasks](tasks.md). **Solo GEOPS Web configura políticas**; el backend es su fuente autoritativa y Android las descarga, valida y ejecuta. MDM sigue línea independiente y no bloquea diseño ni desarrollo sintético sin privilegios MDM. No se declara interoperabilidad de producto ni contrato operativo congelado.

| Documento | Propósito |
| --- | --- |
| [requirements.md](requirements.md) | Requisitos y aceptación trazable |
| [architecture.md](architecture.md) | Fronteras, flujo y ejecución Android |
| [data-model.md](data-model.md) | Políticas, sesiones, eventos, posiciones y retención |
| [api-contracts.md](api-contracts.md) | Contratos HTTP propuestos |
| [openapi.design.yaml](openapi.design.yaml) | OpenAPI 3.1 de diseño, no superficie desplegada |
| [research.md](research.md) | PoC, evidencia agregada y restricciones Android |
| [test-plan.md](test-plan.md) | Pruebas sintéticas, físicas y criterios de salida |
| [risks.md](risks.md) | Riesgos y controles |
| [plan.md](plan.md), [tasks.md](tasks.md) | Waves pequeñas y trabajo ejecutable |
| [wave-readiness.md](wave-readiness.md) | Gates W1-A–E y P0 abiertos/cerrados |
| [contract-review-2026-10-19.md](contract-review-2026-10-19.md), [contract-vectors.test.mjs](contract-vectors.test.mjs) | Revisión cruzada y 12 vectores ejecutables de referencia |
| [readiness-audit-2026-10-19.md](readiness-audit-2026-10-19.md) | Auditoría de entrada W1-A; se conserva como evidencia histórica |
| [w1-b-implementation-2026-10-19.md](w1-b-implementation-2026-10-19.md) | Implementación sintética de T03–T04, evidencia y gates pendientes |
| [gps-health-change-proposal.md](gps-health-change-proposal.md) | Delta SDD GPS-HEALTH-001 aceptado solo para backend sintético; baseline SPEC-01 intacto |
| [gps-health-backend-2026-10-19.md](gps-health-backend-2026-10-19.md) | Evidencia de migración, API, pruebas y gates pendientes de salud |
| [w1-c-implementation-2026-10-19.md](w1-c-implementation-2026-10-19.md) | Código Kotlin sintético, pruebas y gates abiertos |
| [w1-d-web-2026-10-19.md](w1-d-web-2026-10-19.md) | Interfaz administrativa GPS con fixtures, evidencia y gates de integración |
| [w1-e1-readiness-2026-10-19.md](w1-e1-readiness-2026-10-19.md) | Integración parcial autenticada de configuración/salud, paridad Kotlin, restore desechable y bloqueos E1 |
| [w1-e1-c2-sessions-positions-2026-10-19.md](w1-e1-c2-sessions-positions-2026-10-19.md) | Corte 2: ingesta/reconciliación sintética de sesiones y posiciones, evidencia PostGIS/Kotlin y gates abiertos |
| [w1-e1-c3-scheduler-activation-web-2026-10-19.md](w1-e1-c3-scheduler-activation-web-2026-10-19.md) | Corte 3: scheduler, activación, concesiones y lectura Web autenticada sintéticas; gates de cierre abiertos |
| [staging-readiness-2026-10-19.md](staging-readiness-2026-10-19.md) | Consolidación Git, Compose Staging aislado, resultados y procedimientos propuestos sin desplegar |
| [staging-path-readiness-2026-10-19.md](staging-path-readiness-2026-10-19.md) | Addendum de acceso Staging bajo `/staging/` con Caddy y certificado de la PoC, sin despliegue |
| [staging-path-security-review-2026-10-19.md](staging-path-security-review-2026-10-19.md) | Revisión de origen compartido, Kotlin/PoP, pruebas sintéticas y decisión condicional |

Decisiones W1-A: [ADR-015 capacidades administrativas](../architecture/adr/ADR-015-capacidades-administrativas-gps.md), [ADR-016 sesión canónica](../architecture/adr/ADR-016-identidad-sesiones-gps.md) y [ADR-017 política temporal/offline](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md). No sustituyen ADR-012/013 ni levantan sus gates.

Esta SPEC no modifica ni despliega la [PoC](../../experiments/weekend-gps-poc/README.md), no consulta su servidor, no activa seguimiento, no toca Inventori o Billing y no aprueba datos reales. [SPEC-00](../spec-00-technical-feasibility/wave-readiness.md) sigue BLOCKED. [SPEC-01](../spec-01-foundation-wave-0a/wave-readiness.md) conserva autorización sintética parcial, con identidad y controles aún pendientes. Ningún dato de coordenadas o identificador personal del fin de semana se incorpora aquí.

## Gates siguientes

1. Implementar y probar W1-B en PostgreSQL desechable con capacidades, exclusión temporal, locks e idempotencia; ejecutar los vectores también contra backend real antes de integrar.
2. Aprobar privacidad, avisos y riesgo residual offline antes de captura real.
3. Versionar los contratos de diseño aprobados en `packages/api-contracts/` al iniciar W1-B, sin confundir generación de tipos con paridad Kotlin/PostgreSQL; el archivo de diseño no altera SPEC-01.
4. Resolver identidad y aprovisionamiento real sin atribuir capacidad no validada a ManageEngine Free.
