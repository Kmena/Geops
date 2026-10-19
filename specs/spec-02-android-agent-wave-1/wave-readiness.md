# Readiness — SPEC-02 después de la revisión W1-A

**Acceso Staging bajo `/staging/` (2026-10-19):** [addendum Caddy](staging-path-readiness-2026-10-19.md) y [revisión de seguridad](staging-path-security-review-2026-10-19.md). Configuración, Kotlin/PoP canónico y rutas locales probadas sin servidor ni despliegue. `ACCEPTABLE_WITH_MITIGATIONS` solo para preparar Staging sintético; el mismo origen con la PoC conserva riesgo lateral de XSS y exige aceptación explícita. E2E HTTPS, certificado real y revisión independiente siguen pendientes; despliegue aún no autorizado.

**Preparación Staging (2026-10-19):** [consolidación y checklist](staging-readiness-2026-10-19.md). Infraestructura independiente y validación estática listas para revisión; no se desplegó. `READY_WITH_CONDITIONS` se limita a los artefactos locales. Ejecución Staging, E2E de navegador, carga sostenida, Kotlin fresco, restore operativo y revisión independiente siguen `BLOCKED`; W1-E1/E2 no cambian de estado.

**Actualización W1-E1 Corte 3 (2026-10-19):** [scheduler, activación y Web sintéticos](w1-e1-c3-scheduler-activation-web-2026-10-19.md) implementados con migraciones 0013–0014, PostgreSQL desechable, prueba de 25 dispositivos y restauración local. El cliente Web ejerció API autenticada, pero no hubo E2E de navegador ni revisión de seguridad independiente. ADR-018 y capacidades nuevas son propuestas; retención y restore operativos siguen pendientes. **W1-E1 continúa BLOCKED** para cierre/operación; W1-E2 no se habilita. Las notas previas abajo son evidencia histórica.

**Actualización W1-E1 Corte 2 (2026-10-19):** [sesiones y posiciones sintéticas](w1-e1-c2-sessions-positions-2026-10-19.md) implementadas con PoP, sesión canónica, PostGIS, ACK posterior a COMMIT, cuarentena cifrada y lectura tenant auditada; 67 aserciones nuevas, regresiones y Kotlin wire pasan. **W1-E1 continúa BLOCKED** por scheduler, activación/concesiones operativas, Web E2E y revisión independiente de seguridad. El párrafo del corte anterior se conserva como evidencia histórica, no como estado actual de los endpoints.

**Actualización W1-E1 (2026-10-19):** [evidencia de preparación](w1-e1-readiness-2026-10-19.md). Configuración PoP y ancla real hacia salud pasaron con PostgreSQL desechable (24 aserciones); Kotlin analizó el snapshot HTTP exacto, Web tiene adaptador de lectura sin conectar a pantallas y restore desechable conservó migraciones y datos. **W1-E1 continúa BLOCKED**: faltan ingesta/reconciliación de sesiones y posiciones, scheduler, activación/tenant operativos, Web E2E, retención programada y revisión de seguridad independiente. El resultado no autoriza W1-E2 ni despliegue.

**Actualización W1-D Web (2026-10-19):** T05 tiene [interfaz sintética y evidencia](w1-d-web-2026-10-19.md) en cuatro rutas protegidas, con borradores solo en memoria, fixtures de políticas/dispositivos/sesiones/salud y resumen ejecutivo separado. Typecheck, lint, build, contratos y 7 pruebas Web pasan; inspección móvil local sin desbordamiento. **W1-D integrada operativamente sigue BLOCKED**: capacidades/tenant reales, motivo auditado en servidor, 403/429, DST contra backend, identidad/PoP, retención, seguridad independiente y Android físico siguen pendientes. W1-E1/E2 no cambian de estado.

**Actualización GPS-HEALTH-001 (2026-10-19):** contrato de salud aceptado **solo para backend sintético**, migración 0010 y rutas de ingesta/consulta incorporadas; [evidencia](gps-health-backend-2026-10-19.md). Esto elimina el bloqueo de forma de mensaje para diseñar W1-D con fixtures, pero W1-D integrada continúa **BLOCKED**: faltan pantalla Web, concesión tenant operativa, instalación/configuración PoP, pruebas Kotlin nuevas, privacidad/restore y revisión independiente. W1-C y W1-E1 no se declaran completas; W1-E2 permanece bloqueada y no hay despliegue.

**Actualización W1-C (2026-10-19):** T06–T08 cuentan con [núcleo Kotlin sintético y evidencia](w1-c-implementation-2026-10-19.md), pero W1-C **NO está completa**: no hay APK de producto, integración de ciclo de vida/Keystore, contrato de salud aprobado ni endpoints E1. El [delta GPS-HEALTH-001](gps-health-change-proposal.md) permanece propuesto; el baseline W1-A no cambió. Compilación y 14 pruebas JVM pasan; P06/P07/P14 completos, seguridad independiente y P12 físico siguen abiertos.

**Actualización W1-B (2026-10-19):** T03–T04 tienen implementación sintética y pruebas PostgreSQL locales según [informe W1-B](w1-b-implementation-2026-10-19.md). La matriz histórica de entrada W1-A abajo se conserva. W1-B está `IMPLEMENTED_WITH_OPEN_GATES`: P02/P09 íntegros, restore físico y revisión independiente pendientes; no se declara cierre ni autorización operativa. W1-C puede avanzar solo en motor simulado con fixtures, mientras W1-D integrada espera cierre de API/capacidades y P10/P13. W1-E1/E2 siguen bloqueadas.

**Corte:** 2026-10-19. **W1-A: CLOSED_FOR_SYNTHETIC_IMPLEMENTATION.** La [revisión cruzada](contract-review-2026-10-19.md) resolvió las decisiones P0 de diseño de la [auditoría de entrada](readiness-audit-2026-10-19.md) en ADR-015–017, [modelo](data-model.md), [API](api-contracts.md), [OpenAPI](openapi.design.yaml), [tareas](tasks.md) y [pruebas](test-plan.md). Los 12 vectores solicitados pasaron en un modelo de referencia; la línea base está aprobada **solo para implementación sintética de W1-B**. No se declara interoperabilidad Kotlin/PostgreSQL, captura real ni cierre de SPEC-00/01.

## Resolución de hallazgos de entrada

| Hallazgo | Resolución W1-A | Evidencia aún necesaria |
| --- | --- | --- |
| H01 capacidades | [ADR-015](../architecture/adr/ADR-015-capacidades-administrativas-gps.md): siete permisos por admin, sin roles de negocio, denegación por defecto; replay idempotente comprueba capacidad vigente. | Migración/middleware y P02 en W1-B; concesión real con doble control antes de uso operativo. |
| H02 ID sesión | [ADR-016](../architecture/adr/ADR-016-identidad-sesiones-gps.md): servidor crea `session_id`, agente usa `client_session_id` provisional, vínculo único/idempotente. | P08 e interoperabilidad Android/API. |
| H03 asignación temporal | [ADR-017](../architecture/adr/ADR-017-politicas-gps-temporales-offline.md): sin precedencia, locks grupo/política y dispositivo, exclusión temporal; futura requiere online. | Restricción DB, carreras y P03 en DB desechable. |
| H04 reloj/offline | ADR-017: instancias UTC servidor, ancla monotónica por boot, 12 h máximo, reboot offline fail closed. | P05/P07; aceptación residual privacidad antes de piloto. |
| H05 nombres | [Plan](plan.md) y [tareas](tasks.md) usan A fundamentos, B políticas, C Android, D Web, E1 integración sintética/E2 piloto. | Ninguna decisión de diseño; confirmar responsables. |
| H06 idempotencia/límites | [API](api-contracts.md): key UUID 24 h, fingerprint con If-Match, auth antes del replay; dispositivo 100 eventos, 128/256 KiB, 202 pendiente, 422 atómico, 409 conflicto. | P01/P02/P08, transacciones y cuotas bajo carga. |
| H07 estados | ADR-016: tabla de transiciones, STARTED tras registro proveedor, OPEN/INTERRUPTED/STOPPED/UNKNOWN_END, diagnóstico sin ancla y 7 días de dependencia. | P06/P08 y pruebas de muerte de proceso. |
| H08 zona/DST | ADR-017: medianoche, offsets gap/overlap, truncamiento de vigencia, instancias UTC servidor. | V01–V03/P05 con tzdb reales. |
| H09 Android | [Pruebas](test-plan.md): matriz por OS real/targetSdk/OEM y MISSED_START; prohibido eludir restricciones. | Inventario físico y P12, solo E2. |
| H10 límites | Captura 30–300 s, sync 60–900 s, alerta 300–7200 s (default 900), offline 12 h, 7 días dependencia. | Batería/carga y privacidad pueden reducir intervalos antes de piloto; no ampliarlos sin nueva revisión. |
| H11 rama | Rama sigue nacida de PoC y ADR-014 heredado no está versionado. | Aislar diff antes de PR sin descartar cambios ajenos. |

## Matriz de entrada

| Subwave | Estado tras W1-A | Entrada permitida | Bloqueo para salida |
| --- | --- | --- | --- |
| W1-A fundamentos/contratos | **CLOSED_FOR_SYNTHETIC_IMPLEMENTATION** | ADR/API/OpenAPI y revisión cruzada completados; V01–V12 PASS en referencia. | Sin prueba de interoperabilidad Kotlin/PG ni permiso operativo. |
| W1-B políticas/persistencia | **READY_WITH_CONDITIONS** para iniciar T03–T04 sintéticos | DB desechable; capacidades/admin/CSRF SPEC-01, ADR-013, P02/P03/P09 y paridad OpenAPI como gates. | No activar políticas reales; exclusión GiST, locks y rollback deben pasar pruebas antes de integrar. |
| W1-C agente Android | **READY_WITH_CONDITIONS** para motor simulado | T06–T08 con GPS falso; Kotlin ejecuta V01–V12, PoP/Keystore y selección cifrado ADR-008. | Sin garantía FGS real ni datos reales; P04–P07. |
| W1-D administración Web | **BLOCKED** para UI operativa integrada; diseño con fixtures permitido | T05 espera B y capacidades, shell/CSRF/accesibilidad SPEC-01. | P02/P10/P13 y acceso sensible auditado. |
| W1-E1 integración sintética | **BLOCKED** | T09–T11 esperan B/C/D, P10–P17 de SPEC-01 aplicables, ADR-013 y revisión independiente. | P04/P07–P09/P11/P13, carga/retención/restauración. |
| W1-E2 piloto físico | **BLOCKED** | T12 requiere identidad/privacidad operativas, autorización específica, inventario OS/OEM, resolución MDM externa. | P12 y aceptación explícita de riesgos. |

## Puertas que siguen abiertas

- **Antes de declarar interoperabilidad de producto:** ejecutar V01–V12 en Kotlin, SQL concurrente en PostgreSQL desechable y pruebas HTTP de TS/admin/PoP; la referencia Node y el esquema OpenAPI no sustituyen esos ensayos.
- **Antes de datos reales:** P10–P17/W0A-E2/T18 pendientes de SPEC-01; M01–M10 y A01–A06 de SPEC-00; aviso/consentimiento, acceso, retención/backups y aceptación de revocación offline. ADR-014 continúa propuesto.
- **Antes de PR o publicación:** limpiar procedencia de rama PoC y enlace a ADR-014, conservando íntegros los cambios heredados. No se hace commit/push/merge por esta SPEC.

MDM conserva cuatro bloqueos independientes (desinstalación, restricción de ubicación, sin reset, multimarca); no bloquea W1-A ni B/C/D sintéticas. Ninguna captura remota se activa por la documentación.

## Verificación documental W1-A

`npm run contracts:check` de SPEC-01, `npm run typecheck --workspace @geops/api-contracts` y `SwaggerParser.validate` de SPEC-02 PASS; OpenAPI tiene 21 operaciones y generó tipos TypeScript. `node specs/spec-02-android-agent-wave-1/contract-vectors.test.mjs`: 15/15 PASS (12 vectores y tres comprobaciones adicionales). Enlaces locales de documentos nuevos y ADR-015–017 PASS; 12/12 tareas citan requisitos y pruebas; espacios finales y `git diff --check` PASS. Escaneo por patrones de secretos/pares de coordenadas de alta precisión sin coincidencias en archivos W1-A. El build de `dist` y `node --test` recibieron EPERM del sandbox; se usaron typecheck sin escritura y ejecución directa del test. La evidencia no sustituye integración real, seguridad independiente o validación física.
