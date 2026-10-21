# Revisión de baseline, integración y prueba de no ampliación

**Corte de lectura:** 20/10/2026. `c27f656c71a82eee31e2bf281bb98eaf473be067` continúa siendo HEAD local y remoto de `codex/spec-02-wave-1`; el checkout principal contiene modificaciones sin confirmar. Este documento describe un estado mutable, no certifica que el frontend haya terminado. El worktree de resiliencia está ahora en la rama `codex/gps-resilience` desde ese SHA y solo contiene documentación sin confirmar.

## Diff y propiedad de cambios

| Grupo observado en checkout principal | Delta frente a `c27f656` | Dependencia del SPEC / tratamiento |
| --- | --- | --- |
| Android agente: `GeopsLocationService`, `PolicyEngine`, `TrackingController`, `AgentStore`, `BatchSync`, `DeviceTransport`, pruebas sintéticas | Diagnósticos de política, `LocationDecision`, contadores de captura/ACK, detalles de sync y estado cifrado acotado a identidad. Siguen `START_NOT_STICKY` y `stopAndUnregister()`→`stopSelf()`. | C07–C09/C08 **dependen** de este delta para describir la UI actual. C01–C05 siguen abiertos. No copiarlos a ciegas: revisar cambios atómicos y pruebas con su propietario. |
| APK: `AgentRuntime`, `EnrollmentActivity`, Gradle | Diagnóstico local y mensajes; callback/sync visibles. Scheduler aún en `object` de proceso, sin worker independiente. | La observabilidad de R1 puede aprovecharse tras integrar; R2/R3 no están resueltos. El SPEC no presupone que estos archivos existan en su HEAD. |
| API: `gps-administration.ts` y test | `GET /v1/admin/gps-devices` agrega `display_label` e `identity_state` para evitar UUID como nombre. | Pertenece al flujo Web activo. No editar esta ruta durante resiliencia sin coordinación. No constituye alerta ni diagnóstico nuevo. |
| Contratos: dos copias `openapi.gps.design.yaml` | Describe campos opcionales del listado de dispositivos. | Reservar propiedad al trabajo Web actual; `GPS-CONTINUITY-001` debe añadirse después, en cambio independiente, con paridad de ambas copias si siguen vigentes. |
| Web: `GpsLiveWorkspace`, `GpsPolicyEditor`, CSS, `load`, `remote`, package/lock | Refactor de vistas; untracked `GpsDeviceWorkspace`, `GpsMap`, modelos/tests de tracking; documentos y capturas de auditoría UI. | Zona exclusiva de la otra conversación. No mover, stagear ni sobrescribir. Sus tipos y adaptadores actuales son referencia de compatibilidad, no contrato aprobado. |
| Infraestructura: `infrastructure/nginx/geops-staging-web.conf` | Modificación local del checkout principal, todavía sin confirmar. | Fuera de propiedad de resiliencia. No copiar ni alterar. |
| Auditoría de continuidad | Documento sin seguimiento en checkout principal; copia idéntica por SHA-256 en este worktree. | Entrada de C01–C09. Sus referencias de línea sobre Android local no prueban presencia en HEAD. |
| Ignorados relevantes | Builds/dist y cachés Gradle permanecen en checkout principal; no se trasladaron. No se detectaron `.env` comunes en el chequeo dirigido previo. | No copiar APK, keystore, dumps, capturas, cachés ni credenciales al worktree. Repetir inventario antes de cualquier futura integración. |

## Compatibilidad con frontend en curso

El `GpsDeviceWorkspace.tsx` **sin seguimiento** usa `GpsRemote.capabilities()` → `devices()` y, para el dispositivo seleccionado, `sessions()`, `health()` y `positions()`. `RemoteHealth` admite solo `source: DEVICE_OBSERVATION | SERVER_INFERENCE`; la vista muestra `state`, fuente, `observed_at` y última recepción. `GpsRemote.get()` acepta objetos JSON, pero el tipo y la presentación no contemplan una tercera fuente ni nuevos estados como prueba de captura. El listado ya espera opcionalmente `display_label`/`identity_state`, que provienen del cambio API sin confirmar.

Consecuencias para `GPS-CONTINUITY-001`:

1. Endpoint de dispositivo y lectura administrativa **nuevos**, sin añadir claves al lote estricto `GPS-HEALTH-001` ni alterar el significado de `ONLINE`, `NO_COMMUNICATION` o `source` en la ruta de salud existente. Cambiar esos enums silenciosamente etiquetaría mal datos en Web.
2. `GET /v1/admin/gps-alerts` está en OpenAPI de diseño pero no registrado en API; no describirlo como disponible. Nuevo lector Web debe ser optativo, con estados de carga/403/404/429 y fallback al estado actual.
3. Proponer lectura de resumen de continuidad con `gps.session.read`, concesión tenant y `X-GEOPS-Access-Reason`, como salud existente; diagnóstico profundo puede requerir `gps.audit.read`. Seguridad debe aprobar el límite antes de fijar OpenAPI. Nunca incluir coordenadas, tokens, QR, identificadores personales ni datos del buffer en la respuesta.
4. El frontend no recibe trabajo en este worktree. La propuesta de ruta/forma se entrega al responsable Web para revisión cuando estabilice su branch/diff; adaptar UI en un cambio separado y probar con API vieja/nueva. Los 401/403 de autorización no deben convertirse en “endpoint no disponible”.

## Prueba de que una actualización no amplía indebidamente captura

Sea `W(d,r)` el conjunto de instancias UTC **publicadas** para dispositivo `d` y revisión/asignación `r`, recortadas por vigencia. Para cada nueva posición con tiempo de fix `t`, se exige:

`ALLOW(d,t,r) = identidad+instalación vigentes ∧ snapshot autenticado r ∧ ancla del mismo boot válida ∧ instancia W(d,r) ya vigente al contacto online ∧ t∈W(d,r) ∧ t<offline_not_after ∧ sesión efectiva r ∧ permiso/proveedor/FGS activos`.

El chequeo debe hacerse **al registrar el listener y de nuevo por cada callback**. La frontera es `[start_at,end_at)`; tolerancias de reloj/red no extienden `W`. El backend cruza versión, ancla, sesión y ventana al ingerir; el ACK nunca convierte un rechazo en captura autorizada.

Al observar una revisión nueva `r2`, primero se invalida la generación de captura `r1` y se desregistra su listener; luego se valida `r2` y solo si `ALLOW` es verdadero se crea nueva sesión/listener. Callbacks en vuelo de `r1` conservan generación vieja y se rechazan. Si `r2` amplía legítimamente el horario, ese tramo solo puede abrirse después de descargar/verificar `r2`; un snapshot viejo nunca lo anticipa. Si `r2` reduce horario, no puede quedar captura del listener antiguo tras conocer `r2`. Fallo entre pasos deja GPS detenido, no en estado mixto.

**GPS-OFFLINE-001 APPROVED:** un teléfono desconectado no conoce inmediatamente una reducción nueva. Se acepta que use la última política autenticada y vigente conocida localmente hasta el fin de **la instancia actual validada online**/`offline_not_after` de ADR-017, sin extensión automática. Una nueva instancia necesita contacto online. Debe transmitir después las posiciones legítimamente capturadas bajo esa revisión. Al observar una revisión nueva, aplica las restricciones inmediatamente. MDM no comunica cambios a un teléfono sin conectividad. La revocación de identidad no recibe excepción.

**Brecha de cliente identificada:** `gps-device-config.ts:89–109` puede entregar una instancia futura cuyo `offline_not_after` llega hasta su fin, y `PolicyEngine.kt:56–72` no comprueba que la instancia seleccionada estuviera vigente al contacto online. Eso puede preactivarla offline, contrario a ADR-017. `gps-policy-service.ts:662` cancela sesiones `SCHEDULED` futuras y `gps-event-service.ts:198–205` las rechaza; bajo ADR-017 ese rechazo es correcto si nunca hubo revalidación online. Para una instancia ya iniciada antes de la publicación, `start_at < cambio` y esa cancelación no la alcanza; la aceptación de sus eventos históricos parece posible, pero R-P18 debe probarla. No se cambia ninguna regla backend en R0.

Vectores obligatorios: ampliación, reducción, revocación, revisión repetida/downgrade, carrera entre callback y transición, versión nueva con ventana futura, borde exacto de fin, medianoche/DST, offline durante cambio, reboot/ancla inválida y respuesta API 409/422. En cada vector comparar tiempos aceptados contra `W(d,r)` y contra el instante en que `r2` fue observado; cero posiciones fuera de la autorización conocida y ningún ACK indebido.

## Estrategia Git sin pérdida

1. Mantener la rama `codex/gps-resilience` en su worktree y R0 documental; no stagear ni limpiar el checkout principal. Registrar SHA y `git status` antes de integrar.
2. El responsable frontend conserva sus cambios en el checkout principal y, **cuando esté autorizado**, los fija en commits propios por Web/API/contrato. No copiar un snapshot parcial mientras sigue editando. Preservar untracked explícitos; excluir capturas y outputs.
3. Identificar el propietario de los cambios Android sin confirmar; revisarlos y fijarlos en commits separados cuando exista autorización. Este SPEC depende de algunos, pero no los absorbe implícitamente. La auditoría copiada queda como documento de entrada con su baseline señalado.
4. La rama `codex/gps-resilience` ya existe desde `c27f656`. Una vez que ambos conjuntos tengan commits trazables, incorporar únicamente commits necesarios mediante merge/cherry-pick revisado o un nuevo punto de integración acordado. No rebasear ni resetear el checkout del frontend. Los conflictos de API/OpenAPI se resuelven con comparación de contrato y pruebas, nunca `ours/theirs` ciego.
5. Separar cambios de resiliencia Android de los nuevos contratos/API. Pedir revisión de la otra conversación antes de editar `apps/web`, `gps-administration.ts`, `packages/api-contracts` o el OpenAPI de SPEC-02. Ejecutar diff/checks y pruebas en worktree separado; no publicar hasta autorización.

No se enviaron mensajes a la otra conversación: la coordinación requiere que el usuario la indique o que ambos responsables compartan una propuesta de contrato fuera de este checkout.
