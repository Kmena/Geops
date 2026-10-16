# Test plan — validación futura de Wave 0A

**Estado:** P01–P04 tienen evidencia fundacional/CI anterior. P05–P25 se ejecutaron total o parcialmente con datos sintéticos el 2026-10-16; ningún caso parcial se declara PASS integral. Ver [evidencia T01–T05](implementation-evidence-T01-T05.md) y [evidencia T06–T18](implementation-evidence-T06-T18.md). Toda evidencia debe identificar commit, entorno, fecha, configuración no sensible y resultado PASS/FAIL/BLOCKED. Los casos con fake solo prueban GEOPS.

| ID | Historia | Capa y caso | Oráculo de aceptación |
| --- | --- | --- | --- |
| P01 | S01 | CI/workspaces/typecheck | Lockfile reproducible, TS strict, test/lint sin error. |
| P02 | S01 | Contrato OpenAPI/Fastify | Rutas, request/response schemas y seguridad coinciden; errores sin datos internos. |
| P03 | S01 | Compose salud/fallo | DB cae → ready 503 en ≤10 s; vuelve 200 en ≤60 s tras restore; reinicio conserva datos; puertos 3500/3501 comprobados al iniciar. |
| P04 | S01 | DB/migración/backup | PostGIS disponible, migración idempotente, checksum; restore ficticio y revocación conservada. |
| P05 | S02 | Bootstrap | Solo primer admin por comando local; repetir falla; no endpoint signup. |
| P06 | S02 | Login positivo/logout | Cookie HttpOnly/Secure en HTTPS, TTL/idle; logout invalida token. |
| P07 | S02 | CSRF/CORS | Mutación sin token o desde Origin ajeno 403; origen permitido funciona. |
| P08 | S02 | Password/rate limit/log | Argon2id con parámetros elegidos, bloqueo progresivo, error indistinguible; no password/token en logs. |
| P09 | S02 | Recovery/revocación | Código usado/expirado se rechaza; sesiones previas revocadas; doble control auditado. |
| P10 | S03 | Invitación/claim | 256 bits, 10 min, HMAC, un uso; solicitudes concurrentes solo una gana. |
| P11 | S03 | Máquina de estados | Transiciones inválidas y binding MDM duplicado se rechazan atómicamente. |
| P12 | S03 | Firma/attestation/activación | Firma errónea o cadena inválida rechaza; falta de verificación física impide ACTIVE. |
| P13 | S03 | Replay/pairing | Código incorrecto/reuso/claim expirado reciben 409/410; rate limit. |
| P14 | S03 | Sesión challenge | Challenge consumido una vez; token 15 min ligado a clave, sin refresh portable. |
| P15 | S03 | PoP | Firma/body hash/nonce/timestamp inválidos rechazan; secreto no aparece en respuesta/log. |
| P16 | S03 | Rotación | Dos firmas válidas activan nueva clave y revocan sesiones antiguas; carrera una gana. |
| P17 | S03 | Pérdida/reinstalación/reasignación | Revocación inmediata y nueva ceremonia; binding viejo no autentica. |
| P18 | S04 | Fake/cliente MSP | Inventario vacío autenticado es éxito; source=fake visible; customerId se conserva como string. |
| P19 | S04 | Paginación | Cursor/limit y páginas sin duplicados; límites validados. |
| P20 | S04 | Refresh/401 | Renovación single-flight, un retry, sin exposición de token. |
| P21 | S04 | 403/429/3xx/timeout | Errores normalizados; Retry-After; redirección no seguida ni Authorization reenviado. |
| P22 | S04 | Credenciales | Sin vars el modo real falla cerrado; secretos ausentes de Git, logs, frontend y snapshots. |
| P23 | S05 | Web shell | Router protegido, foco/teclado, layout responsive, estados carga/vacío/error. |
| P24 | S05 | Sesión web | Cookie y CSRF correctos; cierre invalida; ningún token MDM en storage o tráfico browser. |
| P25 | S05 | Inventario/estado | Listas fake etiquetadas, errores 401/403/429 comprensibles, sin PII real. |

## Tipos y datos

Unitarias para validación, state machine, HMAC/PoP y errores; integración con PostgreSQL/PostGIS efímero para restricciones/atomicidad; HTTP contract tests derivados de OpenAPI; pruebas E2E web en browser local; amenazas de seguridad automatizadas para replay, CSRF, CORS y fuga. Datos y claves exclusivamente sintéticos. Las pruebas actuales del diagnóstico OAuth se preservan como regresión, sin convertirlas en aceptación de API Free.

## Puertas de calidad

- Gate Q1: tipo/lint/contrato; 0 errores, trazabilidad de todas las rutas implementadas.
- Gate Q2: unidad/integración HTTP y DB; P01–P22 PASS con evidencia, fallos críticos corregidos.
- Gate Q3: web/accesibilidad P23–P25 y revisión manual de seguridad W0A-E2.
- Gate Q4: Compose Windows/Linux amd64, backup/restore ficticio, escaneo de secretos, estado Git limpio de credenciales.
- Gate Q5: carga sintética de 25 dispositivos; p95 inventario fake <500 ms y login <1 s en hardware especificado. Los números son umbrales iniciales ajustables por medición, no resultados ni SLA productivo.

Quedan fuera de este test plan los resultados ManageEngine Free M01–M10 y piloto Android A01–A06, que se registran en [SPEC-00](../spec-00-technical-feasibility/closure-report.md). No ejecutar llamadas reales para satisfacer P18–P22.
## Casos negativos obligatorios de identidad (P10–P17)

| Caso | Entrada sintética / concurrencia | Resultado esperado |
| --- | --- | --- |
| P10-E1 | Invitación a t=9:59 min y t=10:00 min con reloj inyectado. | Antes del límite, claim único; en límite/tras límite, 410 y cero sesiones. |
| P10-E2 | Dos claims simultáneos con misma invitación y distinta clave. | Una reserva como máximo; otra 409; nunca dos ACTIVE. |
| P12-I1 | Cadena attestation con reto, SPKI, raíz o revocación inválidos. | 401 por prueba inválida; no PENDING_CONFIRMATION/ACTIVE. |
| P12-I2 | Claim correcto con MDM ID ajeno, tenant ajeno, evidencia libre o sin confirmación física. | Activación rechazada; ninguna evidencia fake acredita teléfono real. |
| P13-R1 | Reusar invitación, proof/challenge, código o intento tras cancelación. | 409/410; sin nueva clave activa. |
| P14-E1 | Challenge a t=1:59 y t=2:00 min; sesión a t=14:59 y t=15:00 min. | Expiraciones exactas y renovación solo mediante nueva prueba de posesión. |
| P15-S1 | Bearer robado sin firma, clave distinta, cuerpo/ruta/token alterados, query añadida. | 401/400 y ninguna operación ejecutada. |
| P15-R2 | Dos peticiones con mismo nonce simultáneas y tiempo fuera de ±5 min. | Una sola aceptación; replay 409, reloj inválido rechazado. |
| P16-K1 | Falta firma vieja/nueva, attestation de nueva clave inválida o dos rotaciones concurrentes. | Ningún cambio parcial; solo una clave activa. |
| P16-K2 | Rotación válida y siguiente petición con token/clave viejos. | Viejos rechazados de inmediato; nueva sesión exige challenge. |
| P17-L1 | Revocación concurrente con sesión y pérdida de clave. | La siguiente petición falla; no recuperación por MDM ID o backup. |
| P17-L2 | Reinstalación/reasignación. | Requiere nueva invitación, binding y aprobación; historial no se reatribuye. |

Las pruebas usan secretos y claves generados para test, nunca apps/api/.env.local. Un PASS sintético no equivale a A01–A06 ni a revisión de seguridad de la implementación.

## Resultados del corte T01–T05

| Caso | Estado | Alcance demostrado / pendiente |
| --- | --- | --- |
| P01 | PASS_LOCAL / CI_PENDING | npm ci, lint, typecheck, build y suites locales pasaron; workflow remoto sin ejecutar por prohibición de commit/push. |
| P02 | PASS_CONTRACT_AND_HEALTH / FUTURE_ROUTES_PENDING | OpenAPI validado; solo rutas health implementadas e inyectadas. Admin/identidad/MDM esperan sus tareas. |
| P03 | PASS_LOCAL_WINDOWS_AMD64 | 3500/3501 libres al inicio; 3 servicios sanos + job 0; DB caída → ready 503 en 3452 ms; DB restaurada → 200 en 2508 ms; volumen conservó fixture. |
| P04 | PARTIAL | PostGIS, migración idempotente, rechazo de checksum y backup/restore ficticio pasaron. Revocación conservada espera T09/T12; plataforma Linux CI pendiente. |

Los 18 tests OAuth heredados usan mocks y no cuentan como validación Free. Ese corte T01–T05 no asignó PASS a P05–P25, M01–M10 ni A01–A06.

## Resultados del corte T06–T18 — 2026-10-16

| Caso | Resultado observado | Pendiente antes de PASS integral |
| --- | --- | --- |
| P04 | PASS_LOCAL para `pg_dump`/`pg_restore` de copia posterior a revocación; identidad restaurada no logra challenge. | Reconciliación de copias anteriores a revocación y política operativa. |
| P05 | PASS_LOCAL: bootstrap único y segundo intento rechazado; sin registro HTTP. | Revisión de seguridad de implementación. |
| P06–P07 | PARTIAL: cookie HttpOnly/SameSite, login/logout, sesión revocada, Origin y CSRF. | Límites 8 h/30 min y HTTPS/Secure de extremo a extremo. |
| P08–P09 | PARTIAL: Argon2id, recovery de un uso y sesiones revocadas. | Bloqueo y expiración probados; faltan redacción automática y doble control humano. |
| P10 | PARTIAL: secreto de 32 bytes, claim a 9:59 aceptado, a 10:00 rechazado, carrera con un ganador. | Más variantes de cancelación/reemisión. |
| P11–P13 | PARTIAL: binding ajeno, firma y cadena inválidas rechazados; activación sin evidencia falla. | Tenant ajeno, todos los estados/races, rate limit y verificador real de attestation. |
| P14–P15 | PARTIAL: challenge un uso, PoP sin firma/query/timestamp/key id inválidos y nonce concurrente 200/409. | Límites exactos probados; falta matriz completa de alteraciones. |
| P16–P17 | PARTIAL: rotación positiva, clave vieja rechazada, revocación y restore posterior. | Reemplazo/rotación concurrente probados; faltan reinstalación/reasignación completa y backup anterior. |
| P18–P21 | PASS_LOCAL con fake y `fetch` mock: inventario vacío etiquetado, cursor/limit, Customer ID string, 401 single-flight, 403/429/3xx/timeout. | No equivalen a ManageEngine Free ni habilitan el cliente real. |
| P22 | PARTIAL: config rechaza OAuth, archivos locales ignorados, logs estructurados sin cuerpos/headers. | Escaneo automático de secretos y revisión de frontend/snapshots. |
| P23–P25 | PARTIAL: browser local con login, rutas protegidas, carga/vacío, estado fake, logout y viewport 390×844 sin overflow. | Teclado/accesibilidad, errores 403/429 y captura de tráfico browser. |

**CI remoto del corte nuevo:** NO EJECUTADO. Los 34 tests unitarios/mock y los dos scripts de integración en DB aislada son evidencia local. M01–M10 Free y A01–A06 Android no se ejecutaron.
**Q5 componente local:** 25 registros GEOPS/fake con `app.inject` en contenedor Linux amd64: p95 login 128.6 ms, GEOPS 8.5 ms y fake 9.7 ms (25 muestras de cada una). PASS_LOCAL para ese método; la puerta Q5 de red/plataforma objetivo no se declara completa.