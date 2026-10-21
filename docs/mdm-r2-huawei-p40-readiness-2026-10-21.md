# GEOPS MDM-R2 — Preparación Huawei P40 y validación de inventario vacío

**Corte:** 2026-10-21. **Rama/worktree:** `feature/mdm-manageengine-integration` en `C:\Users\kmena\Documents\proyectos\Geops-mdm-manageengine`. **HEAD inicial:** `18d30f7ed5b1cf53b9d8ffad8e7a511ebdc1b55b`. Solo se modificó este worktree. El usuario aclaró que **Huawei P40 reemplaza al Xiaomi** como dispositivo de Fase B; no está disponible durante R2.

## Auditoría y límites

| Componente | Estado R2 | Evidencia |
| --- | --- | --- |
| Git y R4-B | IMPLEMENTED | Rama MDM limpia al inicio; `Geops-integration` en `65cc8befd3d22ecc7950f217accadb70763c22a6` con cambios sin confirmar. Ninguno se modificó. |
| ADR-012 e identidad | PARTIAL | `specs/architecture/adr/ADR-012-identidad-dispositivo.md`; `apps/api/src/device-identity/`. Claves y sesiones GEOPS son independientes del ID MDM; falta prueba física/attestation. |
| ADR-014 y SPEC-00 | BLOCKED | `specs/architecture/adr/ADR-014-mdm-flota-existente-propuesto.md`, `specs/spec-00-technical-feasibility/requirements.md`. La decisión de flota de 25 y MDM-001…006 no están aprobadas por evidencia física. El reset permitido del único equipo de prueba no cambia MDM-003 para la flota. |
| OAuth real y secretos | IMPLEMENTED | `apps/api/src/mdm/oauth-runtime.ts`, `provider.ts` y diagnóstico local: refresh backend, scope de inventario, reintento 401, rechazo de región/origen ajeno. Tres archivos de grant están en `infrastructure/compose/.local/staging/mdm/`, ignorados por Git; ACL local de carpeta/token: solo SYSTEM, Administradores y propietario con acceso. Sus valores no se inspeccionaron ni imprimieron. |
| ManageEngine MSP Trial | PARTIAL | Diagnóstico **repetido en R2**: OAuth HTTP 200; `GET /api/v1/mdm/devices?limit=1&offset=0` HTTP 200, `device_count=0`, `has_next_page=false`, `customer_header_sent=true`, `customer_name_verified_by_api=false`. `PASS_REAL_API_EMPTY`; no demuestra Free ni dispositivo. |
| Consola de inscripción | PARTIAL | Captura aportada: `DEFAULT_CUSTOMER`, Trial con 24 días indicados, Managed (0), Staged (0), Enrollment Pending (0), menús Android `QR Code Enrollment` y `Managed Google Play`. SHA-256 de la captura local: `72F81F069082646C89280CE2465B8A1908C59088AE31682992B8841ACEFDF6CB`; no se agregó a Git. Menú visible no acredita vínculo Google ni privilegio ADB. |
| GEOPS inventario y vínculo | IMPLEMENTED sintético | `apps/api/src/mdm/inventory.ts`, `routes.ts`, `0018_mdm_inventory.sql`, `apps/web/src/app.tsx`. Sólo observaciones explícitas actualizan filas; no se infieren bajas por ausencia. Vínculo administrativo único no concede identidad GEOPS. |
| Staging | BLOCKED | Sitio público: `/health/live` 200, `/health/ready` 200 y `/v1/admin/mdm/inventory` 404. No hay componente MDM expuesto ni prueba de backup/restauración del host real. |

## Android Enterprise y licencias

| Capacidad/ruta | Documentación oficial | Evidencia del tenant y decisión |
| --- | --- | --- |
| Fully Managed por QR/EMM | [MSP EMM token](https://www.manageengine.com/mobile-device-management-msp/help/enrollment/mdm_android_qr_code_enrollment.html) exige Android 6+, certificación Google y equipo nuevo/restablecido. | Menú QR visible; **sin prueba de elegibilidad del P40**. No generar ni escanear QR ahora. |
| Managed Google Play | [MSP configuración](https://www.manageengine.com/mobile-device-management-msp/help/android_for_work/mdm_afw_prerequisites.html) exige registrar la integración para apps/configuraciones administradas. | Menú visible, **vínculo no verificado**. No iniciar registro ni alterar cuenta Google de otro cliente. |
| Huawei P40 sin GMS | [Huawei P40](https://consumer.huawei.com/it/phones/p40/buy/) indica que la serie no incluye Google Mobile Services; [ManageEngine para Huawei/HarmonyOS](https://www.manageengine.com/mobile-device-management/how-to/enroll-harmony-devices.html) descarta alta Android Enterprise QR/zero-touch sin GMS y documenta ADB como alternativa. | **Ruta QR en setup bloqueada para P40 estándar sin GMS**; confirmar sistema, build, Play Store y Play Protect del equipo físico. No asumir que un QR dentro de la app después de ADB equivale a aprovisionamiento Android Enterprise. |
| ADB Device Owner | [MSP ADB](https://www.manageengine.com/mobile-device-management-msp/help/android_for_work/mdm_device_owner_provisioning_adb.html) incluye esta vía; la [guía Huawei](https://www.manageengine.com/mobile-device-management/how-to/enroll-harmony-devices.html) describe PC, USB, herramienta de aprovisionamiento y asignación posterior. | **Candidato condicionado** a compatibilidad del P40, disponibilidad de opción en consola MSP Trial/Free y prueba física. El documento Huawei es del producto MDM general; confirmar los mismos controles en este tenant MSP. |
| Equipo sin GMS | [ManageEngine](https://www.manageengine.com/uk/mobile-device-management/how-to/enroll-android-devices-without-google-play-services-support.html) documenta comunicación periódica ~60 min y ausencia de instalación silenciosa desde Play Store, E-FRP, Play Integrity y Play Protect. | El cambio `Communication Type=Periodic` es configuración de tenant: **no aplicarlo** sin comprobar alcance para otros clientes/dispositivos. La latencia puede afectar pruebas MDM, no cambia GPS de GEOPS. |
| Trial / Free MSP | [Free MSP](https://www.manageengine.com/mobile-device-management-msp/free-mobile-device-management-software.html) anuncia 25 equipos e inscripción/perfiles; la [FAQ MSP](https://www.manageengine.com/mobile-device-management-msp/faq.html) explica transición Trial→Free. | Trial confirmado visualmente; **Free efectivo, API OAuth en Free y ADB para P40 en Free siguen UNKNOWN** hasta repetir pruebas tras la transición. No se atribuye licencia Standard/Professional por el selector de cotización. |

MDM-001 (desinstalación), MDM-002 (ubicación en turno), MDM-003 (datos sin reset), MDM-004 (25 multimarca), MDM-005 (administración Web) y MDM-006 (privacidad) permanecen `BLOCKED` como criterios de aceptación físicos. Device Owner por ADB no prueba por sí mismo el bloqueo global de ubicación ni el comportamiento tras reinicio. La ruta Huawei contempla reset de **un** teléfono de prueba en Fase B, sujeto a intervención humana; no demuestra conservación de datos de la flota.

## Preparación de inscripción y políticas

**Estado remoto:** `NOT_CONFIGURED`. Esta ejecución no creó grupos, perfiles, plantillas, invitaciones, ni asociaciones en ManageEngine. Con cero equipos en el cliente visible, no se deduce que otros clientes MSP estén vacíos. No se modifica la configuración global `ME MDM App`/comunicación periódica.

**Borrador para el cliente de prueba, a materializar solo tras comprobar alcance:** crear un grupo exclusivo `GEOPS-MDM-R2-P40-LAB` sin autoasociaciones previas; asignación manual de un solo dispositivo; titular corporativo; perfil de observación sin restricciones, wipe, bloqueo, geotracking ni cambios de ubicación; conservar configuración de privacidad y avisos por defecto. Registrar ID del grupo/perfil y alcance en una bitácora redactada. No asociar al grupo `All Devices` ni a otros clientes. El perfil de ubicación se diseñará y probará aparte en Fase B con una única asignación explícita y evidencia de estado aplicado.

**Procedimiento de Fase B preparado, sin ejecutar:**

1. Identificar número de modelo, versión EMUI/HarmonyOS/Android, estado GMS/Play Protect, propiedad corporativa, cuenta vinculada y backup verificable del P40. Confirmar compatibilidad ADB/Device Owner con soporte MSP si la consola difiere de la guía.
2. Comprobar en `Enrollment > Android > Managed Google Play` el estado de vinculación sin registrar ni desvincular cuentas. En `QR Code Enrollment`, verificar solo que exista la opción; para P40 sin GMS **no iniciar el flujo QR de setup**.
3. Confirmar por separado que `Enrollment > Android > ME MDM App` admite comunicación periódica y cuál es su alcance en MSP; si afecta otros dispositivos/clientes, obtener tenant aislado o detener esa ruta.
4. Tras autorización operativa para el teléfono concreto, respaldar datos y restablecer **solo si el método elegido lo exige y el usuario lo ejecuta**. La [guía Huawei de ManageEngine](https://www.manageengine.com/mobile-device-management/how-to/enroll-harmony-devices.html) pide reset si ya estaba en uso para ese flujo; otra [guía MSP ADB](https://www.manageengine.com/mobile-device-management-msp/help/android_for_work/mdm_device_owner_provisioning_adb.html) plantea condiciones diferentes. Resolver esa discrepancia para el build real antes de actuar.
5. En un PC controlado, habilitar opciones de desarrollador/depuración USB, conectar el P40, obtener la herramienta Device Owner únicamente desde el enlace oficial vigente en la consola/guía, ejecutar el script oficial y verificar Device Owner. El QR posterior dentro de ME MDM App es para asociar al servidor, no prueba por sí solo Android Enterprise.
6. Asignar manualmente al grupo aislado, esperar check-in; verificar aparición en consola y API con `X-CUSTOMER` correcto, sync GEOPS y vínculo admin tras comprobación física de serie/identidad. Repetir sync y revisar que no aparecen duplicados.
7. Solo entonces diseñar/aplicar políticas de ubicación a ese dispositivo, verificar estado de despliegue y conducta real en horario laboral, reinicio y pérdida/reanudación de red. No extrapolar a Free ni a los 25 equipos.

## Implementación GEOPS y pruebas

Se incorporó **solo el archivo SQL confirmado** `0017_gps_continuity_evaluated_at.sql` desde el commit `691de3833a7a097a0f44770ddec1fb10fc89f331`; hash Git de blob `b8076d77470c9ce94766baf3cbd9158740f2c740`, idéntico al origen. No hubo merge, rebase ni cherry-pick. El catálogo MDM contiene ahora 0017 y 0018; la prueba PG aplica las 18 migraciones y exige `checkReadiness=true`. Esto resuelve la dependencia de catálogo local, **no** constituye permiso de aplicar migraciones en Staging.

La prueba `apps/api/test/mdm-inventory.integration.mjs` cubre sync completo vacío repetido e idempotente, retención del vínculo previo, deduplicación entre páginas, error temporal, baja explícita, dos clientes MSP con el mismo ID MDM y prohibición de vincular un GEOPS ya asociado a otro cliente. La base `geops_verify_*` fue descartable; el contenedor exclusivo se eliminó. `mdm_inventory_device` incluye `(provider,region,customer_id,mdm_device_id)` en su clave; el índice único de `geops_device_id` impide enlace cruzado. Los secretos OAuth no autentican un dispositivo GEOPS; permanecen las claves/sesiones propias de ADR-012.

| Puerta | Resultado | Evidencia |
| --- | --- | --- |
| OAuth y API tenant Trial, inventario vacío | `PASS_REAL_API_EMPTY` | Consulta R2 del diagnóstico local: HTTP 200, 0, sin página siguiente, `X-CUSTOMER` enviado; nombre de cliente no validado por API. |
| API unitarias/OAuth/seguridad de sesión | `PASS_SYNTHETIC` | `npm run test --workspace @geops/api`: 20 OAuth/export, 17 API/MDM, 2 cookie/CSRF, 7 GPS = 46. |
| Web | `PASS_SYNTHETIC` | `npm run test --workspace @geops/web`: 42. |
| PostgreSQL/PostGIS y migraciones | `PASS_SYNTHETIC` | `npm run mdm:integration --workspace @geops/api`: 0017→0018, readiness, sync vacío/dedupe/aislamiento; base y contenedor descartables. |
| Build, contratos, secretos | `PASS_SYNTHETIC` | `npm run build`, `npm run contracts:check` (OpenAPI 3.1), `npm run security:scan` (425 elegibles), `git diff --check`. |
| Compose/Caddy | `PASS_SYNTHETIC` | Validación sintáctica del overlay MDM, `npm run staging:check`, `npm run staging:caddy:check`. Se normalizó CRLF del script Caddy con el cambio confirmado en R4-B `65cc8be`, sin importar sus cambios pendientes. |
| Free efectivo, API con inscritos, vínculo real | `BLOCKED` | Trial vigente, cero equipos. |
| Servicio GEOPS MDM en Staging | `BLOCKED` | Health 200, inventario nuevo 404. Sin acceso verificable al host, inventario de servicios y backup restaurable; no se desplegó. |
| P40 inscrito y MDM-001…006 | `WAITING_REAL_DEVICE` | No hubo reset, ADB, QR, política ni prueba de teléfono. |

## Staging y próximo paso

`infrastructure/compose/compose.staging.yaml` define `geops-backup`, volumen `stage_backups`, `geops-migrate` bajo perfil `maintenance`, redes internas y secretos; el overlay `compose.staging.mdm.override.yaml` añade salida solo a la API. La existencia del YAML **no prueba** que el backup del Staging remoto exista o pueda restaurarse. El despliegue se mantiene bloqueado: falta identificar host/checkout/tag inmutable y el estado de migraciones remoto, comprobar backup con checksum y restauración aislada, revisar el diff Compose y el efecto de reiniciar la API compartida, y contar con ventana operativa. Tras esas puertas, aplicar 0017→0018 con gates de mantenimiento, validar readiness y status/inventario/sync en el servicio realmente desplegado. Hasta entonces no se declara `PASS_STAGING`; con inventario vacío tampoco puede demostrarse sincronización de un teléfono real.

**Fase B:** `WAITING_REAL_DEVICE`. Continuar con captura redactada de `Managed Google Play`, identificación del build P40 y alcance de comunicación periódica. Después, cuando el teléfono esté disponible, seguir el procedimiento anterior bajo intervención del usuario; repetir API y vinculación con evidencia y volver a validar Free tras acabar Trial. Ninguna modificación de GPS, horarios, autorizaciones offline, R4-B ni producción formó parte de R2.
