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
## Estabilización y revisión de seguridad — 2026-10-16, base 59e5e140

Este corte es posterior al commit local `59e5e1404ff36214758158c98deaa1b5fa44406e`; los cambios de estabilización permanecen **sin commit y sin push**. No hay CI remoto para este corte. Solo se usaron `geops_verify_20261016xx`, claves/contraseñas aleatorias de prueba y el proveedor fake. La API Wave 0A no cargó `apps/api/.env.local`.

### Ejecución verificable

| Control | Resultado |
| --- | --- |
| Preflight | Rama correcta, HEAD exacto, árbol inicialmente limpio y `ahead 1` de origin; .env.local API/Compose ignorados y no rastreados. |
| Lockfile | `npm ci --ignore-scripts --no-audit --no-fund` PASS, 144 paquetes instalados. |
| Calidad | `npm run lint` PASS (47 archivos), `npm run typecheck` PASS, `npm run build` PASS (Web 26 módulos), `npm run contracts:check` PASS (OpenAPI 3.1). |
| Automatizadas existentes | `npm test` PASS: 34 (18 OAuth heredadas con mocks, 12 API/MDM fake, 4 vectores de contrato). No hubo llamadas OAuth reales. |
| Integración PostgreSQL/PostGIS | `integration-smoke.mjs`, `identity-edge.mjs` y `security-regression.mjs` PASS en tres bases desechables separadas; sesiones idle/absoluta, aislamiento CSRF, Origin, cookie Secure, 500 sanitizado, claim/replay/PoP/rotación/revocación. |
| Restauración anterior a revocación | PASS del **ensayo sintético**: seed ACTIVE → dump → revoke en fuente → restore antiguo → challenge aceptado (riesgo demostrado) → `quarantine-restored-db.js` → challenge rechazado, cero claves/sesiones activas y admin bloqueado. Se repitió tras añadir el bloqueo de admin. |
| Git/secretos | `npm run security:scan` PASS, 145 archivos elegibles inspeccionados sin mostrar valores; patrones de clave privada/token literal/ruta sensible. `git diff --check` se repite al cerrar. |
| Docker | Compose reconstruyó la imagen API y levantó geops-db/API/Web sanos; migrador terminó. API `127.0.0.1:3500` y Web `127.0.0.1:3501` respondieron 200, DB sin puerto público. Siete bases temporales y dos dumps creados en este corte se eliminaron. |

El primer build de Docker falló por una variable `string | undefined` del comando nuevo; se corrigió y el build final pasó. El primer lint falló por formato del escáner; se aplicó Biome y el lint final pasó. No se omiten estos fallos intermedios.

### Restauración y alcance del control

`restore-quarantine.ts` exige nombre `geops_verify_<número>_restore`, esquema listo y ausencia de otras conexiones. En una sola transacción revoca identidades/sesiones y bloquea cuentas admin; invalida invitaciones, challenges, recuperaciones y grants ficticios, dejando auditoría sin valores. El wrapper exige modo sintético y confirmación explícita. El comando no puede garantizar por sí solo que ningún servicio se conecte después de comprobar conexiones; el runbook exige mantener la API de esa base detenida. Aún falta orquestación que imponga esa secuencia y recuperación humana de doble control. Por ello P04/T18 no son cierre operativo.

### Revisión de código y riesgos residuales

- **Identidad/PoP:** firmas sobre método/ruta/cuerpo/token/tiempo/nonce, consulta de estado por petición y nonce único en DB; suites de concurrencia locales pasan. La verificación de attestation real sigue rechazando por defecto; solo fake admite excepción registrada. Falta matriz P11/P15 completa y piloto Keystore.
- **Admin:** Argon2id, sesiones con expiración 8 h/30 min, CSRF por sesión y Origin estricto pasan localmente. Cookie Secure probado en configuración segura inyectada; el Compose de localhost usa cookie insegura intencionalmente y no demuestra HTTPS. Rate limit por proceso/IP no basta para despliegue con proxy. La recuperación registra referencias de dos custodios sin autenticarlos independientemente.
- **MDM/OAuth:** el proceso Wave 0A crea solo FakeMdmProvider; los grants cifrados son ficticios. El escáner añade una barrera contra archivos elegibles para Git, pero no sustituye revisión manual ni escaneo completo de historial. No se usó OAuth real ni se validó Free.
- **Logs/Web/Docker:** los handlers observados no incluyen cuerpo/headers y la prueba de 500 no devolvió marcador; falta captura automática del log de nivel info. Web requiere teclado/lector, estados de error y captura de red. La topología conserva DB interna; Linux CI remoto, TLS y secretos operativos siguen pendientes.

La revisión de seguridad de este corte es interna, no independiente ni aprobación operativa W0A-E2. No se declara Wave 0A completa, identidad real aprobada ni SPEC-00 READY.

Guardia negativa adicional: `GEOPS_TEST_DB=geops_dev` fue rechazado antes de conectar/modificar la base principal (exit 1, mensaje sanitizado).

### Prueba de navegador posterior — 2026-10-16

Con una cuenta ficticia temporal en `geops_dev`, la consola en `127.0.0.1:3501` mostró login, inventario vacío GEOPS y MDM etiquetado `fake`, y estado `Free: Sin validar`. Por teclado, Tab alcanzó `Saltar al contenido` y Enter llevó el foco al `main#content`; la navegación marcó la página actual con `aria-current=page`. Esto acredita accesibilidad **básica** de ese recorrido, no una auditoría WCAG/lector de pantalla.

Se detuvo solo `geops-api`: ambas tarjetas pasaron de carga a un aviso `role=alert` con botón `Reintentar`; al restaurar API, ambos botones recuperaron el estado vacío. Se observó un defecto: el logout fallido navegaba a login sin revocar la sesión del servidor. Se corrigió en `apps/web/src/app.tsx`; tras reconstruir Web, con API caída la página permaneció en inventario y mostró `No se pudo cerrar la sesión en el servidor`. Tras restablecer API, el reintento cerró sesión y navegó a login. La cuenta temporal y sus dos sesiones se eliminaron de la DB. El navegador volvió a rellenar los campos del formulario de acceso tras logout; no se atribuye a almacenamiento de OAuth de la app ni se declara limpieza del autocompletado del navegador.

P23 tiene PASS_LOCAL del salto de teclado/foco y estados visibles; recorrido completo de teclado/lector sigue pendiente. P25 tiene PASS_LOCAL de caída/recuperación de red; UI 403/429 sigue pendiente. P24 tiene PASS_LOCAL del comportamiento de logout fallido/reintento; captura de tráfico browser sin tokens MDM sigue pendiente. La prueba no ejecutó ManageEngine ni usó credenciales reales.

Comprobación final tras interrupción del motor Docker: se repitieron lint (47 archivos), typecheck, 34 pruebas automatizadas, build, OpenAPI y escaneo de 145 archivos: PASS. Docker volvió a levantar solo los recursos GEOPS; DB/API/Web terminaron `healthy`, migrador `exit 0`, API ready y Web health respondieron 200. DB siguió sin puerto de host; `qa@example.test` y bases `geops_verify_*` quedaron en cero. La imagen Web final se reconstruyó desde el archivo final. CI remoto permanece sin ejecutar porque no hubo push.

### Ampliación de matriz de identidad — 2026-10-16

`identity-edge.mjs` pasó en una base aislada nueva: reemitir una invitación canceló el claim y la invitación anteriores; el claim viejo no pudo probar posesión. La restricción única rechazó un segundo vínculo MDM activo para el mismo proveedor/tenant/ID; `issueInvitation` rechazó un dispositivo `SUSPENDED`. `integration-smoke.mjs` pasó en otra base y confirmó HTTP 429 tras exceso de claims sintéticos. Ambas bases se eliminaron. P10 queda PASS_LOCAL para secreto/TTL/un uso/carrera/reemisión; P11 y P13 mejoran, pero conservan la matriz completa de estados, pruebas detrás de proxy y variantes restantes.

### Verificación final posterior a la ampliación P10 — 2026-10-16

Con el test de reemisión/cancelación y el límite de claims ya incorporados, los controles finales pasaron: lint (47 archivos), typecheck, 34 pruebas automatizadas, build (Web 26 módulos), OpenAPI 3.1, escaneo de 145 archivos elegibles para Git y git diff --check. Los primeros intentos de typecheck y escaneo en sandbox fueron impedidos por permisos de escritura e invocación de procesos; la repetición con acceso al workspace terminó sin errores. No hubo push ni CI remoto en este corte.

## Security Recovery Hardening — 2026-10-16, base 59e5e140

Solo datos, contraseñas, claves y dispositivos sintéticos. No se llamó ManageEngine ni se cargó OAuth real. Los cambios siguen sin commit ni push; CI remoto no ejecutado.

### Causa y corrección

La copia previa a revocación contenía una clave y sesión ACTIVE. Al restaurarla, una consulta directa de challenge pasó antes de ejecutar cuarentena. La API no tenía barrera fuera de la DB y podía arrancar en esa ventana. ADR-013 introduce `security-gate.json` en volumen separado, época UUID reflejada en `security_epoch`, comparación por solicitud y 503 cerrado por defecto. `close` adelanta la época externa; la DB restaurada antigua no coincide. La cuarentena revoca todas las credenciales en transacción, marca la nueva época, registra auditoría y permite `verify`/`open` solo con conteos nulos y sin otras conexiones. El journal externo registra fases sanitizadas.

La ruta de recuperación anterior aceptaba dos etiquetas sin autenticación: quedó deshabilitada. La nueva tabla de custodios, solicitudes y aprobaciones exige credenciales individuales, dos identidades activas distintas, no autoaprobación, solicitud temporal, código único y revocación de aprobación/custodio. Se prueba solo con fixtures; no se afirma autorización de personas reales.

### Evidencia ejecutada

| Control | Resultado |
| --- | --- |
| Lockfile/calidad | `npm ci --ignore-scripts --no-audit --no-fund` PASS (144 paquetes); lint PASS (51 archivos); typecheck PASS; build PASS (Web 26 módulos); OpenAPI 3.1 PASS; `npm test` PASS (34 pruebas mock/unitarias). |
| Secretos/logs | Escaneo de 152 archivos elegibles PASS sin imprimir valores; log info capturado con marcador sintético en Authorization/Cookie/cuerpo/excepción, marcador ausente y código de error presente. `.env.local` ignorados y no rastreados. |
| Integración PostgreSQL | `restore-gate.mjs` PASS: ruta pendiente drenada antes de restaurar, siete rutas HTTP 503 durante cierre, reinicio cerrado, época antigua rechazada, rollback por trigger que falla, reintento idempotente, recuperación de gate perdido cerrada, DB ausente 503 y claves/cookie/password antiguas rechazadas tras abrir. `integration-smoke.mjs` PASS: dos custodios autenticados, autoaprobación, expiración, revocación, pérdida y código único; además regresión de identidad/MDM fake. `security-regression.mjs` PASS: sesiones 8 h/30 min, CSRF/Origin, cookie Secure, 500 y log sanitizado. Cada suite usó una base aislada. |
| Backup anterior a revocación | `pg_dump -Fc` antes de revocar → revocación en fuente → `pg_restore` aislado: challenge directo aceptado (**riesgo reproducido**). Gate cerrado/época diferente: `verify` falló como se esperaba. Cuarentena PASS, `verify` PASS, `open` PASS, challenge viejo rechazado y cero claves/sesiones activas. |
| Backup posterior a revocación | `pg_dump -Fc` posterior → `pg_restore` aislado: revocación conservada, challenge rechazado y cero claves/sesiones. Cuarentena y reapertura PASS. |
| Docker Compose | Solo contenedores GEOPS reiniciados. Volumen `geops_wave0a_security` separado del volumen PostgreSQL; DB sin puerto publicado; API 127.0.0.1:3500 y Web 127.0.0.1:3501 healthy y HTTP 200. La marca inicial en `geops_dev` se creó solo tras comprobar cero administradores, cero dispositivos y cero épocas. |
| Limpieza | Nueve bases `geops_verify_2026101609*`, dos dumps del contenedor y dos directorios temporales de gate identificados fueron eliminados. |

**Incidente de ensayo corregido:** el primer comando `migrate.js` con `GEOPS_TEST_DB` ignoró esa variable y aplicó migraciones 0007/0008 a `geops_dev` antes de crear identidades. Se comprobó que `geops_dev` contenía 0 administradores, 0 dispositivos y 0 épocas. Se corrigió el comando para dirigir migraciones solo al nombre de prueba validado y se repitió el ensayo en otra DB (8 migraciones PASS). Luego se inicializó el gate de `geops_dev` con la API detenida. No se revirtió el esquema; el estado actual de Compose pasó salud con él.

Los primeros ensayos de test fallaron por suposición de seis migraciones y un nombre de variable duplicado; se corrigieron y repitieron. El primer typecheck del stream de logging falló por tipo opcional; se corrigió y pasó. Ninguno de esos intentos se cuenta como PASS. La prueba de gate por HTTP no representa captura GPS real: esa ruta aún no existe y fue bloqueada con 503 durante mantenimiento.

### Límites de la evidencia

Una solicitud ya aceptada puede finalizar después de cerrar el gate; el ensayo confirmó que debe drenarse al parar API antes de restaurar. El gate solo compara época externa y DB: una restauración no autorizada sin cierre y con la misma época, o manipulación de ambos volúmenes, no queda cubierta. El alta de custodios por CLI es sintética y el acceso a Docker/DB conserva alto privilegio. La secuencia de parada/apertura no está automatizada en Linux CI ni revisada independientemente. Por eso P04/P09/T08/T18 y Wave 0A no se declaran cerrados operativamente.
## Evidencia Restore Orchestration & Migration Safety — 2026-10-16

Base de trabajo `59e5e1404ff36214758158c98deaa1b5fa44406e`; cambios locales sin commit/push. Auditoría: `GEOPS_TEST_DB` antes podía reescribir `DATABASE_URL` en `migrate.ts`; `geops-migrate` era dependencia automática de API; `open` no exigía autorización exacta. Se corrigieron el destino explícito, perfil `maintenance`, guardia de gate cerrado para `geops_dev` existente y autorización por destino+época. Se añadió cierre SIGTERM de Fastify y `scripts/restore-synthetic.mjs` con evidencia local ignorada, dos fases, bloqueo concurrente y reintento explícito del destino descartable.

Pruebas observadas: `restore:test` 1/1 PASS (secuencia, fallo pg_restore, fallo cuarentena, reintento y reapertura con autorización simulados); `migration:test` 2/2 PASS (configuraciones erróneas y geops_dev protegido); `restore-gate.mjs` PASS en `geops_verify_20261016144154_restore` con gate/HTTP/reinicio/rollback/rechazo de credenciales. Migrador real en otra base aislada `geops_verify_20261016144125_restore`: configuración discordante rechazó antes de SQL, 8 versiones aplicadas, segundo pase 0, tabla verificó 8; ambas bases temporales fueron eliminadas. `docker compose config --services` solo listó DB/API/Web; el migrador quedó oculto bajo `maintenance`. Build Docker de la imagen API/migrador PASS. La ejecución integral del orquestador contra el Compose compartido no se hizo para no detener la UI de desarrollo; por eso P04/T18 y Q4 no reciben PASS integral. Controles generales finales se registran al cierre de este corte.

### Verificación final de este corte

`npm ci --ignore-scripts --no-audit --no-fund` PASS (144 paquetes); `npm run lint` PASS (55 archivos); `npm run typecheck` PASS; `npm test` PASS (18 OAuth mock + 12 API/fake + 4 contratos + 2 migración + 1 orquestador = 37); `npm run build` PASS (Web 26 módulos); `npm run contracts:check` PASS (OpenAPI 3.1); `npm run security:scan` PASS (156 archivos elegibles). `git diff --check` PASS con avisos de conversión de fin de línea sin errores de whitespace. `docker compose config --services` listó DB/API/Web; el servicio `geops-migrate` solo está en el perfil de mantenimiento. La imagen migrador/API nueva construyó PASS. Los servicios GEOPS existentes no se recrearon para este corte; por tanto la API en ejecución puede seguir usando la imagen previa hasta una ventana de reinicio controlada.
