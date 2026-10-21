# Ejecución de integración y SPEC-02 — 2026-10-21

## Alcance y procedencia

La rama aislada `codex/geops-spec02-mdm-integration` partió del commit
`8b04a2f9fdc09c6ded15b6eef3b6aae054c95e4e` de
`codex/geops-mdm-security`. Git confirmó que `26efc9a` de
`codex/spec-02-wave-1` y `26c109f` de `codex/gps-resilience` son ancestros
de esa base. No se ejecutó un merge redundante. Los worktrees originales y
sus cambios locales permanecen intactos.

Se trasladaron al checkout aislado los documentos SPEC-02/ADR-020 y auditorías
locales aún no registrados del worktree de SPEC-02. Al resolver el conflicto
documental de OpenAPI, se conservó el contrato MDM de la base y se añadió el
contrato GPS v2 de forma aditiva. `npm run contracts:check` pasó después de la
resolución. La migración 0020 conserva 0017–0019 y agrega solo el recibo v2.

## Matriz requisito → implementación → prueba → evidencia → estado

| Requisito | Implementación | Prueba / evidencia local | Estado de implementación |
| --- | --- | --- | --- |
| Integración de ramas sin pérdida de commits | Ancestría Git; rama aislada; contratos MDM preservados | `git merge-base --is-ancestor` para ambos HEAD; MDM integración y seguridad pasaron en bases desechables; revisión independiente de `da8a651` | IMPLEMENTED; CI final pendiente |
| P0: eliminar compuerta global por STARTED | `BatchSync.kt` agrupa por `client_session_id`; `PendingUpload.kt` da prioridad al lote mixto | `syntheticTest` pasa, incluidos dos casos nuevos de sesiones y prioridad v2 | IMPLEMENTED; POCO pendiente |
| P0: STARTED y posiciones atómicos | `/v2/device/gps/batches`, `ingestMixed`, recibo 0020 | `gps:mixed:integration`: 47 aserciones, incluido rollback por fallo SQL e idempotencia concurrente; revisión independiente de `da8a651` | IMPLEMENTED; POCO y CI pendientes |
| P0: compatibilidad v1 y buffer v1 | Ruta v1 y recibos originales intactos; reconciliación v1→v2 | `gps:events:integration`: 69 aserciones; v1 pendiente→v2→ACK duplicado y sesiones acumuladas fuera de orden en las 47 de v2 | IMPLEMENTED; pruebas físicas pendientes |
| P0: autenticación, autorización y aislamiento | Bearer, PoP, instalación y alcance existentes para v2; cuerpo firmado sin query | HTTP sin credenciales 401, `device_id` ajeno 403, mezcla de sesiones 422; revisión estática independiente favorable | IMPLEMENTED; CI y prueba física pendientes |
| Wave A: última política válida offline, ADR-020 | Documentación incorporada; motor vigente aún usa ancla de la instancia online y límite de 12 h | Pruebas Kotlin actuales verifican el comportamiento antiguo ADR-017 | MISSING; bloqueado por gate P0 |
| Wave B: GPS autónomo y compatibilidad Huawei | Servicio actual GPS_PROVIDER, sin permisos/arranque autónomo completos | Sin ensayo físico POCO/P40 | MISSING; bloqueado por gate P0 |
| Wave C: capacidad cifrada de 32 MiB / 4.320 posiciones | Persistencia cifrada existente con límite anterior de 4 MiB / 10.000 registros | Pruebas AES-GCM y reinicio sintético; sin capacidad nueva demostrada | PARTIAL; bloqueado por gate P0 |
| Wave D: sincronización independiente y drenaje | Cola cifrada y job existentes; P0 incorpora lotes por sesión y ACK exacto | Kotlin y HTTP sintéticos; sin drenaje físico 30 min | PARTIAL; bloqueado por gate P0 |
| Wave E: piloto POCO y P40 | Plan documental | Sin acceso a los dispositivos en este checkout | BLOCKED |

## Verificaciones ejecutadas

- `npm run typecheck`: PASS.
- `npm test`: PASS.
- `npm run build`: PASS (API, Web y contratos).
- `npm run contracts:check`: PASS.
- `npm run security:scan`: PASS (454 archivos inspeccionados).
- `npm run gps:events:integration`: PASS (69 aserciones, PostGIS desechable).
- `npm run gps:mixed:integration`: PASS (47 aserciones, PostGIS desechable),
  con negativos de edad, ancla, ventana, digest, instalación, binding revocado
  y rollback SQL; sesión histórica no solapada y rechazo de solape.
- `npm run maintenance:recovery:integration`: PASS (54 comprobaciones de 14→20,
  PostGIS desechable).
- `gradle syntheticTest` en contenedor Android local: PASS. Compiló y ejecutó
  los casos Kotlin, incluidos P0.
- `mdm:integration` y `mdm:security:integration`: PASS en bases desechables
  independientes con la migración 0020 presente.
- `npx biome check` de los cinco archivos TypeScript modificados: PASS.
- `npm run lint` global: FAIL local (31 errores, 12 advertencias), igual que
  la línea base inicial de este checkout; incluye formato CRLF de archivos
  no modificados y hallazgos anteriores. Los cinco archivos TypeScript P0
  modificados pasan Biome individualmente.
- `git diff --check`: PASS.

Estas pruebas cubren el commit `da8a65172f108545805b8a06fad65d70eb45e9f3`
en el checkout aislado. No sustituyen CI ni pruebas físicas.

## Revisión independiente

Un revisor independiente examinó el SHA exacto
`da8a65172f108545805b8a06fad65d70eb45e9f3` en modo solo lectura.
Aprobó la revisión estática de P0 en alcance sintético, sin hallazgo crítico o
alto determinista restante. Confirmó la migración 0020 aditiva, la preservación
de módulos MDM y migraciones 0017–0019, las correcciones de backoff y validación
temporal, y el trigger de CI. No repitió las pruebas de integración y su dictamen
no concede PASS al gate completo.

Hallazgo MEDIO residual: `PendingUpload.kt` puede programar espera cero si una
posición nueva vence mientras el `STARTED` de su sesión aún está en backoff.
Puede provocar reintentos del job sin HTTP prematuro; no se observó impacto en
integridad o autorización. Registrar optimización en la siguiente iteración.

CI sobre el SHA integrado sigue NOT_VERIFIED y `npm run lint` global falla en
el checkout local por 31 errores y 12 advertencias presentes en la base.

## Gates y decisiones

| Resultado solicitado | Estado al corte | Motivo |
| --- | --- | --- |
| BRANCH_INTEGRATION | NOT_VERIFIED | Ancestría, build y revisión estática independiente verificados; falta CI final |
| SPEC02_P0_UPLOAD | BLOCKED | Implementación sintética y revisión estática verificadas; faltan CI y POCO |
| SPEC02_WAVE_A_POLICY | BLOCKED | ADR-020 aprobado documentalmente, sin implementación |
| SPEC02_WAVE_B_GPS | BLOCKED | Faltan permisos, motor autónomo y ensayo físico |
| SPEC02_WAVE_C_STORAGE | BLOCKED | Faltan capacidad/retención nuevas y pruebas de falla |
| SPEC02_WAVE_D_SYNC | BLOCKED | P0 parcial integrado; falta gate P0 y prueba de drenaje |
| SPEC02_WAVE_E_PHYSICAL | BLOCKED | POCO/P40 no ejecutados |
| MDM_SECURITY | NOT_VERIFIED | Controles preservados y revisados estáticamente; falta CI final |
| ANDROID_COMPATIBILITY | NOT_VERIFIED | Solo JVM sintético, sin dispositivos físicos |
| API_CONTRACT_COMPATIBILITY | NOT_VERIFIED | OpenAPI local PASS y revisión estática favorable; falta CI |
| POSTGIS_MIGRATIONS | NOT_VERIFIED | Ensayo 14→20 PASS; faltan matrices de restore y CI final |
| INDEPENDENT_AUDIT | PASS | Revisión estática P0 del SHA `da8a651`; alcance sintético y hallazgo MEDIO residual, sin aprobación operativa |
| SPEC02_TECHNICAL_CLOSURE | BLOCKED | Waves A–D aún incompletas |
| SPEC02_OPERATIONAL_CLOSURE | BLOCKED | Wave E física pendiente |
| STAGING_READINESS | BLOCKED | Gates técnicos y operativos abiertos |
| PRODUCTION_AUTHORIZATION | BLOCKED | No se solicita despliegue ni autorización de producción |

Se compiló y verificó firma de un [APK debug P0](poco-p0-manual-2026-10-21.md)
con SHA-256
`18BA39B4AB71741F2079DC79514615C8F82994C62DC707BE87A9433C7F76F136`.
No se instaló: su firma no coincide con la del APK anterior en el repositorio
y no debe sustituirse una instalación existente perdiendo la cola cifrada.
No se generaron imágenes de API/Web ni se publicó la rama. No se modificó
ManageEngine, Staging, producción ni la vigencia de autorización offline.
El próximo paso dependiente es resolver el método seguro de instalación,
resolver el gate de CI y obtener evidencia física; entonces se podrá abrir
Wave A conforme al orden exigido por la SPEC.
