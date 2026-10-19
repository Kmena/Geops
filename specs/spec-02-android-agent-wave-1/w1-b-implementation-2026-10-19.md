# W1-B — implementación sintética y evidencia

**Corte:** 2026-10-19. Rama `codex/spec-02-wave-1`, HEAD inicial `d72cdb49d95915f8772ffcb6818698e4439c1a57`. Trabajo local sin commit, push, migración compartida, despliegue ni datos GPS reales. SPEC-00 y ADR-014 heredados se conservaron intactos. La PoC experimental no se modificó.

## Alcance implementado

- `0009_gps_policies.sql` añade siete capacidades sin concesión automática; políticas, revisiones y excepciones publicadas inmutables; grupos y membresía temporal; asignaciones de borrador y publicadas; proyección efectiva con exclusión GiST por dispositivo/rango `[)`; versiones de asignación; sesiones programadas y efectivas, eventos, posiciones PostGIS, anclas, cuarentena, estado de sincronización e idempotencia administrativa. Las FK compuestas ligan dispositivo, instalación, sesión y versión. No se crean tablas `poc_*`.
- El servicio TypeScript administra borradores, grupos, asignaciones, publicación, reanudación, pausa y revocación. Las operaciones requieren cookie de SPEC-01, Origin/CSRF, capacidades GPS vigentes, `Idempotency-Key` y `If-Match` aplicables. Se usa CAS con `version bigint`, lock del grafo política/grupo y locks de dispositivos; la exclusión SQL es la última barrera. Éxito y recibo idempotente se confirman juntos. Un cambio de ámbito exige `gps.policy.assign`, y el recibo conserva esa capacidad para comprobarla también en replay. Se auditan éxitos, 403 y 409 sin coordenadas.
- Las ventanas se generan en UTC desde horario IANA, día ISO local, cruce de medianoche, excepciones y reglas DST de ADR-017. La proyección calcula hasta siete días; la política futura no crea una ventana actual. La revocación incrementa `assignment_version`, supersede la proyección y cancela sesiones programadas futuras. No inventa STOPPED para sesiones efectivas: esa evidencia corresponde a Android/ingesta posterior.
- Las rutas admin son solo `/v1/admin/gps-policies` y `/v1/admin/gps-groups`. No se añadió ruta anónima ni escritura de política por dispositivo. El OpenAPI de diseño se copió a `packages/api-contracts/openapi.gps.design.yaml` y se valida contra SPEC-02 sin cambiar el contrato operativo de SPEC-01.

`draft_config jsonb` es el soporte mutable del borrador; el historial autorizado se normaliza en `gps_policy_revision`/`gps_policy_exception` al publicar. `device_id` y `group_id` son columnas FK mutuamente excluyentes para materializar el `scope_id` lógico aprobado. `additional_capabilities` del recibo evita que un replay de publicación con cambio de ámbito omita una capacidad revocada. Son decisiones físicas dentro de las entidades aprobadas; no amplían la API.

## Evidencia en base desechable

Contenedor local `postgis/postgis:18-3.6`, sin volumen y con `--rm`; única base de integración GPS `geops_verify_20261019`. El migrador validó `GEOPS_DATA_MODE=synthetic` y los tres nombres de destino antes de aplicar nueve migraciones. `npm run gps:integration --workspace @geops/api` exige por código `geops_verify_*` y reinicia solo sus fixtures sintéticos. Verifica HTTP admin, CSRF, capacidades, recibos y TTL 24 h, mismo key con cuerpo/ETag distinto, carreras CAS y de políticas distintas, rollback por solape directo/grupo, membresía, inmutabilidad, GiST, ventanas, DST, revocación y revisión futura. [Plan de pruebas](test-plan.md) conserva el criterio íntegro de P02/P03/P09.

La corrida final pasó **44 aserciones HTTP/SQL**. Se creó un dump `pg_dump -Fc` de esta base sintética y se restauró con `pg_restore` en `geops_verify_20261019_restore`, dentro del mismo contenedor desechable: nueve versiones migradas, cinco revisiones históricas, cinco filas de proyección histórica, restricción de exclusión GiST presente y PostGIS 3.6. El readiness de la base restaurada confirmó los checksums. La prueba de restore de SPEC-01 pasó en su simulador de gate/fallos. Este ensayo prueba recuperabilidad local del esquema y fixtures, no la política operativa de backups ni la cuarentena por época tras un restore real.

Los V01–V12 y tres controles adicionales pasaron (15/15) en el modelo de referencia W1-A, no en Kotlin. `npm run contracts:check`, typecheck/build API, lint y escaneo de secretos pasaron. Controles existentes de SPEC-01: regresión admin de sesión/CSRF/Origin/logs, bordes de identidad/PoP con base separada, pruebas unitarias foundation/MDM (12), MDM OAuth (18), destino de migración (2) y restore sintético de gate (1) pasaron. El escaneo inspeccionó 247 archivos elegibles sin hallazgos. No equivale a revisión de seguridad independiente.

## Gates y límites

| Tarea/gate | Estado | Falta para cierre formal |
| --- | --- | --- |
| T03 / P03 | Implementado y probado en PostgreSQL desechable | Revisión independiente de constraints/carreras antes de cierre formal. |
| T03 / P09 | Parcial | Purga a 90 días, backup/restore y retención de eventos/posiciones pertenecen a T10/E1; no hay política de backup aprobada. |
| T04 / P02–P03 | Núcleo admin implementado y probado en sintético | Revisión independiente; P02 completo incluye controles de lectura de ubicación/motivo de T10/E1, ausentes por diseño en B. |
| W1-B | `IMPLEMENTED_WITH_OPEN_GATES` | No se declara completa ni se activa seguimiento real. |

El horizonte de sesiones programadas se calcula durante cambios de política/grupo; el refresco periódico y GET PoP de snapshot pertenecen a T09/E1. Sin ellos, un agente no recibe políticas ni empieza captura. La concesión/revocación operativa de capacidades con doble control permanece como gate antes de uso real. Android/Kotlin, lectura sensible, retención, carga y piloto físico quedan fuera de W1-B. SPEC-00/01 mantienen sus estados previos; los cuatro bloqueos MDM son independientes.
