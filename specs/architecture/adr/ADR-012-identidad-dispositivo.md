# ADR-012 — Identidad por dispositivo con clave Keystore e invitación temporal

**Fecha:** 2026-10-16. **Estado: aceptado como decisión de diseño; validación de integración y piloto pendiente.** Complementa [ADR-007](ADR-007-mdm-externo.md), [ADR-008](ADR-008-buffer-offline.md) y [SPEC-00](../../spec-00-technical-feasibility/device-provisioning.md).

## Contexto

El PRD exige agentes Android propios en teléfonos corporativos administrados por MDM. Una clave embebida, compartida o entregada sin control permitiría suplantar un dispositivo y contaminar GPS/visitas. ManageEngine documenta inventario y managed configurations, pero sus capacidades en el tenant Free no están probadas. Un identificador MDM presentado por la app no demuestra que quien lo presenta sea el teléfono gestionado.

## Decisión

GEOPS crea una identidad lógica por dispositivo, asociada a un registro MDM y a una asignación temporal de empleado. Un administrador emite una invitación aleatoria de 256 bits, de un solo uso y 10 minutos, ligada a la identidad y registro MDM esperados. La entrega es presencial supervisada o por managed configuration individual **solo después de validar** ese canal en la cuenta real. La activación requiere reclamación atómica, challenge firmado con una clave P-256 generada en Android Keystore, confirmación del código en el teléfono físico y verificación independiente del vínculo MDM por API o consola. Se verifica key attestation donde esté disponible; no se presupone soporte de hardware.

El agente usa sesiones opacas de 15 minutos ligadas a la clave. Cada llamada presenta firma de método, ruta, cuerpo, token, hora y nonce. El servidor comprueba estado y revocación por llamada; la renovación requiere challenge firmado. La rotación requiere posesión de clave vieja y nueva; si la vieja se pierde, solo una nueva inscripción administrada recupera acceso. Los tokens OAuth de MDM son exclusivos del backend y jamás son credenciales GPS.

El protocolo completo, estados, amenazas y aceptación están en [device-provisioning.md](../../spec-00-technical-feasibility/device-provisioning.md). Los contratos de transporte están en [api-contracts.md](../../spec-00-technical-feasibility/api-contracts.md) y [identity-api-contract.md](../../spec-00-technical-feasibility/identity-api-contract.md).

## Consecuencias

Q-03 queda **cerrada como decisión documental del protocolo**, no como prueba operativa. Quedan pendientes la entrega managed configuration en Free, la semántica de inventario, attestation de ambos modelos, pruebas de replay/rotación/reinstalación y aprobación operativa del modo manual. SPEC-00 permanece BLOCKED por Q-02 y la evidencia física. Un claim malicioso puede inutilizar una invitación; exige cancelación/reemisión, sin poder activar el teléfono impostor. La complejidad de firma/replay cache debe planificarse en Wave 0A/1 antes de datos reales.

## Alternativas descartadas

- Secreto fijo compartido/embebido: compromete toda la flota.
- Bearer de larga vida por teléfono: un token copiado permite suplantación hasta revocación.
- Solo UDID/serial o variable MDM: identificadores copiables, sin prueba de posesión.
- Activación automática al escanear QR: una invitación filtrada puede ganarle al equipo legítimo.
