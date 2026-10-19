# ADR-014 — Estrategia MDM para flota Android existente (propuesta)

**Fecha:** 2026-10-19. **Estado:** PROPUESTO / DECISIÓN DE NEGOCIO PENDIENTE. **Relaciona:** [ADR-007](ADR-007-mdm-externo.md), [ADR-006](ADR-006-privacidad-administracion.md), [SPEC-00](../../spec-00-technical-feasibility/mdm-business-decision.md).

## Contexto

GEOPS debe administrar 25 Android corporativos multimarca sin desinstalación ordinaria, sin que el usuario apague ubicación en turno, conservando apps y datos sin reset, operando desde GEOPS Web y respetando privacidad. El PRD presupone ManageEngine Fully Managed, pero no hay evidencia de esas políticas en Free ni en teléfonos. El flujo ordinario Fully Managed exige equipo nuevo/restablecido; ManageEngine documenta ADB sin reset con condiciones estrictas. Work Profile preserva el espacio existente pero no garantiza el bloqueo global de ubicación. El [estudio](../../spec-00-technical-feasibility/mdm-business-decision.md) contiene matriz, costes, fuentes y pruebas.

## Decisión por tomar

**Ninguna alternativa se aprueba en este ADR.** Negocio debe elegir y documentar una de estas rutas: (A) aceptar reset y cambiar formalmente MDM-003; (B) financiar validación por modelo de Fully Managed mediante ADB sin reset, manteniendo los seis requisitos; (C) aceptar Work Profile y cambiar formalmente el alcance de MDM-001/002; (D) contratar otra oferta empresarial con demostración verificable sin reset y multimarca; o (E) posponer MDM y mantener bloqueado el piloto con datos reales.

## Condiciones de aceptación de la decisión

La decisión debe identificar patrocinador, fecha, presupuesto/cotización, inventario de 25, tratamiento de datos existentes, resultado físico en dos fabricantes y cobertura del resto, acceso API/licencia para GEOPS Web, tratamiento del horario laboral, revisión de seguridad y privacidad, y cambios aprobados de requisitos si proceden. Cada requisito original permanece vigente hasta aprobación formal y versión trazable. Ni un DPC propio ni Samsung Knox son excepciones automáticas a las restricciones de Android o a la compatibilidad multimarca.

## Consecuencias mientras siga propuesto

SPEC-00 y la viabilidad MDM permanecen `BLOCKED`; ADR-007 es una propuesta condicionada, no una orden de restablecer o inscribir. No se habilitan datos reales, modificación de teléfonos/tenant, despliegue ni afirmación PASS. La fase documental y trabajo independiente pueden continuar bajo sus puertas existentes.
