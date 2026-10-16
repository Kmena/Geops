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
