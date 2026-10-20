# Plan de pruebas y criterios de aceptación

**Empresa única propuesta:** `admin:users:integration` cubre ceremonia inicial, tenant único, cuentas con varias capacidades, invitación/repetición, permisos efectivos, cambios idempotentes, revocación, aislamiento tenant y auditoría en PostGIS desechable. `migration:0015:integration` prueba upgrade 0014→0015 con datos previos y sin grants automáticos. `maintenance:integration` prueba marker/epoch y reapertura. Web prueba la aceptación sin cookies y las mutaciones con CSRF. Siguen pendientes revisión de seguridad independiente, ensayo de backup/restore de la base persistente, E2E Staging y autorización operativa; ningún PASS sintético equivale a activación física.

**Provisionamiento inicial GPS sintético (2026-10-19):** `gps:capability:integration` en PostGIS `geops_verify_*` migrado cubre vacío inicial, contraseñas incorrectas, custodios repetidos, gate cerrado, carrera de dos solicitudes, conjunto cerrado de nueve capacidades, lectura de política, replay, segunda concesión, revocación y auditoría (19 comprobaciones locales). Falta revisar la ceremonia de operadores independientes, alta de custodios, tenant y E2E de Staging; no se declara PASS operativo.

**Bootstrap de admin2 y tenant:** `admin:tenant:integration` prueba alta secundaria concurrente, estado LOCKED, activación por recuperación con dos custodios y código no impreso, capacidades, lectura de políticas, creación de DRAFT autorizada, propuesta tenant con binding fake PENDING, rechazo de autoaprobación, aprobación separada, replay/conflicto, aislamiento, revocación de tenant y cuenta, sesiones inválidas y auditoría. Solo PostGIS desechable; no sustituye la aprobación de Seguridad ni E2E en Staging.

**Evidencia W1-E1 Corte 3 (2026-10-19):** [informe](w1-e1-c3-scheduler-activation-web-2026-10-19.md). En PostgreSQL/PostGIS desechable: operaciones 40 aserciones, carga acotada de scheduler 25 dispositivos/175 ventanas y ticks concurrentes, regresiones W1-B/config/salud/eventos 44/24/37/69, restauración local de 14 migraciones, API/Web/contratos y escaneo PASS. El cliente Web consultó API autenticada; **P10 E2E de navegador no tiene PASS**. Tampoco tienen PASS seguridad independiente, carga sostenida, restore operativo/claves, Android físico ni política definitiva de retención.

**Evidencia W1-E1 Corte 2 (2026-10-19):** [informe](w1-e1-c2-sessions-positions-2026-10-19.md): `gps:events:integration` 67 aserciones en PostgreSQL/PostGIS desechable, con PoP, 202/reintento, ACK, concurrencia, tenant, revocación, ventana y purga; Kotlin wire y 14 pruebas JVM pasan; backup/restore conservó 12 migraciones y los recuentos. P08 tiene **cobertura sintética parcial**; P10 Web E2E, scheduler, retención programada, seguridad independiente y P12 físico no tienen PASS. La evidencia del corte anterior abajo es histórica.

**Evidencia W1-E1 parcial (2026-10-19):** `gps:config:integration` pasó 24 aserciones HTTP/PostgreSQL de publicación → configuración PoP → ancla → salud ACK → lectura tenant; W1-B 44, GPS-HEALTH-001 37. Kotlin compiló y pasó 14 pruebas sintéticas y leyó la respuesta HTTP exacta. Web pasó 9 pruebas de componente/adaptador y build; backup/restore desechable conservó 11 migraciones y recuentos de anclas, salud y auditoría. [Informe](w1-e1-readiness-2026-10-19.md). P08 de sesión/posición, P10 Web E2E, scheduler, carga, seguridad independiente y prueba física siguen **sin PASS**. El texto histórico de compilación pendiente abajo corresponde al corte W1-C anterior.

**Ejecución W1-D (2026-10-19):** [informe Web](w1-d-web-2026-10-19.md). Typecheck, Biome, build, contratos y 7 pruebas Node/Vite SSR pasan. Navegador local móvil comprobó conflicto de asignación, motivo de salud, evidencia observada/inferida/desconocida, MISSED_START, permisos simulados, estados vacío/carga/error y ausencia de desbordamiento; no hubo E2E autenticado ni captura desktop. S02-P10/P13 permanecen **PENDIENTES** para backend real, 403/429, concesión tenant, auditoría, DST y lector de pantalla.

## GPS-HEALTH-001: evidencia y gates adicionales (2026-10-19)

En DB PostGIS `geops_verify_*` desechable, ejecutar `apps/api/test/gps-health.integration.mjs` con `GEOPS_DATA_MODE=synthetic`. La suite HTTP/PG cubre PoP, ACK pos-commit, duplicado de lote y evento, conflicto de digest, nonce replay, batería inválida, límite 128 KiB, concurrencia, autorización y revocación por tenant/capacidad/clave, cursor, cuota y purga de 90 días. `contracts:check` valida el OpenAPI incorporado; la regresión SPEC-01 permanece obligatoria. El test Kotlin W1-C comprueba que cada muestra trae boot/ancla/tiempo monotónico, pero su recompilación en este entorno queda pendiente por falta de Gradle/compilador disponible. Faltan ensayos de carga sostenida, scheduler de purga, restauración y cliente/servidor PoP real; ninguna prueba de GPS físico se ejecuta aquí.

**No se ejecutaron pruebas físicas ni consultas al servidor PoC para esta SPEC.** Las pruebas siguientes son gates futuros con datos generados. Un PASS sintético no acredita captura real. Cada prueba registra versión app/OS/modelo, política, reloj, permisos, red, batería, evento y correlación, sin coordenadas reales en Git.

| ID | Nivel | Escenario y criterio |
| --- | --- | --- |
| S02-P01 | Contrato | OpenAPI 3.1 válido, nombres de cookie/PoP compatibles con SPEC-00/01; campos IANA, días, intervalos, versiones, errores; vectores cliente/servidor antes de código. |
| S02-P02 | Backend | Admin anónimo, sin CSRF/Origin, sin cada capacidad GPS y dispositivo no mutan; `gps.location.read` exige motivo/auditoría. Dos publicaciones concurrentes dejan una versión; denegaciones auditadas. |
| S02-P03 | Backend | Asignación directa/grupo superpuesta y alta de miembro que crea solape producen 409 sin commit; transacciones concurrentes no lo eluden. Futuro no se activa offline; tombstone/versionado al revocar. |
| S02-P04 | Seguridad | PoP correcto pasa; replay de nonce, firma/cuerpo alterado, token/clave ajena, restore epoch, identidad revocada y downgrade fallan cerrados según SPEC-00/ADR-013. |
| S02-P05 | Horario | Borde `[inicio,fin)`, cruce medianoche (día ISO del inicio), OFF/REPLACE, DST gap/overlap, zona cambiada por revisión, recorte de vigencia, tzdb distinta, cambio de política en sesión, RTT de snapshot ≤30 s, ancla monotónica/UTC y reboot; cero capturas fuera de instancia UTC. |
| S02-P06 | Android simulado | Sin permiso/GPS, FGS rechazado, cierre, callback tardío, proceso muerto y reboot offline: MISSED_START o UNKNOWN_END observados, sin sesión inventada, sin captura fuera de ventana. |
| S02-P07 | Offline | 12 h máximo, pérdida de red, sesión HTTP expirada, buffer cifrado/lleno, ACK perdido, 202 pendiente, 422/409 terminal; mismos IDs y borrado local solo después de ACK 200. |
| S02-P08 | Ingesta | STARTED/STOPPED reordenados, provisional idempotente→ID canónico, duplicados/digest conflictivo, posición antes STARTED, 7 días de cuarentena, versión/ventana ajena y captura tardía; STOPPED terminal tras fin/TTL/tombstone no autoriza posiciones; transacción/reconciliación correctas. |
| S02-P09 | Datos | Migración/restore aislado, índices PostGIS, purga por lotes a 90 días, evento tardío y backup según política aprobada; ninguna fuga de coordenadas en logs/audit. Evaluar particiones solo con medidas y unicidad preservada. |
| S02-P10 | UI | Vista de impacto/horario DST, conflicto y error de red, teclado/lector de pantalla, 403/429, estado desconocido, separación de configuración y ejecutivo. |
| S02-P11 | Carga | 25 dispositivos × 8 h × 60 s = 12 000 eventos/día de referencia PRD, ráfagas offline y recuperación, p95 y cuota medidos; no fijar SLO sin ensayo. |
| S02-P13 | Alertas y lectura sensible | Silencio mayor que umbral configura alerta de comunicación y antigüedad de última ubicación; causa `UNKNOWN` salvo error explícito. Lectura de ubicaciones exige capacidad, motivo y rango UTC `(0,24 h]`; falta/exceso da 422; cada consulta se audita sin coordenadas en logs. |
| S02-P12 | Físico condicionado | Matriz por OS real de flota (incluidas 16/17 si aplica), `targetSdk` y OEM, al menos dos modelos: app visible/fondo, pantalla apagada, Doze, ahorro batería, reboot, actualización, permisos/ubicación/notificación, red intermitente; registrar inicio real, MISSED_START, retraso, fin e indicadores visibles. |
| S02-P14 (propuesto) | Salud sintética / contrato | Batería normal/baja/crítica, cargador, ahorro, GPS apagado, red caída y FGS detenido; `due_at`/`observed_at`, muestra sin coordenada, cola y ACK independientes. `NO_COMMUNICATION` solo se infiere en servidor y 2% + silencio se muestra como causa posible, no confirmada. Ingesta/retención/permiso se prueban en E1 tras aprobar el [delta SDD](gps-health-change-proposal.md). |

## Métricas de sesiones y diagnóstico del fin de semana

En cada ventana: `scheduled_start/end`, `start_attempt`, `effective_start/end`, interrupciones, versión, permiso/GPS/red/batería, `captured_at`, `received_at`, backlog y ACK. Calcular cobertura temporal efectiva, capturas esperadas **solo durante tramos efectivos**, cadencia 45–75 s dentro del mismo tramo, p50/p95 de latencia, número tardío bajo umbral definido, duplicados/rechazos y tiempo de sincronización. Comparar las cuatro sesiones inferidas del fin de semana únicamente como referencia exploratoria. Explicar diferencias con eventos explícitos y telemetría; si falta evidencia, clasificar `UNKNOWN`, no atribuirlas a Android/red/GPS por conjetura.

## Vectores W1-A ejecutados en modelo de referencia

**Ejecución W1-B:** [evidencia](w1-b-implementation-2026-10-19.md). La prueba `apps/api/test/gps-policy.integration.mjs` usa únicamente PostgreSQL `geops_verify_*` desechable y cubre subconjuntos ejecutables de P02/P03/P09: auth/CSRF/capacidad, CAS/idempotencia, GiST/rollback, grupos, inmutabilidad, ventanas UTC y revocación. P02/P09 completos permanecen abiertos por lectura sensible, retención/backup y revisión independiente. V01–V12 siguen siendo modelo de referencia para los aspectos Android/ingesta, no pruebas de interoperabilidad Kotlin.

`node specs/spec-02-android-agent-wave-1/contract-vectors.test.mjs` ejecuta V01–V12 y tres comprobaciones adicionales (DST, esquemas OpenAPI y bytes PoP del paquete TypeScript existente). El modelo y los datos son sintéticos; **no** son la API GEOPS, el cliente Kotlin ni PostgreSQL. La [revisión cruzada](contract-review-2026-10-19.md) registra resultados y límites.

| Vector | Entrada sintética | Resultado esperado |
| --- | --- | --- |
| V01 | Política válida de lunes 22:00–martes 06:00 en Guatemala | Instancia 04:00–12:00 UTC, fin exclusivo. |
| V02 | Política vencida | Deniega captura en `valid_until`. |
| V03 | Política futura sin descarga al entrar en vigencia | Snapshot inactivo no autoriza captura; tombstone válido en esquema. |
| V04 | Asignación directa/grupo solapada | Intersección detectada; intervalos contiguos `[)` no colisionan. La transacción SQL se prueba en W1-B. |
| V05 | Cambio de frecuencia | Revisión/versión nueva y bloqueo de snapshot anterior. |
| V06 | Cambio de horario | Intervalo UTC nuevo no permite captura en tramo eliminado. |
| V07 | Revocación offline | Riesgo residual dentro de ventana; denegación al fin de ventana/TTL o tras tombstone. |
| V08 | Reloj desfasado, reboot y downgrade | Los tres deniegan captura. |
| V09 | `STARTED` duplicado | Un ID canónico; payload distinto con mismo correlador produce 409. |
| V10 | Evento de fin antes de `STARTED` | 202 sin ACK terminal, asociación posterior. Expiración de cuarentena se prueba en W1-E1. |
| V11 | Reintentos administrativos idempotentes | Misma clave/precondición reproduce 200; precondición distinta 409; capacidad revocada 403. |
| V12 | Fin de jornada sin Internet | Detiene capturas en borde y conserva evento pendiente sin ACK. |

## Gates de salida

- W1-A: decisiones y esquemas de diseño válidos, trazabilidad completa y V01–V12 PASS en modelo de referencia. Esto aprueba solo una línea base para implementación sintética; interoperabilidad Kotlin/PostgreSQL y concurrencia real siguen gates de W1-B/C/E1.
- W1-B/C/D/E1: P01–P11 y P13 aplicables PASS con datos sintéticos, seguridad sin crítico abierto, migraciones/restore y contratos consistentes con SPEC-00/01. Dejar pendientes etiquetados.
- W1-E2: P12 por matriz, identidad y privacidad operativas aprobadas, permiso/indicador visibles y autorización de piloto. Un inicio automático fallido se registra como límite, no se oculta con captura manual.
- Antes de uso general: decisión separada sobre cobertura alcanzada, batería, retención, alertas, MDM y riesgos residuales; esta SPEC no la concede.
