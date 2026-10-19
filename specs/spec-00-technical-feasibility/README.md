# SPEC-00 — Technical Feasibility & Architecture Readiness

**Estado: BLOCKED (cierre documental).** El diseño base es trazable, pero la integración MDM exigida por RF-01/RF-02 tiene OAuth validado solo en MSP Cloud Trial; la consulta autenticada `GET /customers` sin `X-CUSTOMER` respondió HTTP 302. El ID numérico se confirmó por Customer Details y GET de dispositivos respondió HTTP 200 con arreglo vacío en Trial. No existe evidencia de API en Free ni de dos teléfonos inscritos. El protocolo de aprovisionamiento del agente ya tiene decisión de diseño en ADR-012, pero su entrega y vinculación MDM deben validarse en los teléfonos. Las pruebas en teléfonos siguen **PENDING_PHYSICAL_VALIDATION**. Este estado no significa que el piloto haya fallado: todavía no se ha ejecutado.

**Fuente de requisitos:** [GEOPS — PRD v1.1](../prd/GEOPS-PRD-v1.1.md), presente en el workspace al iniciar este spec, pero aún sin seguimiento por Git. No se modifica aquí. Se usa el contenido disponible, sin interpretar sus incertidumbres como requisitos cerrados.

**Fecha de consulta documental:** 2026-10-16. **Alcance:** diseño y validación, sin funcionalidades de producto ni infraestructura desplegada. La herramienta OAuth de diagnóstico local y sus pruebas simuladas se documentan en `docs/development/mdm-oauth-local.md`.

## Entregables y lectura recomendada

1. [requirements.md](requirements.md): trazabilidad RF/CA/VAL y clasificación de evidencia.
2. [research.md](research.md): fuentes oficiales, límites y pruebas pendientes.
3. [architecture.md](architecture.md): flujo GPS, Android, seguridad e infraestructura.
4. [data-model.md](data-model.md): entidades, índices y retención.
5. [api-contracts.md](api-contracts.md): contratos candidatos y semántica de ingesta.
6. [business-rules.md](business-rules.md): estados y casos límite.
7. [risks.md](risks.md): riesgos priorizados y mitigación.
8. [pilot-test-plan.md](pilot-test-plan.md): matriz para dos teléfonos reales.
9. [wave-readiness.md](wave-readiness.md): puertas de cierre e inicio de Wave 0.
10. [open-questions.md](open-questions.md): decisiones y datos faltantes.
11. [mdm-free-api-validation.md](mdm-free-api-validation.md): tenant MSP Trial, endpoints y matriz M01–M10 con resultados reales sanitizados.
12. [device-provisioning.md](device-provisioning.md): inscripción, PoP, rotación, revocación y amenazas.
13. [identity-api-contract.md](identity-api-contract.md): mensajes y estados v1 de inscripción, sesión y rotación.
14. [wave-0a-readiness.md](wave-0a-readiness.md): evaluación de inicio independiente de Wave 0A.

## Convenciones de evidencia

- **CONFIRMED_REQUIREMENT:** requisito explícito del PRD o de la solicitud SPEC-00; no prueba viabilidad.
- **DOCUMENTED_NOT_TESTED:** capacidad o restricción respaldada por fuente oficial, sin prueba en GEOPS.
- **DESIGN_PROPOSAL:** contrato o elección técnica de SPEC-00 que necesita revisión antes de implementación.
- **PENDING_PHYSICAL_VALIDATION:** requiere ejecutar el plan en equipos reales.
- **UNKNOWN:** no existe evidencia suficiente o depende de cuenta, hardware o decisión de negocio.

Los ADR existentes [001–006](../architecture/adr/) se mantienen como decisiones iniciales; [ADR-007–012](../architecture/adr/) los complementan. ADR-012 acepta el protocolo de identidad, sin afirmar validación en MDM o hardware. Las referencias a RF, RN, CA y VAL usan los identificadores del PRD v1.1.

## Regla de avance

[Wave 0A](wave-0a-readiness.md) puede planificarse con alcance independiente y puertas propias. Puede continuar trabajo documental y la preparación del piloto de Wave 0. No se declara **READY** hasta resolver las dependencias críticas de [wave-readiness.md](wave-readiness.md). La captura por minuto, la protección MDM y los reinicios requieren evidencia física; no se dan por aprobados por aparecer en documentación.

## Cierre documental del corte 2026-10-16

El [informe de cierre documental](closure-report.md) registra investigación y arquitectura completadas para este corte, evidencia Trial y dependencias trasladadas. **SPEC-00 sigue BLOCKED**: no se han ejecutado las validaciones obligatorias en Free ni el piloto Android. El informe no cambia los criterios originales de [wave-readiness.md](wave-readiness.md) ni autoriza implementación o producción.

## Addendum MDM y decisión de negocio — 2026-10-19

El [estudio de factibilidad y decisión MDM](mdm-business-decision.md) evalúa MDM-001–006, costes, una excepción ADB sin restablecimiento documentada por ManageEngine, límites de Work Profile/COPE y un plan físico A/B. [ADR-014](../architecture/adr/ADR-014-mdm-flota-existente-propuesto.md) queda **propuesto**, sin alternativa seleccionada. No hay PASS nuevo; Free, políticas, conservación de datos y equipos siguen sin validar. Los requisitos originales y `BLOCKED` se conservan.
