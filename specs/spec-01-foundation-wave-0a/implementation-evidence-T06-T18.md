# Evidencia T06–T18 — corte sintético 2026-10-16

**Rama:** `codex/spec-01-wave-0a`. **Base:** `ba5fa36` al iniciar este corte. **Entorno:** Windows + Docker Desktop Linux amd64, Node 24, PostgreSQL 18/PostGIS 3.6. Solo bases desechables, claves generadas para desarrollo y proveedor `fake`; `apps/api/.env.local` no se cargó. No hubo OAuth real, llamadas ManageEngine, teléfonos Android ni despliegue.

El estado SPEC-01 permanece `READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING`; SPEC-00 permanece BLOCKED. Esta evidencia corresponde a un commit local de la rama; no se ha publicado ni ejecutado CI remoto para este corte. El CI remoto de T02 en `c781fae` conserva su resultado anterior, sin cubrir este corte.

## Estado individual

| Tarea | Implementado en este corte | Estado de aceptación |
| --- | --- | --- |
| T06 | Tabla admin, bootstrap local único y Argon2id. | IMPLEMENTED / P05 PASS_LOCAL; P08 parcial por rate limit y revisión de seguridad. |
| T07 | Login, cookie HttpOnly, expiración absoluta/idle, CSRF, Origin, logout y revocación de sesión. | IMPLEMENTED / P06–P07 parcial: HTTP positivo/negativo y navegador; límites 8 h/30 min y TLS real de extremo a extremo pendientes. |
| T08 | Código de recuperación de un uso, diez minutos, revocación transaccional y runbook. | IMPLEMENTED / P09 parcial: reutilización y revocación probadas; expiración/reutilización probadas; doble control humano no verificado independientemente. |
| T09 | Migraciones de identidad con índices parciales, bloqueo transaccional, estado y repositorio. | IMPLEMENTED / P10–P11 parcial: carrera de claim y replay pasan; faltan todas las carreras/estados de P11. |
| T10 | Invitación 256 bits/HMAC, claim, P-256, proof y guardia de activación fake. | IMPLEMENTED / P10–P13 parcial: rechazo de binding, firma y cadena inválidos; attestation real no implementada y activación real deshabilitada. |
| T11 | Challenge, sesión opaca de 15 minutos y PoP con firma, cuerpo exacto, ruta, nonce y ventana temporal. | IMPLEMENTED / P14–P15 parcial: un uso, replay concurrente y varios rechazos; límites de challenge/sesión exactos probados; faltan otras alteraciones. |
| T12 | Rotación con dos firmas, revocación y reemplazo sintético. | IMPLEMENTED / P16–P17 parcial: rotación positiva, clave vieja rechazada y revocación restaurada; carrera de rotación y reemplazo sintético probados; falta reinstalación/reasignación de extremo a extremo. |
| T13 | `MdmProvider`, fake y cliente GET read-only opt-in, no instanciado por la API Wave 0A. | DONE_LOCAL para alcance mock P18–P21: paginación, Customer ID string, 401/403/429/3xx y fallo de conexión simulados. No valida Free. |
| T14 | Grants ficticios AES-256-GCM, refresh single-flight y desconexión; diagnóstico OAuth heredado conserva proceso separado. | IMPLEMENTED / P20–P22 parcial: cifrado y single-flight probados; desconexión concurrente probada; faltan clave errónea y revisión completa de migración/redacción. |
| T15 | Auditoría estructurada sin cuerpos ni headers, correlation id de HTTP y métricas de fallo. | IMPLEMENTED / P08/P22 parcial: muestra de logs sanitizados inspeccionada; falta prueba automática de no filtración y revisión de seguridad. |
| T16 | Shell React Router, rutas protegidas, estado carga/vacío/error, foco y estilos responsive. | IMPLEMENTED / P23 parcial: login, inventario, estado y viewport móvil inspeccionados; falta recorrido de teclado/accesibilidad completo. |
| T17 | Cliente same-origin con cookie/CSRF, vistas GEOPS y MDM fake. | IMPLEMENTED / P24–P25 parcial: navegación, inventario vacío etiquetado y logout verificados; faltan simulaciones de errores 403/429 en navegador y captura de red. |
| T18 | Guías de operación y prueba de backup/restore sintético iniciadas. | IN_PROGRESS: P04 restore con revocación PASS_LOCAL; Q2–Q4 y revisión de seguridad W0A-E2 pendientes; Q5 medido solo con `app.inject`, sin red real. |

`IMPLEMENTED` indica código funcional dentro del entorno ficticio, no cierre formal de tarea. Conforme a `tasks.md`, solo T13 recibe DONE_LOCAL; las demás conservan criterios sin evidencia completa.

## Controles ejecutados

| Control | Resultado observado |
| --- | --- |
| `npm run lint` | PASS, PASS final: 42 archivos, sin errores. |
| `npm run typecheck` | PASS en API, Web y contratos. |
| `npm run build` | PASS en API, Web y contratos; Vite construyó 26 módulos. |
| `npm test` | PASS, 34 pruebas: 18 OAuth heredadas con mocks, 12 API/fake y 4 vectores de contratos. |
| `npm run contracts:check` | PASS, OpenAPI 3.1 y paridad con SPEC-01. |
| `git diff --check` | PASS; solo avisos de conversión CRLF/LF en Git. |
| Compose | Rebuild/up PASS: API y DB healthy, Web healthy; migrador exit 0; rebuild final y HTTP ready/Web health 200. API 127.0.0.1:3500, Web 127.0.0.1:3501, DB sin puerto publicado; red y volumen exclusivos GEOPS. |
| Integración en DB aislada | PASS: bootstrap, login, Origin/CSRF, logout, invitación, claim, proof, guardia de activación, sesión, PoP, rotación concurrente, revocación, grant cifrado y recovery. También expiración exacta de challenge/sesión, recovery expirado, rate limit, pairing/evidencia falsa y attestation de rotación inválida. Prueba repetida tras rebuild. |
| `identity-edge.mjs` en DB aislada | PASS: invitación exactamente a 10 minutos rechazada, claim a 9:59 aceptado, carrera de dos claims con un ganador, replay 409, binding falso 403, attestation y firma inválidas 401, cero claves activas. |
| Backup/restore | `pg_dump`/`pg_restore` de DB ficticia PASS; `restore-check.mjs` PASS: dispositivo revocado no obtiene nuevo challenge y hay cero claves/sesiones activas. Solo demuestra restauración de una copia tomada después de revocar. |
| Navegador local | Login ficticio, rutas protegidas, inventario vacío GEOPS/fake, estado `Free sin validar`, logout y redirección tras logout PASS. Viewport 390×844 sin scroll horizontal; inspección visual y DOM. Cuenta ficticia temporal eliminada al terminar. |
| Git ignore | `apps/api/.env.local` e `infrastructure/compose/.env.local` ignorados por `.gitignore`; `git ls-files --error-unmatch` no los encuentra. Un barrido de archivos rastreados/pendientes para literales largos de tokens y bloques de clave privada dio 0 candidatos; no sustituye un escáner especializado. |

La suite integrada y la suite de límites corrieron con `GEOPS_TEST_DB` apuntando a bases `geops_verify_<timestamp>` dentro del contenedor GEOPS. No se utilizaron valores reales y ninguna respuesta de prueba contiene tokens en la evidencia. Las bases y dumps desechables de este corte se eliminaron tras comprobar el resultado.

## Revisión de seguridad preliminar

- El proceso Wave 0A exige `GEOPS_DATA_MODE=synthetic`, rechaza variables OAuth reales y registra solo método, plantilla de ruta, status, duración y request id. El adaptador ManageEngine real se prueba únicamente con `fetch` simulado y no se instancia en `main.ts`.
- La attestation real falla cerrada mediante `RejectingAttestationVerifier`. Una excepción registrada permite activar **solo** un binding `fake` dentro de la simulación. No es prueba de Android Keystore ni aprobación operativa de ADR-012.
- PoP firma método, ruta absoluta sin query, SHA-256 del cuerpo exacto, hash del token, timestamp, nonce y key id. El nonce se reserva con restricción única en DB; dos solicitudes concurrentes con el mismo nonce dieron 200/409. La operación de rotación revalida clave y sesión bajo locks.
- La recuperación requiere dos referencias de custodios y deja auditoría, pero el software no autentica a esos dos humanos de forma independiente. La seguridad del doble control depende del procedimiento local. P09 y R05 siguen abiertos.
- La limitación por IP es local al proceso y el proxy agrupa clientes. Se requiere prueba de distribución/proxy antes de usarla como defensa operativa. R10 sigue abierto.
- Una copia anterior a una revocación podría reintroducir una identidad si se restaura sin reconciliación. La restauración operativa deberá mantener API detenida y reconciliar revocaciones o invalidar todas las claves/sesiones; el test actual cubre la copia posterior a revocación. T18 y R03 no se cierran.

## Pendientes de cierre

P06/P08/P09: límites de tiempo de sesión y recuperación, rate limit y doble control. P11–P17: matriz negativa completa, expiraciones exactas, carreras de rotación/revocación, reinstalación/reasignación y revisión de seguridad. P22–P25: escaneo automatizado de secretos, errores UI/red y accesibilidad. Q4: Linux/amd64 Docker completo para este corte. Q5: medición con red real/plataforma objetivo aún pendiente; componente local con `app.inject` pasó. El CI remoto de este corte requiere un push autorizado; no se solicitó ni ejecutó push. Free M01–M10 y Android A01–A06 continúan externos y pendientes.

## Medición Q5 local y ampliación de casos

Con 25 dispositivos GEOPS ficticios y 25 registros `FakeMdmProvider`, 25 logins y 25 consultas por inventario en contenedor Linux amd64 mediante `app.inject`: p95 login **128.6 ms**, inventario GEOPS **8.5 ms**, inventario fake **9.7 ms**. Los tres están por debajo de los umbrales iniciales de 1 s/500 ms en este entorno. La medición excluye red, proxy, navegador y hardware piloto; Q5 operativo permanece pendiente.

La suite integrada añadió pruebas de challenge a 1:59 y 2:00, sesión a 14:59 y 15:00 con reloj inyectado, token expirado, Origin ajeno, logout, rate limit, recovery expirado, evidencia de tenant/confirmación incorrectos, pairing incorrecto, cuerpo PoP alterado, nonce concurrente y rotación concurrente o con cadena inválida. Pasaron en DB sintética aislada. Las demás variantes de P10–P17 y revisión de seguridad siguen abiertas.