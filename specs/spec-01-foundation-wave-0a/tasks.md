# Tasks — backlog implementable de Wave 0A

**Estado:** T01–T05 completadas en su alcance fundacional; T02 cerró CI remoto. T06–T18 tienen implementación sintética local con aceptación parcial salvo T13 DONE_LOCAL. P04 restauración de revocación pasó para copia posterior a revocación; T18 y la wave permanecen abiertos. Evidencias: [T01–T05](implementation-evidence-T01-T05.md) y [T06–T18](implementation-evidence-T06-T18.md). Las referencias Pnn apuntan a [test-plan.md](test-plan.md). Un cierre exige evidencia real de implementación, no solo el texto de esta tabla. Una tarea puede ser paralela solo si sus dependencias terminan y no modifica los mismos archivos.

| ID | Objetivo y archivos previstos | Depende de | Aceptación / pruebas | Riesgo | Evidencia de cierre |
| --- | --- | --- | --- | --- | --- |
| T01 | Configurar npm workspaces, lockfile y scripts; package.json raíz, apps/api/package.json, apps/web/package.json, packages/api-contracts/package.json. | W0A-E1 y alcance sintético E2/E4 | Instalación reproducible, sin tocar Android/diagnóstico ni cargar .env.local; P01. | R07 | CI con lockfile y lista de paquetes. |
| T02 | TS strict, lint y CI base; tsconfig.base.json, .github/workflows/*.yml. | T01 | Typecheck/lint sin excepciones; P01. | R07 | Job CI verde y configuración revisada. |
| T03 | Contratos versionados y OpenAPI; packages/api-contracts/src, openapi.yaml generado/validado contra este SPEC. | T01 | Rutas/esquemas reflejan SPEC-00 aclarado, vectores PoP/attestation y securitySchemes; P02. | R03,R08 | Diff de contrato y validación. |
| T04 | Esqueleto Fastify, config estricta, errores, logging y health; apps/api/src/{app,config,errors,health,logging}. | T02,T03 | Ready falla con DB ausente, logs sin secretos; P02–P04. | R05 | Pruebas y muestra sanitizada. |
| T05 | Compose, Dockerfiles y DB/migrador; infrastructure/{docker,compose,nginx}, apps/api/migrations. | T01,T04 | 3 servicios + job, PostGIS, volumen y redes propias; puertos 3500/3501 comprobados inmediatamente antes de arrancar; P03–P04. | R04,R07 | compose config, salud y migración en DB ficticia. |
| T06 | Bootstrap admin, tabla y Argon2id; apps/api/src/admin-auth, migrations. | T04,T05 | Un solo bootstrap local, sin registro público/default password; P05,P08. | R05 | Prueba de bootstrap y auditoría. |
| T07 | Login, cookie, CSRF, logout y revocación; apps/api/src/admin-auth. | T06 | Sesión 8 h/30 min, Origin/CSRF, error genérico; P06–P08. | R05 | Pruebas HTTP negativas/positivas. |
| T08 | Recuperación operativa y rate limits; apps/api/src/admin-auth, docs/operations. | T07 | Código único o procedimiento presencial de doble control, sin bypass; P09. | R05 | Runbook y pruebas de expiración. |
| T09 | Persistencia de device/binding/invitation/claim/key/session/challenge/nonce; migrations, apps/api/src/device-identity/repository. | T04,T05 | Unicidad parcial, CAS, estados y expiración con fixtures; P10,P11. | R03,R06 | Migración, pruebas de carrera. |
| T10 | Invitación, claim, proof y guardia de activación; apps/api/src/device-identity/enrollment. | T07,T09 | 256 bits/10 min, P-256, reto de attestation previo a keygen, challenge 2 min y guardia física/MDM que falla cerrada; P10–P13. | R03,R06 | Resultados de replay y no-activación real. |
| T11 | Sesión de dispositivo y PoP; apps/api/src/device-identity/session. | T09,T10 | Token 15 min, firma y nonce por llamada, refresh por challenge; P14,P15. | R03 | Suite criptográfica y trazas sanitizadas. |
| T12 | Rotación, revocación, pérdida/reinstalación/reasignación; apps/api/src/device-identity/lifecycle. | T11 | Transacciones revocan accesos previos; attestation de clave nueva o excepción, pérdida/reinstalación; P16,P17. | R03,R06 | Suite de ciclo de vida. |
| T13 | Interfaz MdmProvider, fake etiquetado y cliente read-only; apps/api/src/mdm. | T03,T04 | Customer ID string, fake/mocks, cliente real deshabilitado, sin escrituras; paginación y 3xx/401/403/429; P18–P21. | R01,R02 | Pruebas mock y revisión de métodos HTTP. |
| T14 | Almacén cifrado OAuth/refresh y adaptación de diagnóstico existente; apps/api/src/mdm, apps/api/test. | T05,T13 | OAuth simulado solo backend, grants ficticios cifrados, refresh single-flight, ningún secreto real usado/expuesto; P20–P22. | R02,R05 | Pruebas de redacción y migración controlada. |
| T15 | Auditoría, redacción y observabilidad de auth/identidad/MDM; apps/api/src/audit, logging. | T07,T10,T13 | Eventos sin secretos, correlation_id y métricas de fallo; P08,P22. | R05 | Muestra sanitizada y tests. |
| T16 | Web shell responsive, router y estados UI; apps/web/src/{app,routes,components}. | T01,T03 | Rutas protegidas, carga/vacío/error accesibles; P23. | R07 | Capturas y prueba de accesibilidad. |
| T17 | Cliente API, sesión admin y vistas de inventario/estado MDM; apps/web/src/{api,auth,pages}. | T07,T13,T16 | Cookie/CSRF, sin token MDM, fuente fake visible; P24,P25. | R02,R05 | Pruebas de red y navegador. |
| T18 | Cierre de seguridad, backup/restore ficticio, docs operativas; docs/{development,deployment,operations}, scripts/test. | T05–T17 | Puertas de test, restauración y revisión de seguridad de código sin datos reales; P03,P04,P10–P17,P22,P25. | R04,R05,R06 | Informe de evidencia y riesgos residuales. |

## Paralelismo y ruta crítica

Tras T01–T03 pueden avanzar en paralelo T04/T05 (API/infra) y T16 (web shell). Tras T05, T06–T08 (admin), T09–T12 (identidad) y T13–T14 (MDM) son líneas separadas con puntos de integración: T10 necesita admin; T14 necesita DB; T17 necesita auth+MDM; T15 consolida auditoría. Ruta crítica aproximada T01→T03→T04→T05→T06→T07→T10→T11→T12→T18. La aprobación W0A-E2 es provisional: el cierre de identidad requiere P10–P17 y revisión de seguridad de implementación; ningún paralelismo habilita datos reales.

## Regla de completion

Una tarea está DONE solo con código, prueba correspondiente, revisión, evidencia sanitizada y actualización de trazabilidad. Una historia S01–S05 está completa solo cuando todas sus tareas y pruebas pasen. SPEC-00 se actualiza exclusivamente con evidencia real de Free/piloto, nunca con P01–P25 simuladas.
## Autorización y dependencias externas

| Grupo | Puede iniciarse | Restricción de cierre |
| --- | --- | --- |
| T01–T05 | Sí, ahora, con configuración y datos sintéticos; verificar 3500/3501 justo antes de ejecutar servicios. | P01–P04, sin acceso a .env.local ni servicios ajenos. |
| T06–T08 | Sí, después de T04/T05, con cuentas ficticias. | P05–P09 y revisión de seguridad de auth. |
| T09–T12 | Sí, después de sus dependencias, con claves y MDM simulados bajo ADR-012 provisional. | P10–P17 + revisión de seguridad de implementación; ninguna activación real. |
| T13–T14 | Sí, con fake/mocks y grants ficticios. | Proveedor real deshabilitado; M01–M10 Free siguen externos. |
| T15–T18 | Sí, al completar dependencias con datos ficticios. | Cierre sintético no sustituye A01–A06 ni privacidad/productivo. |

No se programa la fecha de Free o del piloto en esta tarea. Integrador MDM/QA y responsable Android/QA de piloto quedan designados **por rol**; titulares y ventanas siguen pendientes. El seguimiento externo se mantiene en [wave-readiness.md](wave-readiness.md).

## Corte de implementación T01–T05 — 2026-10-16

| ID | Estado | Evidencia / dependencia restante |
| --- | --- | --- |
| T01 | DONE | Instalación limpia de 136 paquetes desde lockfile; workspaces y diagnóstico heredado verificados en P01. |
| T02 | DONE | P01 local y job remoto `foundation` PASS en el [run 38947799854](https://github.com/Kmena/Geops/actions/runs/38947799854), commit `c781faeec53ff4fcea3db609dc6b0486275a882e`. |
| T03 | DONE | OpenAPI 3.1 validado contra SPEC-01 y 4 vectores sintéticos PASS; controladores pertenecen a T10–T12. |
| T04 | DONE | 4 pruebas Fastify PASS; API sobrevive caída DB y ready 503/200 cumple P03. |
| T05 | DONE | Compose, P03 y la porción fundacional de P04 (PostGIS, migración, checksum, persistencia y restore ficticio) PASS. El subcaso de revocación de P04 pertenece a T12/T18. |

Ninguna tarea posterior T06–T18 se inició. P04 completo no se marca PASS hasta T12/T18: exigir ese subcaso para cerrar T05 crearía una dependencia circular T05→T06→T12→T05. El estado general de Wave 0A no es COMPLETE.

## Validación CI de T02 — 2026-10-16

El 2026-10-16 se repitió P01 desde `npm ci --ignore-scripts --offline=false`: 136 paquetes, lint, typecheck, build, 26 pruebas y OpenAPI sin error. GitHub Actions ejecutó el workflow de esta rama en el commit `c781faeec53ff4fcea3db609dc6b0486275a882e`: [run 38947799854](https://github.com/Kmena/Geops/actions/runs/38947799854), job `foundation` COMPLETED/SUCCESS y todos sus pasos PASS. T02 queda DONE en su alcance; véase [evidencia](implementation-evidence-T01-T05.md). El estado general de SPEC-01 no cambia.

## Corte de implementación T06–T18 — 2026-10-16

| Tarea | Estado | Prueba y condición que falta |
| --- | --- | --- |
| T06 | IMPLEMENTED / VERIFYING | P05 PASS_LOCAL; completar P08 y revisión de auth. |
| T07 | IMPLEMENTED / VERIFYING | Login/logout, CSRF y Origin probados; P06–P07 límites de tiempo/TLS pendientes. |
| T08 | IMPLEMENTED / VERIFYING | Recovery de un uso y sesiones revocadas; P09 expiración probada; control humano independiente pendiente. |
| T09 | IMPLEMENTED / VERIFYING | Migraciones y claim concurrente pasan; matriz de estados P11 pendiente. |
| T10 | IMPLEMENTED / VERIFYING | Firma/attestation inválidas rechazadas; verificador de attestation real ausente por diseño sintético. P10–P13 parcial. |
| T11 | IMPLEMENTED / VERIFYING | PoP concurrente y replay pasan; P14 límites temporales probados; P15 alteraciones completas pendientes. |
| T12 | IMPLEMENTED / VERIFYING | Rotación/revocación y restore posterior pasan; P16 carrera de rotación y reemplazo sintético probados; P17 reasignación completa y backup antiguo pendientes. |
| T13 | DONE_LOCAL | P18–P21 con fake/fetch simulado; cliente real deshabilitado. |
| T14 | IMPLEMENTED / VERIFYING | Cifrado y refresh single-flight pasan; P22/migración de diagnóstico pendientes. |
| T15 | IMPLEMENTED / VERIFYING | Auditoría y muestra de log sanitizada; test automático de redacción pendiente. |
| T16 | IMPLEMENTED / VERIFYING | Browser escritorio/móvil inspeccionado; accesibilidad completa P23 pendiente. |
| T17 | IMPLEMENTED / VERIFYING | Login, logout, inventario y estado fake en navegador; errores/red P24–P25 pendientes. |
| T18 | IN_PROGRESS | Restore sintético PASS_LOCAL; revisión de seguridad y gates Q2–Q5 pendientes. |

Ninguna prueba fake ni un DONE_LOCAL constituye aprobación operativa. Hay commit local de este corte; no hay push ni CI remoto nuevo. Se necesita autorización antes de publicar la rama.
## Corte de estabilización local — 2026-10-16, base 59e5e140

Esta tabla es el estado vigente de T06–T18. `DONE_LOCAL` acredita el alcance sintético local; `DONE` exigiría todos los criterios y revisiones. Los cortes anteriores quedan como historial.

| Tarea | Estado | Evidencia y criterio abierto |
| --- | --- | --- |
| T06 | IN_PROGRESS | Bootstrap único/Argon2id y P05 pasan; P08 redacción automatizada completa y revisión independiente pendientes. |
| T07 | IN_PROGRESS | P06/P07: límites idle 30 min y absoluto 8 h, aislamiento CSRF, Origin y flag Secure pasan localmente; TLS extremo a extremo y proxy operativo pendientes. |
| T08 | BLOCKED | Código expirado/usado rechazado y sesiones revocadas; dos custodios se registran, pero su autorización humana independiente no se verifica técnicamente. |
| T09 | IN_PROGRESS | Restricciones y claim concurrente pasan; matriz completa de estados y carreras P11 pendiente. |
| T10 | IN_PROGRESS | Invitación 256 bits, límite 10 min y rechazo de firma/attestation inválidas pasan; P12/P13 completo y attestation Android real pendientes. |
| T11 | IN_PROGRESS | Sesión 15 min, challenge 2 min y replay concurrente pasan; matriz completa de alteraciones P15 pendiente. |
| T12 | IN_PROGRESS | Rotación concurrente, clave vieja inválida y revocación pasan; reinstalación/reasignación P17 integral pendiente. |
| T13 | DONE_LOCAL | P18–P21 con fake y fetch simulado, cliente real deshabilitado. Free pendiente en SPEC-00. |
| T14 | IN_PROGRESS | AES-GCM y refresh single-flight pasan; P22 y revisión del diagnóstico heredado pendientes. |
| T15 | IN_PROGRESS | Respuestas 500 sanitizadas y escaneo Git pasan; prueba dinámica de redacción de logs en modo info pendiente. |
| T16 | IN_PROGRESS | Shell responsive inspeccionado antes; teclado/foco/accesibilidad P23 completos pendientes. |
| T17 | IN_PROGRESS | Sesión y vistas fake probadas antes; tráfico de navegador y errores 403/429 P24/P25 pendientes. |
| T18 | IN_PROGRESS | Restauración **anterior** a revocación reprodujo el riesgo y la cuarentena sintética lo mitigó localmente. Orquestación de API detenida, Q2–Q4 completos, CI remoto y revisión de seguridad independiente pendientes. |

Ninguna tarea pasó a `DONE` en este corte. La cuarentena es una medida de recuperación sintética de T18, no una puerta de producción. El mecanismo requiere que Operaciones garantice la indisponibilidad de la API para la base restaurada hasta finalizar la invalidación; esa garantía y doble control administrativo siguen bloqueando el cierre. Los ensayos M01–M10 Free y A01–A06 Android no se modificaron.

Adenda de P23–P25: el recorrido básico de teclado, caída y recuperación de red, y logout fallido/reintentado pasaron en navegador local. T16/T17 siguen `IN_PROGRESS` por lector/teclado completo, 403/429 y captura de tráfico.

Adenda P10/P11/P13: reemisión/cancelación, vínculo MDM duplicado, estado SUSPENDED y límite HTTP 429 pasaron en dos bases sintéticas aisladas. T09/T10 conservan `IN_PROGRESS` por el resto de P11–P13 y revisión independiente.

## Corte Security Recovery Hardening — 2026-10-16

Estado vigente de T06–T18 tras este corte; no se declara ninguna tarea nueva DONE. La época externa y el procedimiento de restore pertenecen a T18; la recuperación con dos aprobaciones técnicas pertenece a T08. Véanse [ADR-013](../architecture/adr/ADR-013-restore-security-epoch.md) y [evidencia](implementation-evidence-T06-T18.md).

| Tarea | Estado | Cambio y condición restante |
| --- | --- | --- |
| T06 | IN_PROGRESS | Bootstrap sintético sigue pasando; revisión independiente de auth pendiente. |
| T07 | IN_PROGRESS | Sesiones, CSRF/Origin y gate HTTP probados; TLS/proxy operativo pendiente. |
| T08 | BLOCKED | Se eliminó emisión con dos etiquetas; dos custodios sintéticos autentican aprobaciones, expiración, revocación y no autoaprobación. Alta/validación humana real y ceremonia por pérdida pendientes. |
| T09 | IN_PROGRESS | Restricciones DB y estado restaurado probados; matriz P11 integral pendiente. |
| T10 | IN_PROGRESS | Invitación/reutilización cubierta localmente; attestation real y P12/P13 integral pendientes. |
| T11 | IN_PROGRESS | PoP/sesión previos y cierre HTTP durante restore pasan; P15 integral pendiente. |
| T12 | IN_PROGRESS | Revocación y rotación previas; backup antiguo/reapertura ahora probados localmente, P17 y piloto pendientes. |
| T13 | DONE_LOCAL | Fake/mocks solamente; Free no validada. |
| T14 | IN_PROGRESS | Grants ficticios se invalidan en cuarentena; P22 y diagnóstico heredado pendientes. |
| T15 | IN_PROGRESS | Captura de log info sin marcador sintético aprobada; revisión independiente/observabilidad pendiente. |
| T16 | IN_PROGRESS | P23 accesibilidad integral pendiente. |
| T17 | IN_PROGRESS | P24/P25 red y UI integrales pendientes. |
| T18 | IN_PROGRESS | P04 backup pre/post revocación, gate externo, rollback/reintento y Compose pasan localmente; orquestación automática, Linux CI, seguridad independiente y recuperación humana pendientes. |

La migración 0007 añade la época de seguridad y 0008 registra aprobaciones separadas. El comando de migración fue corregido para respetar `GEOPS_TEST_DB`. SPEC-00 continúa BLOCKED; Wave 0A no se cierra.
## Restore Orchestration & Migration Safety — 2026-10-16

| Tarea | Estado vigente | Resultado de este corte / pendiente |
| --- | --- | --- |
| T06 | IN_PROGRESS | Sin cambio: P08 y revisión independiente pendientes. |
| T07 | IN_PROGRESS | SIGTERM ahora llama `app.close()` para drenar; TLS/proxy real y validación operativa del apagado pendientes. |
| T08 | BLOCKED | Doble control humano y ceremonia real pendientes; sin cambio. |
| T09 | IN_PROGRESS | Migrador exige destino explícito concordante y rechaza geops_dev sin autorización/gate cerrado; matriz P11 pendiente. |
| T10 | IN_PROGRESS | Attestation Android real y P12/P13 integrales pendientes. |
| T11 | IN_PROGRESS | P14 local; matriz P15 integral pendiente. |
| T12 | IN_PROGRESS | P16 local; P17 integral pendiente. |
| T13 | DONE_LOCAL | Fake/mocks; Free sigue pendiente. |
| T14 | IN_PROGRESS | P22 y revisión de diagnóstico pendientes. |
| T15 | IN_PROGRESS | Revisión de redacción independiente pendiente. |
| T16 | IN_PROGRESS | Accesibilidad integral pendiente. |
| T17 | IN_PROGRESS | Captura de tráfico/UI 403/429 pendientes. |
| T18 | IN_PROGRESS | Orquestador de restore sintético implementado; secuencia simulada, gate/cuarentena en PostgreSQL aislado y migrador aislado PASS_LOCAL. Restore Docker completo con API compartida detenida, CI Linux y revisión independiente pendientes. |

El perfil `maintenance` impide que Compose migre automáticamente al iniciar API. El cambio no cierra P04 ni Wave 0A. No se usaron datos, MDM ni dispositivos reales.
