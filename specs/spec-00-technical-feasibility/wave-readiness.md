# Readiness de SPEC-00 y Wave 0

**Dictamen documental al 2026-10-16: BLOCKED.** El protocolo de identidad quedó decidido en [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md), pero la API ManageEngine Free y el vínculo/entrega en dos equipos reales siguen sin evidencia. [Wave 0A](wave-0a-readiness.md) puede prepararse independientemente bajo puertas propias, sin cerrar SPEC-00 ni afirmar viabilidad del piloto. [PRD v1.1](../prd/GEOPS-PRD-v1.1.md) está presente **sin seguimiento en Git**; debe incorporarse al flujo de control de cambios por decisión del equipo, sin alterar su contenido en este spec.

| Criterio de cierre solicitado | Estado | Evidencia / trabajo restante |
| --- | --- | --- |
| Requisitos trazados | DOCUMENTED | [requirements.md](requirements.md) mapea RF-01–RF-15 y CA/VAL; parámetros abiertos identificados. |
| Decisiones arquitectónicas principales | DOCUMENTED_WITH_OPEN_ITEMS | [architecture.md](architecture.md), ADR 001–012; arranque Android y cifrado local concretos pendientes. |
| Contratos técnicos definidos | IDENTITY_DESIGN_ACCEPTED / INGEST_PROPOSED | [api-contracts.md](api-contracts.md) fija semántica candidata de IDs, ACK y errores; el protocolo de identidad está aceptado en ADR-012, con revisión de seguridad/integración pendiente y límites finales sin aprobar. |
| Riesgos clasificados | DOCUMENTED | [risks.md](risks.md) prioriza probabilidad/impacto y puertas. |
| Dependencias externas identificadas | DOCUMENTED_WITH_BLOCKER | [M01–M10](mdm-free-api-validation.md) y políticas en **cuenta Free real** aún sin prueba; modelos Android y servidor sin inventario. |
| Plan verificable para dos dispositivos | DOCUMENTED_NOT_RUN | [pilot-test-plan.md](pilot-test-plan.md); resultados físicos pendientes. |
| Sin decisiones críticas abiertas para Wave 0 | **NOT_MET** | Q-02 API MDM Free sigue **BLOCKED**. Q-03 cerró el protocolo documental; Q-19 entrega/vínculo MDM y A01–A06 requieren validación. Q-04 inicio/reinicio y Q-05 cifrado requieren prueba/decisión antes del agente definitivo. |

## Trabajo de validación previo a las waves

1. Identificar los dos equipos, versiones y entorno ManageEngine; obtener cuenta Free/Trial y confirmar transición de licencia.
2. Ejecutar [M01–M10](mdm-free-api-validation.md) con OAuth de mínimo scope y GET devices, sin registrar tokens. Si la API falla en Free, presentar al dueño del producto opciones de licencia o ajuste explícito de RF-01/RF-02.
3. Definir y probar inscripción QR Fully Managed, instalación obligatoria, no desinstalación y políticas de ubicación en ambos teléfonos.
4. Revisar y validar físicamente el [protocolo de credenciales individuales](device-provisioning.md), seleccionar cifrado local, aprobar aviso laboral y política de retención/backup.
5. Acordar umbrales medibles de cadencia, precisión, permanencia, cobertura y batería; entonces preparar prototipo técnico mínimo del piloto según la wave autorizada.

**Condición para cambiar a READY documental:** obtener evidencia M01–M09 en Free o aprobar formalmente alternativa de producto para RF-01/RF-02; revisar ADR-012/contratos y verificar entrega/vínculo de Q-19 con A01–A06 en los dos equipos, o aceptar explícitamente una modalidad manual con sus riesgos; aprobar umbrales críticos y registrar responsables de Q-04/Q-05 con pruebas planificadas. El estado físico de cadencia, protección y reinicio puede seguir `PENDING_PHYSICAL_VALIDATION` si se documenta como puerta posterior, sin presentarlo como probado. Hasta entonces, **BLOCKED**.

No se implementaron funcionalidades, no se instalaron dependencias, no se desplegó infraestructura y no se ejecutaron pruebas físicas. Este documento no concede una aprobación implícita para producción.
