# Tasks — backlog implementable de Wave 0A

**Estado:** T01/T03/T04/T05 implementadas y verificadas en su alcance fundacional; T02 espera ejecución de CI remoto. P04 completo conserva pendiente el caso de revocación de T09/T12. Evidencia: [implementation-evidence-T01-T05.md](implementation-evidence-T01-T05.md). Las referencias Pnn apuntan a [test-plan.md](test-plan.md). Un cierre exige evidencia real de implementación, no solo el texto de esta tabla. Una tarea puede ser paralela solo si sus dependencias terminan y no modifica los mismos archivos.

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
| T02 | IMPLEMENTED / CI_PENDING | Lint y typecheck locales PASS; workflow creado; ejecución remota pendiente de publicar esta rama con autorización. |
| T03 | DONE | OpenAPI 3.1 validado contra SPEC-01 y 4 vectores sintéticos PASS; controladores pertenecen a T10–T12. |
| T04 | DONE | 4 pruebas Fastify PASS; API sobrevive caída DB y ready 503/200 cumple P03. |
| T05 | DONE | Compose, P03 y la porción fundacional de P04 (PostGIS, migración, checksum, persistencia y restore ficticio) PASS. El subcaso de revocación de P04 pertenece a T12/T18. |

Ninguna tarea posterior T06–T18 se inició. T02 no se marca DONE hasta ejecutar CI remoto. P04 completo no se marca PASS hasta T12/T18: exigir ese subcaso para cerrar T05 crearía una dependencia circular T05→T06→T12→T05. El estado general de Wave 0A no es COMPLETE.

## Validación CI de T02 — preparación de publicación

El 2026-10-16 se repitió P01 desde `npm ci --ignore-scripts --offline=false`: 136 paquetes, lint, typecheck, build, 26 pruebas y OpenAPI sin error. El workflow de rama `codex/spec-01-wave-0a` está revisado. T02 continúa `IMPLEMENTED / CI_PENDING` hasta que GitHub Actions termine en verde; ningún resultado local sustituye el job remoto. Véase [evidencia](implementation-evidence-T01-T05.md).
