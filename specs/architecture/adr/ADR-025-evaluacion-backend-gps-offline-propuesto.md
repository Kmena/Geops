# ADR-025 — Evaluación backend a partir de GPS offline

**Fecha:** 2026-10-26. **Estado:** propuesta técnica; requiere aprobación. **Complementa:** ADR-003/008/010/016.

## Contexto

La APK debe capturar y guardar offline con sus políticas autorizadas. El backend ya persiste `position_event` con `captured_at`, ACK y deduplicación; no tiene worker de visitas. La ruta de ingestión actual exige binding MDM activo.

## Decisión propuesta

El evaluador consume solo posiciones ya aceptadas y persistidas, desacoplado del ACK GPS. Reconciliación idempotente por visita y watermark, preferentemente outbox transaccional de ADR-010 más barrido de recuperación. Resultado e historia append-only registran versión de regla, evidencia y frescura. La llegada tardía dispara nueva evaluación, incluso después del cierre operativo si los eventos todavía son admisibles y retenidos. El silencio offline mantiene `PENDING_SYNC` o `UNVERIFIABLE`; no implica incumplimiento. No añadir campos ni controles Android ni GPS-COMM-001.

## Consecuencias

Dashboard eventualmente consistente; necesita lag, retries y política de retención. La aceptación sin MDM y la vinculación histórica a agente son dependencias externas; esta decisión no presume resolverlas. Si no se admite evento tardío por retención, no reconstruir artificialmente la visita.

## Realización local Wave 4A

Se implementó un job por asignación con `FOR UPDATE SKIP LOCKED`, lectura acotada de `position_event` y revisión append-only. El administrador puede encolar una asignación o fecha; un proceso separado reconcilia por conteo posiciones nuevas en modo sintético y drena la cola. Esta realización cumple el desacoplamiento del ACK y permite reproceso sintético tardío, pero **todavía no implementa** el outbox transaccional ni un programador operativo para datos reales. La regla versionada `dwell-pair-v1` está marcada `LAB_ONLY` y el worker la rechaza fuera de modo sintético. El vínculo agente–dispositivo es de laboratorio; Wave 4B debe resolver identidad física antes de integrar. El estado de esta ADR sigue como propuesta para operación real.

## Realización local Wave 4B

La cola ahora reconcilia `position_event` aceptados con vínculo operativo temporal, `captured_at`, sesión y snapshot; reintenta con backoff y permite procesamiento concurrente. La revisión 2 es `TECHNICAL_ONLY`, restringida a base sintética descartable. Se ensayó backend con binding MDM y con identidad GEOPS sin binding, manteniendo ACK y contrato v2/v3. El outbox, la calibración y la prueba física permanecen pendientes; el estado de propuesta operacional no cambia. Ver ADR-027 y el cierre de Wave 4B.
