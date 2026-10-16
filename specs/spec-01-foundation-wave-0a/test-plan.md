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
## Matriz de estabilización — 2026-10-16, base 59e5e140

`PASS_LOCAL` solo acredita el subcaso sintético descrito. `IN_PROGRESS` o `BLOCKED` impiden PASS integral del caso. No se reetiquetan M01–M10 ni A01–A06.

| Caso | Resultado vigente | Evidencia ejecutada / condición restante |
| --- | --- | --- |
| P04 | IN_PROGRESS | `pg_dump` anterior a revocación restauró una clave activa y permitió challenge; cuarentena posterior bloqueó admin, clave y sesiones, y rechazó challenge. PASS_LOCAL del mecanismo sintético; falta secuencia operativa garantizada y Linux CI. |
| P06 | IN_PROGRESS | Límites exactos idle 30 min y absoluto 8 h, logout y flag Secure PASS_LOCAL. HTTPS/proxy extremo a extremo pendiente. |
| P07 | PASS_LOCAL | Sesión A con CSRF de B, Origin ajeno y Origin ausente dieron 403; sesión/origen correctos dieron 201. |
| P08 | IN_PROGRESS | Argon2id y bloqueo progresivo en suite integrada; respuesta 500 no repite marcador secreto. Falta captura dinámica de logs en modo info/proxy distribuido. |
| P09 | BLOCKED | Código vencido/usado se rechaza y consume sesiones; identidad real de dos custodios y ensayo operativo de recuperación pendientes. |
| P10 | PASS_LOCAL | Secreto de 32 bytes; 9:59 acepta, 10:00 rechaza; dos claims, un ganador; reemisión cancela invitación y claim anteriores. Validado solo con PostgreSQL sintético. |
| P11 | IN_PROGRESS | Binding MDM ajeno y carreras de claim/rotación rechazados; matriz de todos los estados/transiciones pendiente. |
| P12 | BLOCKED | Firma/cadena inválidas rechazan y sin evidencia no se activa. Verificador Android real y confirmación física siguen pendientes; la excepción fake no los acredita. |
| P13 | IN_PROGRESS | Reuso de invitación, proof y pairing incorrectos rechazados; reemisión cancela el claim previo y exceso de claims devuelve 429. Faltan variantes de pairing y rate limit detrás de proxy. |
| P14 | PASS_LOCAL | Challenge a 1:59/2:00 y sesión a 14:59/15:00, un uso y nueva prueba de posesión verificados en DB sintética. |
| P15 | IN_PROGRESS | Sin firma, key ID distinto, query, cuerpo alterado, tiempo fuera de ventana y nonce concurrente rechazados. Matriz completa ruta/token/firma y captura de log pendientes. |
| P16 | PASS_LOCAL | Dos firmas, attestation inválida rechazada, una sola rotación concurrente gana, token/clave viejos rechazados y nueva sesión exige challenge. No acredita Keystore real. |
| P17 | IN_PROGRESS | Revocación y reemplazo sintético, clave vieja rechazada; reinstalación/reasignación y atribución histórica completas pendientes. |
| P22 | IN_PROGRESS | `npm run security:scan` PASS en 145 archivos elegibles; .env.local ignorados/no rastreados; config rechaza OAuth real. Falta captura dinámica de logs/snapshots y revisión de diagnóstico. |
| P23 | IN_PROGRESS | Layout 390×844 y salto por teclado hasta main#content con foco/aria-current pasan localmente; recorrido completo y lector de pantalla pendientes. |
| P24 | IN_PROGRESS | Cookie/CSRF y logout con caída/reintento probados por HTTP y navegador; captura de tráfico browser sin tokens MDM pendiente. |
| P25 | IN_PROGRESS | Fuente fake/vacío y caída/recuperación de API con aviso y reintento pasaron en navegador; UI 403/429 pendiente. |

**FAIL reproducido y mitigado localmente:** la copia previa a revocación reactivó identidad antes de cuarentena. El resultado inicial se conserva como evidencia del riesgo. No se registra FAIL de la cuarentena: tras ejecutarla, la prueba de rechazo pasó. Q2/Q3/Q4 y Wave 0A siguen abiertos.

### Adenda de navegador — 2026-10-16

P23: Tab → enlace `Saltar al contenido` → Enter → foco en `main#content`, encabezados y `aria-current` PASS_LOCAL; lector de pantalla y recorrido completo pendientes. P24: logout con API caída conserva sesión visible y avisa; al volver la API, reintento invalida sesión y navega a login PASS_LOCAL; captura de tráfico browser pendiente. P25: API detenida produjo errores recuperables en ambas tarjetas y botones `Reintentar`; tras restaurar API, volvieron a vacío fake PASS_LOCAL. Errores 403/429 UI pendientes. Estos subcasos no convierten P23–P25 en PASS integral.

Adenda P10/P11/P13: reemisión cancela invitación y claim anteriores; claim viejo se rechaza. Un segundo binding MDM activo con mismo proveedor/tenant/ID falla por índice único; dispositivo SUSPENDED no puede emitir invitación. Exceso de claims HTTP devuelve 429. Estas pruebas pasaron en PostgreSQL sintético aislado. **P10 PASS_LOCAL** para el contrato sintético; P11 y P13 siguen `IN_PROGRESS` por matriz completa y rate limiting detrás de proxy.

## Matriz Security Recovery Hardening — 2026-10-16

| Caso | Estado de este corte | Evidencia y límite |
| --- | --- | --- |
| P04 | PASS_LOCAL del ensayo sintético; IN_PROGRESS integral | `pg_dump` antes de revocación → copia antigua reactivó challenge en DB, pero el gate externo cerrado/época distinta impidió HTTP y `verify`; cuarentena → cero credenciales y reapertura. Backup posterior conservó revocación y pasó el mismo flujo. Fallo SQL de cuarentena hizo rollback y dejó gate cerrado; reintento pasó. Reinicio de API y DB ausente fallaron cerrado. Falta orquestación operativa y Linux CI. |
| P06–P07 | PASS_LOCAL de subcasos; IN_PROGRESS integral | Sesiones idle/absolutas, cookies Secure configuradas, Origin y CSRF aislados previamente; el gate dio 503 a login y mutaciones durante mantenimiento. TLS/proxy real pendiente. |
| P08–P09 | PASS_LOCAL técnico; P09 BLOCKED operativo | Dos custodios distintos con contraseñas Argon2id, no autoaprobación, solicitud de 10 minutos, código único, aprobación revocable, pérdida de custodio y revocación de sesiones pasaron en DB sintética. El CLI antiguo por etiquetas ahora rechaza. No hay dos personas reales verificadas ni ceremonia de alta aprobada. |
| P10–P17 | Subcasos previos PASS_LOCAL; P12 BLOCKED externo | Durante mantenimiento, challenge, sesión, rotación y ruta futura de ingesta devolvieron 503; tras reapertura, clave/cookie/password viejos se rechazaron. Las matrices P11–P13/P15/P17 y attestation Android real permanecen abiertas. |
| P22 | PASS_LOCAL de logs/archivos; IN_PROGRESS integral | Log info capturado con marcadores en Authorization, Cookie, cuerpo y excepción: código de error presente, marcadores ausentes. Escaneo Git de 152 archivos elegibles PASS. Faltan snapshot de browser/diagnóstico heredado y revisión independiente. |
| P23–P25 | IN_PROGRESS | Se conserva evidencia previa de teclado/red/logout; no hubo nueva auditoría WCAG, tráfico ni UI 403/429. |

**Resultados negativos esperados:** `verify` antes de cuarentena falló; backup antiguo permitió challenge directo en DB (causa raíz); gate HTTP devolvió 503; aprobación propia y código revocado/expirado se rechazaron. No se etiquetan como defectos del control final. Los fallos intermedios de pruebas se corrigieron y repitieron; ver evidencia. M01–M10 Free y A01–A06 Android sin cambios.
## Matriz Restore Orchestration & Migration Safety — 2026-10-16

| Caso | Estado | Evidencia / límite |
| --- | --- | --- |
| P04 pre/post revocación | PASS_LOCAL de cuarentena previa; IN_PROGRESS integral | La suite `restore-gate.mjs` volvió a pasar en PostgreSQL aislado: gate cerrado, reinicio, época discordante, fallo y reintento, credenciales antiguas rechazadas. La copia anterior/posterior se ensayó en el corte previo. No se ejecutó restore Docker completo con API compartida detenida. |
| P04 fallo antes/durante cuarentena | PASS_LOCAL | `restore-synthetic.test.mjs` inyectó fallo en `pg_restore` y cuarentena; en ambos casos no hubo `open`. Reintento exigió reset exacto del destino descartable. El test PostgreSQL previo comprobó rollback SQL de cuarentena. |
| P04 reapertura sin autorización | PASS_LOCAL | `restore-gate.mjs` rechazó ausencia de autorización y época incorrecta; la apertura válida exigió base/época exactas. El orquestador requiere evidencia y autorización separada. |
| P04 migración equivocada | PASS_LOCAL | `migration-target.test.ts` cubrió URL/test/target/confirmación discordantes, modo incorrecto y protección de `geops_dev`; PostgreSQL aislado rechazó destino discordante, aplicó 8 migraciones y segundo pase 0. |
| P04 drain/servicios | IN_PROGRESS | El orquestador cierra gate, detiene Web/API/job, comprueba contenedores y cero conexiones; Fastify implementa cierre SIGTERM. Secuencia Docker real sobre API compartida y prueba de solicitud larga pendiente. |
| P04 pérdida de época externa | PASS_LOCAL previo; IN_PROGRESS operativo | Gate ausente/discordante rechaza tráfico en suite aislada; recuperación crea solo marca cerrada. Respaldo/journal externos y procedimiento de operador pendientes. |

P06–P17/P22–P25 conservan los estados de la matriz anterior. M01–M10 Free y A01–A06 Android permanecen externos, sin PASS por estas pruebas.

## Evidencia CI de consolidación — 2026-10-16

Para `544934df0d66f168dfa1f9228f9d601f42644861`, el [workflow Wave 0A foundation, run 38967057446](https://github.com/Kmena/Geops/actions/runs/38967057446) terminó `completed/success`. `foundation` pasó `npm ci --ignore-scripts`, OpenAPI, lint, escaneo de secretos, typecheck, `npm test` y build. No contiene job de despliegue ni referencias a secretos. P01/Q1 reciben PASS_REMOTE para este SHA. Las cuatro suites PostgreSQL y la migración aislada se ejecutaron localmente; no son pasos del workflow remoto. P04/T18 continúan IN_PROGRESS por la falta de ensayo Docker completo del orquestador y revisión independiente. P06–P17/P22–P25 conservan los estados de su matriz; M01–M10 Free y A01–A06 Android siguen pendientes.
