# Revisión cruzada y cierre de contrato de diseño — SPEC-02 W1-A

**Fecha:** 2026-10-19. **Decisión:** `CLOSED_FOR_SYNTHETIC_IMPLEMENTATION`. La línea base de diseño queda aprobada para comenzar W1-B con datos sintéticos y base desechable. **No** se aprueba captura, migración de producción, despliegue ni interoperabilidad completa. Revisión técnica realizada desde tres perspectivas por este agente; no equivale a firmas de personas/equipos distintos ni a una auditoría independiente de seguridad.

## Preflight y alcance

Rama `codex/spec-02-wave-1`, HEAD `d72cdb49d95915f8772ffcb6818698e4439c1a57`, misma base inmediata que `codex/poc-gps-weekend`. Ocho documentos rastreados modificados de SPEC-00 y dos nuevos heredados (ADR-014 y decisión MDM) permanecen intactos. SPEC-02 y ADR-015–017 siguen sin seguimiento; la PoC no se modificó. Se revisaron [auditoría de entrada](readiness-audit-2026-10-19.md), [ADR-015](../architecture/adr/ADR-015-capacidades-administrativas-gps.md), [ADR-016](../architecture/adr/ADR-016-identidad-sesiones-gps.md), [ADR-017](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md), [OpenAPI](openapi.design.yaml), [modelo](data-model.md), [API](api-contracts.md), [tareas](tasks.md), [pruebas](test-plan.md), y contratos/código existentes de SPEC-01 para cookie, CSRF, PoP y migraciones de identidad. No se consultaron posiciones reales.

## Perspectiva backend

| Hallazgo | Severidad inicial | Resolución de contrato | Evidencia/pendiente |
| --- | --- | --- | --- |
| B01: publicación y alta de miembro compiten, incluso con grupo vacío | P0 | ADR-017 fija locks de políticas/grupos antes de dispositivos, orden UUID, recálculo atómico y exclusión temporal; `If-Match` se verifica bajo lock. | V04 verifica intersección `[)`; T03/P03 debe demostrar serialización real y rollback con dos transacciones PostgreSQL. |
| B02: idempotencia permitía reutilizar key con otro `If-Match` | P0 | Fingerprint de cuerpo exacto y precondición; resultado/registro en la transacción; auth/capacidades antes del replay. | V11 pasa; T04/P02 debe probar carreras, expiración 24 h y caída antes/después de COMMIT. |
| B03: snapshot `active:true` incompleto validaba en OpenAPI | P0 | `ConfigSnapshot` exige política/revisión/tzdb si activo y prohíbe política/ventanas en tombstone. | AJV valida casos positivo/negativo; Kotlin debe consumir los mismos fixtures. |
| B04: identidad de instalación no tenía momento de creación | P1 | ADR-016 fija creación en activación, una instalación activa por dispositivo, rotación conserva ID. | T03 valida FK/índice parcial y T09 prueba reprovisión. |
| B05: transición de sesión/interrupción no era exhaustiva | P1 | ADR-016 añade tabla de estados; `UNKNOWN_END` no fabrica `stopped_at`; tramos interrumpidos no admiten posiciones. | V09–V10 son modelo de referencia; T09/P08 debe probar transacción, cuarentena y orden invertido. |
| B06: fin registrado tras vencer ventana/TTL podía quedar rechazado | P1 | STOP_REQUESTED/STOPPED de sesión vinculada son evidencia terminal aceptable con identidad activa y orden coherente; no autorizan posiciones nuevas. | T09/P08 debe probar fin tardío y rechazo de posiciones posteriores. |

El modelo de exclusión GiST `(uuid WITH =, tstzrange WITH &&) WHERE (superseded_at IS NULL)` es compatible **a nivel de diseño** con `btree_gist` para UUID y con predicado parcial, según [PostgreSQL btree_gist](https://www.postgresql.org/docs/current/btree-gist.html) y [CREATE TABLE/EXCLUDE](https://www.postgresql.org/docs/current/sql-createtable.html). No se ejecutó DDL; los índices, locks, FK, extensión y restauración deben validarse en la versión de PostgreSQL elegida por W1-B.

## Perspectiva Android

| Hallazgo | Severidad inicial | Resolución de contrato | Evidencia/pendiente |
| --- | --- | --- | --- |
| A01: `MISSED_START` tras reboot sin ancla era imposible de serializar | P0 | Ancla obligatoria solo en eventos que abren/cambian/cierran efectiva; diagnóstico sin ancla no prueba tiempo. Razones son enum. | AJV acepta diagnóstico y rechaza STARTED sin ancla; T06/P06 en Kotlin pendiente. |
| A02: ventanas, cambio de frecuencia/horario y expiración offline | P1 | Android usa instancias UTC de servidor, versión máxima y tiempo monotónico por boot; una política futura exige descarga online. | V01–V08 y V12 pasan en referencia Node; falta paridad Kotlin con reloj inyectado, almacenamiento y callbacks. |
| A03: reintentos, ACK y eventos fuera de orden | P1 | IDs estables, 202 sin ACK, 409 digest, buffer hasta 200 tras COMMIT. | V09–V12; persistencia cifrada, 7 días de cuarentena y pérdida de proceso quedan en T08/T09. |
| A04: inicio FGS desde fondo | Riesgo externo | `MISSED_START` y acción visible, sin prometer inicio automático. | Matriz física P12 pendiente. [Android documenta restricciones de inicio y permisos de FGS](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start). |

No hay compilador Kotlin ni agente Android de producto ejecutable en este workspace; el código de la PoC se leyó solo como referencia y no se copió. Por ello esta revisión no declara compatibilidad binaria o conductual del cliente Kotlin.

## Perspectiva seguridad

| Hallazgo | Severidad inicial | Resolución de contrato | Evidencia/pendiente |
| --- | --- | --- | --- |
| S01: una sesión admin podría reproducir éxito tras pérdida de capacidad | P0 | ADR-015/API obligan sesión, Origin, CSRF y capacidad vigente antes del lookup idempotente; no hay concesión automática. | V11; middleware y auditoría real en T03/T04/P02. |
| S02: snapshot viejo/ajeno o downgrade | P1 | PoP ligado a dispositivo/clave, versión máxima local, instalación y gate ADR-013; boot/ancla dudosos fallan cerrados. | V08 y bytes PoP reales de `packages/api-contracts/src/identity.ts`; replay nonce y revocación real en P04. |
| S03: texto libre en `reason_code` o exposición de ubicación | P1 | Enum de razones, consulta con capacidad, motivo auditado, rango UTC máximo 24 h y sin coordenadas en logs. | Esquema AJV y P13; autorización/auditoría de servidor en W1-B/E1. |
| S04: revocación offline | Riesgo residual | Máximo de 12 h, fin de ventana y reboot fail closed; revocación recibida detiene captura. | V07/V12; aceptación de privacidad antes de piloto. No se afirma revocación instantánea. |
| S05: faltaba el valor monotónico del ancla en wire | P0 | Eventos efectivos/posiciones llevan `anchor_elapsed_realtime_ms` y `elapsed_realtime_ms`; servidor rechaza o pone en cuarentena discrepancia >30 s sin ampliar ventana. | Esquema y V08 pasan; cliente Kotlin y backend deben probar RTT ≤30 s, boot y timestamps; no prueba teléfono comprometido. |

## Vectores y compatibilidad ejecutada

Comando: `node specs/spec-02-android-agent-wave-1/contract-vectors.test.mjs`. Resultado: **15/15 PASS** (V01–V12 pedidos, DST gap/overlap, casos positivos/negativos de OpenAPI y bytes PoP contra la fuente TypeScript de SPEC-00). El archivo es un **oráculo de diseño**, no una implementación de servicio. Los escenarios cubren política válida/vencida/futura, solape, frecuencia, horario, revocación offline, desfase/reboot/downgrade, duplicado, desorden, idempotencia y fin de jornada sin Internet. `node --test` intentó crear proceso hijo y recibió EPERM del entorno; la ejecución directa del mismo archivo completó los 15 tests.

`SwaggerParser.validate` PASS para OpenAPI 3.1 y 21 operaciones; `openapi-typescript` generó AST de 5 nodos; `npm run contracts:check` de SPEC-01 y `npm run typecheck --workspace @geops/api-contracts` PASS. El build que escribe `packages/api-contracts/dist` recibió EPERM del sandbox, por lo que no se usa como evidencia. La cookie `geops_admin`, `X-CSRF-Token`, el formato PoP y la separación de rutas no contradicen los contratos existentes. La validación de esquema y generación de tipos no demuestran controladores funcionales.

| Superficie | Evidencia W1-A | Gate de implementación |
| --- | --- | --- |
| Backend TypeScript | OpenAPI válido, tipos generables, paquete de contratos typecheck, bytes PoP contra fuente. | T04/T09: validación runtime, autorizaciones y respuestas bajo HTTP real. |
| Android Kotlin | Wire, enums, UTC y decisiones de estado explícitos; vectores compartibles. | T06–T08: compilar Kotlin y ejecutar V01–V12, persistencia/reboot/FGS simulado. |
| PostgreSQL/PostGIS | Modelo y operadores documentados; esquema existente de SPEC-01 revisado. | T03: DDL/migración solo en DB desechable, GiST/exclusión, locks, restore y carreras. |
| Admin | Cookie/CSRF y capacidad por operación trazadas; replay seguro definido. | T03–T04: permiso deny-by-default, auditoría, `If-Match` e idempotencia transaccional. |

## Decisión y límites

**P0 de decisión arquitectónica: ninguno abierto.** B01–B03, A01, S01 y S05 quedaron fijados en ADR, modelo, API y OpenAPI. W1-A se cierra **solo como línea base para implementación sintética**; W1-B puede iniciar T03–T04 sin MDM, usando DB desechable y dispositivos/posiciones ficticios. W1-B no termina hasta superar P02/P03/P09, paridad de esquemas y revisión de seguridad de su código. Kotlin, PostgreSQL, PoP y CSRF reales aún no son interoperabilidad aprobada. SPEC-00 sigue BLOCKED, SPEC-01 conserva sus gates, ADR-014 sigue propuesto; los cuatro bloqueos MDM son independientes. No se realizó commit, push, merge, migración, despliegue ni consulta al servidor GPS.
