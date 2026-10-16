# ADR-007 — MDM externo como plano de administración

**Fecha:** 2026-10-16. **Estado:** propuesta condicionada por licencia/tenant y piloto. **Complementa:** [ADR-002](ADR-002-gps-propio.md) y [ADR-006](ADR-006-privacidad-administracion.md).

## Contexto

PRD RF-01–RF-03 requiere inscripción Fully Managed, inventario, distribución obligatoria y protección ordinaria del agente. ManageEngine Free anuncia hasta 25 equipos, pero la disponibilidad de API y cada política en la cuenta concreta no está verificada. Véase [investigación R01–R06](../../spec-00-technical-feasibility/research.md).

## Decisión

Usar ManageEngine Mobile Device Manager Plus MSP Cloud + Android Enterprise Fully Managed como **plano de administración** externo. El agente Kotlin propio seguirá enviando GPS directamente a GEOPS; ni MDM ni su API son el canal de posiciones. Encapsular inventario/estado MDM en un adaptador con credenciales y scopes separados. Preparar inscripción mediante QR de administrador en equipos corporativos restablecidos, con Zero-touch/Knox como alternativas condicionadas al hardware. Distribuir el agente como app privada/empresarial por el mecanismo compatible que se valide.

## Consecuencias

El tenant actual es MSP Cloud Trial en `mdm.manageengine.com`. El cliente `DEFAULT_CUSTOMER` requiere un ID numérico para `X-CUSTOMER`; la [API MSP de clientes](https://www.manageengine.com/mobile-device-management-msp/api/customers/) documenta `GET /customers` con `MDMOnDemand.MDMAdmin.READ`, y la prueba autenticada sin `X-CUSTOMER` respondió HTTP 302 en Trial. El ID numérico se confirmó mediante Customer Details en la consola y se conserva como string en `X-CUSTOMER`. GET de dispositivos respondió HTTP 200 con arreglo vacío en Trial; la API de clientes aún no corroboró nombre↔ID. El scope de inventario es `MDMOnDemand.MDMInventory.READ`; el de lectura de perfiles es distinto y no se solicita inicialmente. La edición Free y el acceso OAuth/GET devices deben comprobarse tras Trial con la [matriz reproducible M01–M10](../../spec-00-technical-feasibility/mdm-free-api-validation.md); no se promete integración RF-01/RF-02 hasta entonces. [ADR-012](ADR-012-identidad-dispositivo.md) separa la identidad GEOPS de los identificadores MDM y exige vinculación verificada. Si falta API, se necesitará licencia o cambio de alcance aprobado, no extracción no documentada. El piloto debe probar instalación, actualización, no desinstalación, restricciones de ubicación y avisos visibles en dos modelos reales. Con 25 equipos el cupo queda lleno.
