# GEOPS MDM-R1 — Validación de Trial, Free y Staging

**Fecha:** 2026-10-21. **Rama/worktree:** `feature/mdm-manageengine-integration` en `C:\Users\kmena\Documents\proyectos\Geops-mdm-manageengine`. **SHA inicial:** `da96917f061bf72b943d1cdad2ed66b7438d3e59`. La rama R4-B y el worktree principal no se modificaron. Este reporte distingue evidencia de la cuenta, documentación del proveedor y pruebas sintéticas.

## Identificación y estado real

La captura de la consola aportada por el usuario muestra **Mobile Device Manager Plus MSP**, aviso **“Your Trial expires in 24 days”** y **“No device enrolled for management”**. El selector **Standard** está dentro de “Choose your Edition” y una cotización de 50 equipos: no acredita que Standard sea el plan activo ni que se hayan contratado 50. SHA-256 de la captura local aportada: `FE1550BF3F037F5AAA9EE462D251E7F2BC133868E518AA68CD14D7C3893FAE70`; la imagen no se copió al repositorio. La evidencia previa [SPEC-00](../specs/spec-00-technical-feasibility/mdm-free-api-validation.md) identificó **MSP Cloud Trial** en el dominio `.com`, cliente `DEFAULT_CUSTOMER` con ID numérico guardado fuera de Git y una lista vacía HTTP 200. La captura actual no muestra la URL ni el ID, por lo que la región actual queda **pendiente de reconfirmación** en la consola o por OAuth.

La documentación [MSP FAQ](https://www.manageengine.com/mobile-device-management-msp/faq.html) indica que el Trial dura 30 días y puede pasar a Free, conservando los equipos seleccionados hasta 25 y sin técnicos adicionales. La [página Free MSP](https://www.manageengine.com/mobile-device-management-msp/free-mobile-device-management-software.html) anuncia inscripción, inventario, perfiles y gestión para hasta 25 equipos. Esas páginas **no demuestran el derecho OAuth/API del tenant GEOPS después del Trial**. No se atribuye a esta cuenta una licencia de pago ni una función Trial-only sin evidencia.

| Capacidad | Trial actual | Free después del Trial | Clasificación Free / evidencia pendiente |
| --- | --- | --- | --- |
| OAuth de inventario | `PASS_REAL_API_EMPTY` **histórico**, no repetido en MDM-R1 | Sin prueba en Free | **UNKNOWN**; [OAuth MSP](https://www.manageengine.com/mobile-device-management-msp/api/oauth/) documenta el flujo, no la licencia efectiva de esta cuenta. |
| API `GET /api/v1/mdm/devices` | HTTP 200, `devices: []` histórico | Sin prueba en Free | **UNKNOWN**; repetir con la edición Free efectiva y `X-CUSTOMER`. |
| Inventario Android | Cero equipos según la captura | Función general anunciada | **UNKNOWN** para datos de Android y acceso por API en esta cuenta; sin teléfono inscrito. |
| Inscripción Android | Interfaz disponible, sin alta | Hasta 25 anunciados por proveedor | **FREE_CONFIRMED documental** para inscripción general; modo, Xiaomi y preservación de datos requieren prueba física. |
| Sincronización GEOPS | `PASS_SYNTHETIC`; no hay ejecución real | Depende de OAuth/API | **UNKNOWN**. |
| Gestión general de perfiles | No probada en la cuenta | Anunciada como funcionalidad Free | **FREE_CONFIRMED documental** para capacidad general; operación desde GEOPS Web no implementada ni validada. |
| Restricción global de ubicación | No probada | El nivel de administración, OEM y licencia efectivos no están probados | **UNKNOWN**. El descubrimiento de equipos no acredita políticas. |

No hay evidencia para marcar una función esencial como `TRIAL_ONLY` o `PAID_REQUIRED`; tampoco para afirmar que la API está confirmada en Free. Si después de la transición la API falla por licencia, el inventario y la sincronización GEOPS quedarán bloqueados y habrá que solicitar confirmación/cotización MSP o evaluar una alternativa aprobada, sin implementarla automáticamente.

## OAuth: estado y procedimiento de consentimiento

La configuración local histórica contiene nombres de variables para Client ID, Client Secret, región y cliente, **sin refresh token persistido**. Ningún valor se imprimió ni copió a Git. El worktree MDM no contenía archivos OAuth ni secretos de Staging al iniciar. Se reutiliza el diagnóstico existente con `state`, PKCE, `access_type=offline`, `prompt=consent`, scope único `MDMOnDemand.MDMInventory.READ`, POST de intercambio y callback local. El runtime de la API renueva en backend; [Zoho](https://www.zoho.com/developer/oauth/web-server-apps/overview.html) documenta este flujo y la revocación. El diagnóstico ahora puede guardar **una sola vez** el grant y credenciales en los tres archivos ignorados `infrastructure/compose/.local/staging/mdm/{mdm_client_id,mdm_client_secret,mdm_refresh_token}`. Nunca sobrescribe archivos existentes, no muestra tokens y no exporta el access token. El modo de exportación oculta el botón de revocación para evitar invalidar el grant recién guardado.

Con una consola privada en el equipo del usuario, el procedimiento para el **cliente Server-based existente** es:

```powershell
cd C:\Users\kmena\Documents\proyectos\Geops-mdm-manageengine
$env:GEOPS_MDM_LOCAL_CONFIG_PATH='C:\Users\kmena\Documents\proyectos\Geops\apps\api\.env.local'
$env:GEOPS_MDM_SAVE_REFRESH='1'
node apps/api/mdm-oauth-dev.mjs
```

Abrir `http://localhost:3500/` en el navegador habitual, pulsar **Autorizar lectura de inventario** y revisar que Zoho solicite únicamente `MDMOnDemand.MDMInventory.READ` para la cuenta MSP correcta. Tras aceptar, la página debe mostrar `connected_grant_saved`. El servidor escucha solo en `127.0.0.1`; no enviar el código, Client Secret ni tokens por chat, captura o comando. Detener el proceso local con Ctrl+C **sin revocar** el grant exportado. Si aparece `grant_export_failed`, comprobar permisos y archivos ya existentes; el diagnóstico intenta revocar el grant nuevo y no sobrescribe secretos. La [guía oficial MSP](https://www.manageengine.com/mobile-device-management-msp/api/oauth/) también permite un Self Client, pero crear otro cliente no es necesario aquí. En Windows, revisar la ACL de los archivos antes de transferirlos a un host; la API solo debe leerlos como secretos montados en el tenant de prueba. Si ya hubo un grant anterior que deba sustituirse, revocarlo y rotarlo de forma controlada antes de crear otros archivos.

El consentimiento requiere interacción del titular de Zoho. Hasta completarlo, **OAuth actual y API actual están BLOCKED**. El éxito histórico Trial no se convierte en prueba actual o Free.

## Pruebas y defectos

| Prueba | Estado | Evidencia |
| --- | --- | --- |
| API unitarias, OAuth y errores | **PASS_SYNTHETIC** | 46 pruebas API, incluidas dos del exportador de grant; renovación, 401/403/429, región, alcance y no exposición. |
| Web | **PASS_SYNTHETIC** | 42 pruebas, incluida sesión + CSRF para mutaciones MDM. |
| PostgreSQL de inventario | **PASS_SYNTHETIC** | PostGIS descartable `geops_verify_2026102105`: sync, deduplicación, vínculo único, desvínculo, rechazo sin sesión/CSRF, auditoría y conservación tras fallo parcial. |
| Compatibilidad estructural R4-B + MDM | **PASS_SYNTHETIC**, solo SQL | Otra base descartable `geops_verify_2026102106`: aplicación explícita 0001–0016, `0017` leído del worktree R4-B y `0018` del MDM; 18 registros y objetos `evaluated_at`, `mdm_inventory_device`, `mdm_sync_run` e índice único presentes. No se modificó R4-B. |
| Readiness del build MDM frente a esquema 18 íntegro | **BLOCKED** | El catálogo de este checkout contiene 17 archivos: 0001–0016 y 0018, **sin 0017**. `checkReadiness` devuelve `false` sobre la base 0017+0018, como debe hacerlo. No desplegar este checkout por separado. |
| API/Web build, typecheck, OpenAPI, Compose y secretos | **PASS_SYNTHETIC** | Build y typecheck de ambas apps, checker de contratos, `docker compose ... config --no-interpolate --quiet`, escaneo de 421 archivos elegibles y `git diff --check`. |
| Staging público, lectura sin credenciales | **PASS** de disponibilidad base; **BLOCKED** para MDM-R1 | HTTPS `/health/live` y `/health/ready`: 200; `/v1/admin/mdm/status`: 401 sin sesión; endpoint nuevo `/v1/admin/mdm/inventory`: 404. No se usaron credenciales ni se modificó el servicio. |
| Lint global | **FAIL** | El checkout base tiene 28 errores y 12 advertencias Biome en archivos no modificados por MDM-R1. Los dos archivos nuevos de exportación pasan Biome. No se formateó código ajeno para ocultar el fallo. |
| OAuth/API actual; dispositivo Android real | **BLOCKED** | Falta consentimiento/grant actual y hay cero dispositivos inscritos. No se hizo petición autenticada MDM-R1 ni prueba física. |

## Staging y compatibilidad R4-B

El Docker local no mostraba contenedores ni volúmenes `geops_spec02_stage_*`; había otros servicios compartidos que no se reiniciaron. Una comprobación pública de solo lectura confirmó que `https://geops-staging.duckdns.org/health/live` y `/health/ready` responden 200. El endpoint antiguo de estado MDM respondió 401 sin sesión y **el endpoint nuevo de inventario respondió 404**. Por ello existe un servicio GEOPS accesible, pero **MDM-R1 no está desplegado allí**. El worktree MDM no tiene `.env.staging`, secretos Docker ni refresh grant. La configuración Compose base tiene DB PostGIS persistente, volúmenes de respaldo y gate, redes internas, `geops-api` con health check y un overlay opt-in de salida TLS y secretos MDM. La sintaxis combinada pasa. No hay acceso al host ni evidencia de su estado interno de PostgreSQL, volúmenes, migraciones o imágenes.

La migración `0017` existe en la rama `codex/geops-integration`; `0018` solo en la rama MDM. La simulación SQL muestra compatibilidad de estructura cuando se aplican en ese orden, pero la imagen MDM actual no contiene 0017 y **no puede ser la imagen de migración aprobada**. No fusionar en MDM-R1. Antes de cualquier despliegue Staging: identificar el host/proyecto exacto y SHA, confirmar origen HTTPS y cliente de prueba, inventariar servicios/volúmenes/redes/puertos/health checks, verificar epoch y catálogo real, backup con checksum y restauración aislada, integrar formalmente ambas líneas en un checkout autorizado, repetir 0017→0018 y readiness, fijar tag inmutable y revisar el diff Compose. Solo entonces ejecutar migración bajo mantenimiento y reabrir con gates. Ninguna base persistente se modificó en MDM-R1; no hubo despliegue ni reinicio de servicios compartidos.

## Xiaomi Android: siguiente ensayo físico, sin cambios ahora

1. Registrar modelo, versión Android/parche, propiedad, apps y datos que deban preservarse, conectividad y modo de administración actual. Evitar IMEI y serial completos en evidencia.
2. Confirmar en consola MSP el cliente correcto, cupo, método de inscripción compatible y permisos; obtener autorización específica antes de instalar el agente o crear un Work Profile. No hacer factory reset, Device Owner, Fully Managed ni ADB por esta prueba.
3. Si se autoriza un modo no destructivo, documentar hora y resultado de inscripción en ManageEngine por separado de la lectura API. Identificar el equipo por coincidencia supervisada, no por un identificador aportado solo por la app GEOPS.
4. Con OAuth/API vigente, consultar el inventario, sincronizar GEOPS y verificar un único registro, estado y vínculo administrativo. Repetir tras reinicio y pérdida/reanudación de conectividad; una ausencia parcial no debe eliminarlo.
5. Probar políticas de ubicación/desinstalación únicamente en una fase autorizada posterior. La inscripción, la detección y el cumplimiento son tres evidencias distintas.

**Estado final:** `PASS_SYNTHETIC` para software y compatibilidad SQL; `PASS_REAL_API_EMPTY` solo histórico (SPEC-00); `BLOCKED` para API actual, Free efectivo, Staging y Android real. Próximo paso: completar el consentimiento OAuth de lectura en el diagnóstico local y registrar solo HTTP, conteo y esquema redactados. Repetir en Free cuando el Trial haya terminado.
