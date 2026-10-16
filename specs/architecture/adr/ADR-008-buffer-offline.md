# ADR-008 — Buffer offline persistente y protegido

**Fecha:** 2026-10-16. **Estado:** propuesta; selección de cifrado pendiente. **Complementa:** [ADR-002](ADR-002-gps-propio.md) y [ADR-003](ADR-003-ingesta-gps.md).

## Contexto

RF-06 exige conservar posiciones disponibles sin Internet y sincronizarlas sin pérdida ni duplicados. El teléfono puede reiniciarse o perder un acuse tras persistencia remota.

## Decisión

Persistir cada evento con ID estable en Room **antes** de intentar enviarlo. Gestionar estados pendiente/acuse/cuarentena; WorkManager reintentará cargas por lotes con red, backoff y jitter. La API confirma solo tras COMMIT; un reenvío usa los mismos IDs. Generar/proteger la clave privada de firma en Android Keystore según [ADR-012](ADR-012-identidad-dispositivo.md), excluir sesión, clave e información sensible de Auto Backup y seleccionar cifrado de la base o de registros antes de usar coordenadas reales. Room por sí solo no cifra.

## Consecuencias

Se requieren pruebas de reinicio, pérdida de Internet, timeout de ACK, pérdida de clave, cuota del buffer y borrado del dispositivo. WorkManager periódico no se usará para cadencia de 60 segundos. La política al llenarse la cola y el cifrado concreto siguen abiertos en [Q-05/Q-17](../../spec-00-technical-feasibility/open-questions.md).
