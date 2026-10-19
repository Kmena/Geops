# Auditoría de rama y preparación de SPEC-02 / Wave 1

**Corte:** 2026-10-19. **Decisión:** W1-A `READY_WITH_CONDITIONS` para diseño, ADR, esquemas y vectores **sintéticos**; aún no se aprueba implementar W1-B–E completos ni capturar GPS real. Auditoría de documentación y árbol local, sin migraciones, despliegue, consulta GPS remota, commit, push o merge. El informe no cambia contratos existentes.

## 1. Git y procedencia

| Dato | Resultado |
| --- | --- |
| Rama activa / HEAD | `codex/spec-02-wave-1` / `d72cdb49d95915f8772ffcb6818698e4439c1a57` |
| Base real de creación | Reflog: `branch: Created from HEAD` el 2026-10-19 09:44:57 -0600; ese HEAD es `codex/poc-gps-weekend` y `origin/codex/poc-gps-weekend`, ambos `d72cdb4`. `merge-base` con esa rama es el propio HEAD; **cero commits exclusivos de SPEC-02**. |
| Ancestro de SPEC-01 | `47f741de6a4193b616119ec965abd590c1189bd1`; entre ese commit y HEAD hay nueve commits de PoC GPS. |
| Ancestro de `origin/main` local | `b5a5b5d25b96f6e4d134739fbcb7383cd8bfef4c`; no es la base inmediata. No se hizo `fetch`, por lo que las referencias remotas son las ya disponibles localmente. |

**Inventario completo de cambios visibles:** ocho archivos rastreados modificados en `specs/spec-00-technical-feasibility/` (`README.md`, `closure-report.md`, `open-questions.md`, `pilot-test-plan.md`, `requirements.md`, `research.md`, `risks.md`, `wave-readiness.md`); dos archivos nuevos heredados (`specs/architecture/adr/ADR-014-mdm-flota-existente-propuesto.md`, `specs/spec-00-technical-feasibility/mdm-business-decision.md`); diez archivos nuevos propios de SPEC-02 (`README.md`, `requirements.md`, `architecture.md`, `data-model.md`, `api-contracts.md`, `research.md`, `risks.md`, `test-plan.md`, `plan.md`, `tasks.md`) y este informe. Ningún cambio rastreado difiere entre HEAD y `codex/poc-gps-weekend`; los documentos nuevos siguen sin seguimiento. No se atribuyen los cambios de SPEC-00/ADR-014 a SPEC-02 ni se incorporan automáticamente.

**Ignorados relevantes, sin leer contenido:** `experiments/weekend-gps-poc/infra/.env.local`, `android/.gradle/`, `android/app/build/`, `android/build/`, `dist-web/`, `node_modules/`. Las reglas `git check-ignore -v` los confirman. El listado recursivo de ignorados emitió advertencia de ruta demasiado larga en caché Gradle de Windows; los nombres de directorios relevantes sí se identificaron. `git diff --check` es limpio para archivos rastreados; no cubre documentos sin seguimiento, validados por separado.

**Dependencia de publicación:** `plan.md` enlaza el ADR-014 aún sin seguimiento. Un PR con solo SPEC-02 tendría enlace roto si ADR-014 no se publica antes o se sustituye por una referencia estable. La rama actual también arrastra nueve commits de PoC desde SPEC-01: antes de un futuro PR de producto, decidir base y aislar el diff sin perder cambios heredados.

## 2. Trazabilidad de las 12 tareas

Se revisaron [PRD v1.1](../prd/GEOPS-PRD-v1.1.md), [SPEC-00](../spec-00-technical-feasibility/README.md), [SPEC-01](../spec-01-foundation-wave-0a/wave-readiness.md), [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md), [ADR-013](../architecture/adr/ADR-013-restore-security-epoch.md), [ADR-014 propuesto](../architecture/adr/ADR-014-mdm-flota-existente-propuesto.md), [SPEC-02](README.md) y la [evidencia agregada](research.md). La matriz siguiente es trazabilidad **inferida por auditoría**; `tasks.md` no cita explícitamente IDs `S02-R`/`S02-P` en sus doce filas. Debe incorporarse antes de cerrar W1-A. `P10–P17` de T09 son de SPEC-01 y necesitan prefijo inequívoco.

| Tarea | Requisitos | Dependencias determinantes | Pruebas asociables | Estado de enlace |
| --- | --- | --- | --- | --- |
| T01 | R02,R04,R09 | PRD RF-04/RN-07; producto, privacidad, seguridad | P01,P05 | Inferido; decisiones abiertas |
| T02 | R01–R03,R05,R06,R10 | Contratos de identidad/PoP SPEC-00 y admin SPEC-01 | P01,P04,P08 | Inferido; sin OpenAPI SPEC-02 |
| T03 | R02,R09,R10 | T01–02, migrador/restore SPEC-01 | P03,P09 | Inferido; alcance temporal pendiente |
| T04 | R01,R02,R09 | T03, auth/CSRF/audit SPEC-01, roles nuevos | P02,P03 | Inferido; RBAC falta |
| T05 | R01,R08 | T02,T04 y shell Web SPEC-01 | P02,P10 | Inferido; wave mal clasificada |
| T06 | R03,R04,R09 | T01–02, Keystore/identidad, cifrado ADR-008 | P04,P05,P06 | Inferido; reloj/offline pendiente |
| T07 | R04,R05,R07 | T06, FGS por versión Android | P05,P06,P12 | Inferido; P12 físico posterior |
| T08 | R06,R07 | T02,T07, ADR-008 | P07,P08 | Inferido; cuotas/ACK abiertos |
| T09 | R03,R05,R06,R10 | T03–04,T08, SPEC-01 P10–P17/W0A-E2 | P04,P08,P09 | Inferido; `P10–P17` ambiguo |
| T10 | R05,R07,R08,R11 | T09, privacidad/retención | P09,P10,P11,P13 | Inferido; alerta/umbral abierto |
| T11 | R01,R03,R06,R09,R10 | T04–10, ADR-013/T18 | P02,P04,P07,P09 | Inferido; revisión externa pendiente |
| T12 | R04,R05,R07 | Gates operativos SPEC-00/01, aviso y autorización física | P12 | Inferido; físico bloqueado |

**Resultado:** 12/12 tienen una ruta de requisitos/dependencias/pruebas razonable, pero 0/12 tienen referencias explícitas completas en el backlog. Los 543 puntos, cuatro sesiones *inferidas*, 81.82% de intervalos 45–75 s, 84 sincronizaciones tardías y cero saltos sospechosos son datos agregados aportados por el usuario; no se verificaron contra el servidor ni prueban inicio/fin efectivo.

## 3. Hallazgos por severidad

| ID | Severidad | Hallazgo y efecto | Corrección requerida |
| --- | --- | --- | --- |
| H01 | ALTA | [SPEC-01 data model](../spec-01-foundation-wave-0a/data-model.md) y migración `0002_admin.sql` no tienen rol lector/editor; la identidad admin actual solo devuelve ID, email y CSRF. SPEC-02 exige ambos roles en UI/API. Una sesión autenticada podría recibir capacidad de publicación sin autorización fina. | W1-A define roles/permisos y migración/contrato; W1-B/D no publican hasta probar autorización de servidor y auditoría. |
| H02 | ALTA | [Modelo](data-model.md) dice “IDs UUID de servidor salvo `event_id`”, mientras [API](api-contracts.md) dice que Android genera `session_id`. Idempotencia, FK y atribución de STARTED/STOPPED quedan indeterminadas. | Elegir quién emite `session_id`, cuándo se reserva, y reglas de reintento/colisión/ACK; congelar vectores. |
| H03 | ALTA | `gps_device_assignment_state` guarda un solo puntero actual, pero se aceptan vigencias futuras y membresías de grupo históricas. Publicar o editar un grupo puede introducir solapes posteriores sin actualizar todos los dispositivos en una misma transacción. | Definir resolución temporal y bloqueo de cambios de membresía/publicación; materializar snapshots futuros o calcularlos con índice/serialización y prueba concurrente. |
| H04 | ALTA | El límite offline propuesto de 24 h y la comprobación de reloj monotónico no definen ancla persistente tras reboot, deriva tolerada, recepción de tombstone ni tratamiento de `captured_at` atrasado. Puede prolongar captura revocada o rechazar backlog legítimo. | Decidir fail-closed al reiniciar sin revalidación, ancla de hora de servidor, TTL máximo, error/cuarentena de timestamps y aprobación de riesgo residual. |
| H05 | MEDIA | El [plan](plan.md) actual coloca UI en W1-B, integración en W1-D y piloto en W1-E; esta auditoría solicita W1-D Web y W1-E integración/validación. [Tasks](tasks.md) repite la nomenclatura anterior. | Publicar mapa único de subwaves e IDs, sin cambiar alcance por renombrar. Ver matriz siguiente. |
| H06 | MEDIA | `publish` pide `Idempotency-Key`, pero no se especifican ámbito, digest, duración de retención ni respuesta repetida. `resume/pause/revoke` no declaran la misma protección ni `If-Match`. Los lotes de sesión carecen de límites y semántica de ACK/cuarentena terminal. | Congelar idempotencia de todas las mutaciones y eventos, límites/tamaños/códigos y transición atómica antes de controladores. |
| H07 | MEDIA | Inicio efectivo se ubica “después de confirmación del proveedor”, sin definir si es alta del listener o primera muestra. `UNKNOWN_END`, `INTERRUPTED`, `RESUMED` y orden de eventos no tienen transición completa ni plazo de cuarentena. | Tabla de estados/eventos, autoridad del tiempo y reconciliación con pruebas de caída y orden invertido. |
| H08 | MEDIA | Backend y Android resuelven zona IANA/DST por separado; no se especifica versión tzdb, truncamiento de `valid_from/until` a mitad de ventana, ni qué ocurre si un gap DST deja ventana vacía. | En W1-A fijar vectores compartidos UTC/local y política de divergencia (no capturar ante discrepancia). |
| H09 | MEDIA | Pruebas físicas nombran 10/12/14/15 y “versiones disponibles”, pero falta matriz explícita por OS **real de la flota**, `targetSdk`, permisos y versión OEM; la documentación oficial ya enumera Android 16/17. | Inventariar versiones objetivo y cubrir cada combinación representativa antes de W1-E. |
| H10 | MEDIA | SPEC-02 solo propone intervalos 30–300 s y 60–900 s, umbral de alerta configurable, cuotas/lotes por congelar y 90 días con política de tardíos/backups abierta. No hay valores finales ni pruebas de límites exhaustivas. | Resolver en W1-A lo necesario para schema y dejar parametrizados umbrales con límites aprobados antes de W1-B/C. |
| H11 | BAJA | La rama de producto nació de PoC; el diff futuro podría mezclar componentes experimentales. `plan.md` depende de ADR-014 heredado y aún sin seguimiento. | Aislar historia y dependencias antes de PR, preservando los archivos heredados. |

La decisión central sí es consistente: política solo configurada por GEOPS Web, backend autoritativo, descarga autenticada por dispositivo; la PoC está separada del producto. El diseño distingue sesiones programadas/efectivas e interrupciones, y no convierte silencios GPS en hechos. Las [restricciones oficiales Android 12+/14+ para FGS de ubicación](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) respaldan el tratamiento de `MISSED_START`; la [guía de alarmas](https://developer.android.com/develop/background-work/services/alarms) no permite prometer cadencia exacta con WorkManager. La matriz física sigue pendiente.

## 4. Readiness por subwave solicitada

La tabla usa la nomenclatura **de esta auditoría**. Equivalencia pendiente de adoptar: W1-A actual=A; W1-B actual=B sin UI; W1-C actual=C; W1-D solicitado=UI de T05 + vistas de T10; W1-E solicitado=integración API de T09/T10/T11 + piloto T12, separando un gate sintético de otro físico.

| Subwave | Estado | Entrada y dependencia | Evidencia necesaria para salida |
| --- | --- | --- | --- |
| **W1-A Fundamentos/contratos** | **READY_WITH_CONDITIONS** | Puede comenzar con documentos y fixtures sintéticos; no requiere MDM ni teléfono real. Registrar H01–H10, acordar mapa de waves y responsables de decisiones. | ADR de autoridad, roles, horario/DST/reloj/offline, IDs/estados, límites, OpenAPI/JSON Schema y matriz R↔T↔P explícita; revisión backend/Android/seguridad. |
| **W1-B Políticas/persistencia** | **BLOCKED** como wave completa | W1-A aprobada; autorización admin/roles y auditoría SPEC-01 verificadas; modelo de asignación temporal/concurrencia resuelto; migrador/restore ADR-013. | P02,P03,P09 y pruebas de publicación/revocación idempotente, grupo concurrente, tombstones, rollback y auditoría en PostgreSQL sintético. |
| **W1-C Agente Android** | **READY_WITH_CONDITIONS** solo para prototipo sintético aislado; integración BLOCKED | W1-A congela semántica; SPEC-01 PoP/Keystore y ADR-008 cifrado se revisan antes de caché/buffer de producto. MDM no es prerequisito del motor sintético. | P04–P07 con proveedor falso, callback tardío, reloj/reboot, FGS rechazado, notificación, ACK y ninguna captura fuera de ventana. |
| **W1-D Administración Web** | **BLOCKED** como edición operativa | W1-B API y roles aprobados; shell/CSRF/accesibilidad de SPEC-01 concluidos para rutas nuevas. Puede diseñarse maqueta sintética sin publicar. | P02,P10,P13; editor, conflictos, impacto, versión aplicada observada, estados desconocidos y separación ejecutiva/operativa probados. |
| **W1-E Integración/validación** | **BLOCKED** | W1-B–D y PoP/restore/seguridad SPEC-01; primero integración PostGIS sintética. El piloto físico requiere privacidad, identidad real y autorización específica; MDM-001/002/003/multimarca son gates del resultado operativo, no de W1-A–D. | P04,P07–P09,P11,P13 integrales; después P12 por modelo/OS, evidencia de sesiones reales e interrupciones, batería, límites y decisión formal de riesgo. |

SPEC-01 continúa `READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING` solo en alcance sintético; Wave 0A no está cerrada. P10–P17 y W0A-E2 de seguridad, T18/ADR-013 operativo, dos custodios y los ensayos físicos siguen pendientes. SPEC-00 permanece BLOCKED. No se convierte la investigación MDM en bloqueo general de diseño.

## 5. MDM y riesgos residuales

Cuatro líneas separadas: (1) impedir desinstalación, (2) impedir apagar ubicación en turno, (3) aprovisionar sin restablecimiento y (4) demostrar cobertura multimarca. [ADR-014](../architecture/adr/ADR-014-mdm-flota-existente-propuesto.md) es **propuesta**, no decisión; ManageEngine Free y dos teléfonos no tienen PASS transferible desde Trial/fake. W1-A y prototipos sintéticos de B/C/D no requieren privilegios MDM. Activación real sí depende de identidad, privacidad y decisión operativa sobre los controles MDM prometidos.

Riesgos residuales aun tras corregir documentos: Android/OEM puede impedir inicio programado; un teléfono offline no conoce revocación hasta TTL; un sistema comprometido puede mentir sobre tiempo/eventos; batería y red alteran frecuencia; retención de backups y alertas precisan aprobación. Las métricas históricas agregadas no resuelven estos riesgos.

## 6. Validaciones efectuadas y decisión

- `git diff --check`: PASS sobre cambios rastreados. Escaneo separado de los archivos nuevos: enlaces locales PASS, espacios finales PASS, patrones de secreto/credencial/coordenadas de alta precisión sin coincidencias. Es un escaneo de patrones, no prueba absoluta de ausencia de datos sensibles.
- No se ejecutaron migraciones, tests Android, pruebas de backend, CI, despliegue ni consultas al servidor GPS. Ninguna evidencia nueva cambia el estado de SPEC-00/01.
- **Se puede iniciar W1-A de forma segura** como trabajo de especificación y contratos sintéticos, manteniendo H01–H10 como decisiones/gates de salida y sin trasladar código PoC. **No iniciar W1-B–E completos** con los contratos actuales. Antes de cualquier PR, aislar la base PoC y resolver el enlace a ADR-014 sin incorporar cambios heredados por accidente.
