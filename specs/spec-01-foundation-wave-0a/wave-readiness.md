# Preparación de Wave 0A — decisión de entrada

**Estado SPEC-01: READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING (2026-10-16).** La autorización es para implementar Wave 0A con datos y dispositivos **exclusivamente sintéticos**. No constituye cierre de SPEC-00, aprobación operativa de identidad, validación ManageEngine Free, aprobación del piloto Android ni permiso para producción. T01–T05 tienen evidencia de cierre de su alcance fundacional, incluido CI remoto de T02; el estado de entrada se mantiene, sin declarar la wave completa.

## Decisiones y gates

| Gate | Decisión / evidencia | Estado | Límite |
| --- | --- | --- | --- |
| W0A-E1 | SPEC-01, contratos, tareas y pruebas trazadas. | PASS_DOCUMENTAL. | OpenAPI y código se validan en T03/P02. |
| W0A-E2 | ADR-012 y contrato de identidad revisados; ambigüedades PoP/attestation precisadas. | APPROVED_PROVISIONAL_FOR_SYNTHETIC_IMPLEMENTATION. | P10–P17 y revisión de seguridad de implementación pendientes; sin activación real. |
| W0A-E3 | MdmProvider fake/real desacoplado. | DESIGN_DECIDED. | En 0A solo fake y respuestas simuladas; ningún MDM real ni OAuth real. |
| W0A-E4 | Datos sintéticos autorizados; datos reales prohibidos. | APPROVED_SYNTHETIC_ONLY. | Sin empleados, clientes, teléfonos ni ubicaciones reales; privacidad/retención para uso real pendiente. |
| W0A-E5 | Responsables definidos por rol para Free y dos Android. | OWNER_ROLES_RECORDED / EXTERNAL_WINDOWS_PENDING. | Las pruebas externas no bloquean T01–T05; sí bloquean activación operativa y cierre SPEC-00. |

## Alcance autorizado

T01–T05 pueden iniciarse de forma independiente: npm workspaces, TypeScript/CI, contratos, esqueleto API/health, migraciones y Compose local con DB ficticia. No necesitan cuenta Free, teléfonos, OAuth ni credenciales MDM. Al ejecutar API/web, verificar que 3500/3501 siguen libres; la comprobación puntual previa no reserva puertos. No cargar apps/api/.env.local ni reutilizar secretos reales del diagnóstico OAuth; usar configuración de prueba ficticia aislada.

T06–T18 pueden implementarse posteriormente según [tasks.md](tasks.md), dependencias y pruebas, siempre en modo sintético. IdentityService debe fallar cerrado para activación operativa. MdmProvider real se diseña/probará con mocks, deshabilitado en ejecución de 0A; no se hacen solicitudes autenticadas al proveedor. T18 no cierra R03/R08 sin P10–P17 y revisión de seguridad de código.

## Prohibiciones expresas

- Cero datos reales de empleados, clientes, dispositivos o ubicaciones; cero teléfonos físicos en pruebas de 0A.
- Cero llamadas OAuth/API MDM reales o uso de credenciales reales.
- Cero cambios de perfiles/políticas, inscripción MDM o publicación de app.
- Cero despliegues a producción o afirmaciones de capacidad Free.
- Ningún resultado fake se registra como PASS de SPEC-00.

## Bloqueos heredados y waves destino

| Bloqueo | Estado actual | Resolución prevista |
| --- | --- | --- |
| M01–M10 ManageEngine Free | PENDING; PASS conocidos solo en Trial. | Wave 0B, Integrador MDM + QA; evidencia de cuenta Free y endpoints reales. |
| A01–A06 dos Android, Fully Managed, Keystore, entrega, pérdida/reasignación | PENDING. | Wave 0B/1, Android + Integrador MDM + QA de piloto. |
| Privacidad, aviso, retención, uso de datos reales | PENDING. | Antes de la primera wave con datos reales; Privacidad/Producto + Operaciones. |
| Activación operativa de identidad y método manual | PENDING. | Tras P10–P17, revisión de seguridad y piloto; ninguna activación real en 0A. |
| Despliegue y capacidad de 25 teléfonos | PENDING. | Wave 6 y validaciones VAL-08; producción prohibida ahora. |

**SPEC-00 permanece BLOCKED.** Roles asignados no significan ventanas acordadas ni resultados PASS. T01–T05 se trabajaron con fixtures y puertos comprobados antes del arranque; T02 cerró su gate remoto. El siguiente corte puede continuar T06–T18 con datos sintéticos; el subcaso de revocación de P04 se valida en T12/T18.

## Readiness tras T01–T05

El estado permanece **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING**. T01, T03 y T04 tienen evidencia local de cierre de su alcance; T05 cerró su alcance fundacional con P03 y pruebas de PostGIS/migración/restore; T02 tiene gate local y [CI remoto](https://github.com/Kmena/Geops/actions/runs/38947799854) verdes en el commit c781faeec53ff4fcea3db609dc6b0486275a882e. P04 completo sigue pendiente hasta T12/T18. Ninguno de estos resultados cierra Free, el piloto de dos Android, ADR-012 operativo, privacidad ni producción. [Evidencia sanitizada](implementation-evidence-T01-T05.md).

## Gate CI T02 — validado 2026-10-16

Los controles locales de T02 pasaron de nuevo desde el lockfile. GitHub Actions terminó COMPLETED/SUCCESS para `c781faeec53ff4fcea3db609dc6b0486275a882e`: [run 38947799854](https://github.com/Kmena/Geops/actions/runs/38947799854), job `foundation` y todos los pasos PASS. T02 queda DONE en su alcance. La autorización de desarrollo sintético y el estado `READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING` no cambian; SPEC-00 sigue BLOCKED.

## Corte T06–T18 — implementación sintética local

Se implementaron los fundamentos administrativos, identidad, MDM fake/read-only opt-in, consola y auditoría. [La evidencia T06–T18](implementation-evidence-T06-T18.md) registra 34 pruebas automatizadas locales, suites integradas en DB desechable, navegador y restore posterior a revocación. T13 cumple su alcance mock local; T06–T12 y T14–T17 requieren completar sus pruebas; T18 sigue IN_PROGRESS. El estado **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** se conserva para continuar el trabajo, no expresa cierre de Wave 0A.

**Puertas que impiden cerrar Wave 0A:** P06–P17, P22–P25 y Q2–Q4 incompletos; Q5 medido solo con `app.inject`; revisión de seguridad de implementación W0A-E2 aún pendiente. El verificador de attestation real falla cerrado y la excepción solo vale para binding fake en la simulación. Una restauración de copia anterior a revocación requiere reconciliación antes de reabrir API. El nuevo corte no tiene CI remoto porque no se publicó la rama.

**Puertas externas sin cambio:** SPEC-00 BLOCKED, M01–M10 Free pendientes, A01–A06 con dos Android pendientes, privacidad para datos reales y producción prohibida. Ningún resultado de `fake`, Trial previo o navegador local sustituye estas validaciones.
## Estado tras estabilización local — 2026-10-16, base 59e5e140

SPEC-01 conserva **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** como autorización de trabajo sintético, no como aceptación de Wave 0A. La revisión interna y las suites nuevas reducen incertidumbre, pero T06–T12/T14–T18 siguen `IN_PROGRESS` o `BLOCKED`; solo T13 está `DONE_LOCAL`. No hay nueva tarea `DONE` ni CI remoto de este corte.

Se reprodujo el riesgo de restaurar un backup anterior a la revocación y se probó una cuarentena que invalida todas las credenciales restauradas en una base sintética aislada. Para cerrar P04/T18 falta imponer que la API no pueda conectarse antes de terminar la cuarentena, probar la recuperación administrativa de doble control y ejecutar gates Q2–Q4 completos. La comprobación de conexiones del comando no reemplaza el aislamiento del servicio.

P07, P14 y P16 tienen PASS_LOCAL en sus subcasos sintéticos; otros casos P06–P17/P22–P25 conservan trabajo o validación pendiente en [la matriz](test-plan.md). Q5 mantiene solo la medición previa con `app.inject`; no hay medición de red nueva ni SLO operativo. La revisión independiente de seguridad W0A-E2, Free M01–M10, Android A01–A06, privacidad y producción siguen pendientes. La siguiente PoC GPS solo puede diseñarse como experimento aislado con trayectorias generadas y dispositivos simulados; no se inicia captura real con este estado.

La adenda de navegador local probó foco básico, error de red recuperable y logout fallido/reintentado; se corrigió el falso cierre visual ante API caída. P23–P25 siguen parciales por lector de pantalla, UI 403/429 y captura de tráfico browser. No cambia el estado de Wave 0A.

P10 alcanzó PASS_LOCAL para el contrato de invitación sintético: vencimiento, un uso, concurrencia y reemisión/cancelación. T10 sigue IN_PROGRESS por P12/P13 integrales, attestation Android y revisión de seguridad. No altera las puertas externas ni el estado de Wave 0A.

## Readiness tras Security Recovery Hardening — 2026-10-16

SPEC-01 permanece **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** únicamente para datos sintéticos; Wave 0A no está completa. ADR-013 fija un gate externo al backup y una secuencia de restore cerrada por defecto. P04 pasó localmente en copias pre y post revocación, fallos parciales, reinicio y reintento. P09 pasó en reglas técnicas de dos custodios sintéticos, pero T08 continúa BLOCKED para aprobación humana real. T18 continúa IN_PROGRESS por orquestación de parada/drenaje, Linux CI, revisión independiente y aceptación operativa. P12/attestation y matrices restantes tampoco se cierran. No se activan teléfonos, datos reales, OAuth MDM, GPS ni producción.

La API de Compose se ejecuta con época externa inicializada en un volumen GEOPS distinto de PostgreSQL; `geops_dev` está vacío de administradores/dispositivos. El nuevo gate falla cerrado si se pierde o difiere su archivo. Las pruebas de restore se hicieron en bases `geops_verify_*` eliminadas al terminar. M01–M10 Free, A01–A06 Android, privacidad y validación de dos personas reales conservan su estado pendiente. El CI remoto de este corte no se ejecutó por ausencia de push.
## Readiness tras Restore Orchestration & Migration Safety — 2026-10-16

SPEC-01 sigue **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** para datos sintéticos. El migrador ya no se dispara automáticamente con Compose y el restore exige dos fases: `prepare` deja el gate cerrado y `reopen` necesita evidencia y autorización exacta de destino/época. La suite simulada, la integración aislada de PostgreSQL y el rechazo de migración errónea pasaron localmente. T18 permanece IN_PROGRESS: no se ensayó el orquestador completo deteniendo la API de desarrollo, falta CI Linux/revisión independiente y varias puertas P06–P17/P22–P25. Wave 0A no está completa. SPEC-00 sigue BLOCKED; Free y dos Android reales pendientes. Sin autorización de producción ni de datos reales.

## Estado tras CI de consolidación — 2026-10-16

SPEC-01 conserva **READY_FOR_IMPLEMENTATION_WITH_EXTERNAL_VALIDATIONS_PENDING** y Wave 0A **IN_PROGRESS**. El commit de consolidación `544934df0d66f168dfa1f9228f9d601f42644861` está publicado en su rama; [GitHub Actions run 38967057446](https://github.com/Kmena/Geops/actions/runs/38967057446) finalizó `completed/success` para el job `foundation`, sin despliegue. Esto valida Q1/CI del código publicado. Q2–Q4 y la revisión independiente de seguridad siguen abiertos; el CI no ejecutó PostgreSQL ni el restore operativo. T18, P04, recuperación humana de T08/P09, matrices de identidad y accesibilidad/red pendientes no se cierran. SPEC-00 continúa BLOCKED; Free, dos Android físicos, privacidad y producción siguen sujetos a sus puertas externas.
