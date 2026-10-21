# GEOPS — Integración aislada ManageEngine MDM

**Fecha:** 2026-10-21. **Rama:** `feature/mdm-manageengine-integration`. **Base:** `5339b811bc2b62274b669ab60ae055718216b6a7` (`codex/geops-integration`, integración Web + GPS R0–R4A). **Worktree:** `C:\Users\kmena\Documents\proyectos\Geops-mdm-manageengine`.

## Aislamiento y auditoría Git inicial

Al inicio, `C:\Users\kmena\Documents\proyectos\Geops` estaba en `codex/spec-02-wave-1`, adelantada dos commits respecto a `origin/codex/spec-02-wave-1`, con tres rutas sin seguimiento: `.codex-attachments/`, `docs/audit-continuidad-gps-2026-10-20.md` y `output/`. El worktree `Geops-integration` estaba en `5339b81` y contenía cambios sin confirmar de R4-B, incluidos `gps-continuity-*.ts` y la migración `0017_gps_continuity_evaluated_at.sql`. La nueva rama se creó desde el **commit**, no desde sus archivos sin confirmar. No se hizo merge, rebase, cherry-pick ni despliegue. Por ese solapamiento, la migración MDM se numeró `0018`.

## Auditoría inicial

| Componente | Estado al iniciar | Evidencia y decisión |
| --- | --- | --- |
| ADR-012, identidad GEOPS | IMPLEMENTED parcial | `specs/architecture/adr/ADR-012-identidad-dispositivo.md`, `apps/api/src/device-identity/{enrollment,session,repository}.ts`: claves y sesiones GEOPS independientes; el flujo real de inscripción sigue bloqueado. La asociación de inventario MDM nueva no toca estas credenciales. |
| ADR-014, decisión de flota | BLOCKED | `specs/architecture/adr/ADR-014-mdm-flota-existente-propuesto.md`: decisión de negocio pendiente, sin prueba física de políticas. |
| SPEC-00 y MDM-001…006 | BLOCKED | `specs/spec-00-technical-feasibility/requirements.md` y `mdm-business-decision.md`: capacidades Free, 25 modelos, alta sin reset y privacidad no demostradas. Descubrimiento no acredita políticas. |
| OAuth ManageEngine | PARTIAL | `apps/api/mdm-oauth-core.mjs` y `mdm-oauth-dev.mjs` autenticaban el Trial en herramienta local; el servidor `loadConfig` rechazaba OAuth. Se reutilizó `refreshAccess` y `revokeRefresh` para el runtime, con grant montado como secreto. |
| Adaptador MDM | MOCK / PARTIAL | `apps/api/src/mdm/provider.ts` tenía fake y lector real inyectable; `main.ts` siempre seleccionaba fake. El lector real descartaba atributos y esperaba detalle en `device`, aunque la documentación MSP muestra objeto directo. |
| Inventario y vínculo | MISSING / PARTIAL | `0003_device_identity.sql` define `mdm_binding` para inscripción y `0004_mdm.sql` define grants sintéticos; no había caché ni sincronización de inventario real. La migración `0018` incorpora un vínculo administrativo separado del binding de autenticación. |
| API y administración | PARTIAL | `apps/api/src/mdm/routes.ts` tenía status y GET live, con sesión admin, capacidad `gps.installation.manage` y acceso al tenant sintético. Se añadieron sync, caché y vínculo con el mismo control de sesión, Origin y CSRF. |
| Staging | PARTIAL / BLOCKED | `infrastructure/compose/compose.staging.yaml` usa API sintética y red interna; no monta OAuth ni salida MDM. El overlay opt-in agrega secretos y salida solo al API. No se desplegó. |
| Auditoría y secretos | PARTIAL | `apps/api/src/audit/index.ts` ofrece auditoría redactada; `config.ts` y `api-entrypoint.sh` cargan secretos de Docker. Se registran conteos/códigos, no tokens, payloads del proveedor, seriales ni identificadores de cliente en auditoría. |

## Arquitectura implementada

1. **Activación explícita:** `GEOPS_MDM_ENABLED=1` solo con origen HTTPS de Staging, cookie aislada, edición y región configuradas, ID numérico de cliente y confirmación `GEOPS_MDM_TEST_TENANT=1`. Sin overlay, la API sigue con fake. La edición configurada es una declaración operativa; el endpoint reporta `edition_evidence=UNVERIFIED` hasta documentar evidencia real.
2. **OAuth 2.0 backend:** grant offline MSP Cloud obtenido fuera del repositorio y montado como secreto Docker. `MdmOAuthRuntime` usa el intercambio de refresh existente, caché de access token con margen de expiración, renovación single-flight, alcance mínimo `MDMOnDemand.MDMInventory.READ`, reintento tras 401 y revocación administrativa. Solo TLS, origen Zoho derivado de una región permitida, sin tokens en respuestas o logs. Un refresh grant rotado inesperadamente falla cerrado para exigir reemplazo del secreto montado.
3. **Lectura oficial:** `ManageEngineReadOnly` consulta `GET /api/v1/mdm/devices` y detalle `GET /api/v1/mdm/devices/{id}` con `X-CUSTOMER`, sin seguir redirecciones. Conserva IDs largos como texto. Lee `paging.next` como datos, extrae `skip-token`/`offset` y siempre forma la siguiente petición en el origen permitido. Normaliza Android, estado, nombre, modelo, SO, serial y UDID. El código de estado `2` es enrolled y `4` unmanaged según [detalle oficial](https://www.manageengine.com/mobile-device-management/help/api/cloud/get-device-details.html); `is_removed` se trata como retirada explícita.
4. **Sincronización:** consulta páginas y detalles, reintenta 429 y errores temporales, limita páginas/registros, deduplica por ID, usa bloqueo PostgreSQL para evitar ejecuciones simultáneas y guarda resultado redactado. Solo actualiza dispositivos observados; la ausencia nunca borra ni desvincula. Registra `last_seen_at` para reconocer datos desactualizados. Corre manualmente o cada 15 minutos si el overlay real está activo.
5. **Asociación segura:** `mdm_inventory_device.geops_device_id` une un registro MDM de un único cliente configurado a un GEOPS existente, con restricciones únicas y auditoría. No altera `mdm_binding`, `device_key`, `device_session` ni la activación. El administrador debe verificar físicamente la correspondencia antes de usar el enlace; el ID MDM, serial o UDID no autentican al agente.
6. **Consola Web:** la vista Integración MDM presenta estado de conexión, edición configurada frente a evidencia, inventario Android persistido, sincronización manual y asociación/desvinculación con confirmación física. En móvil, cada registro se muestra como tarjeta. El navegador solo usa la sesión administrativa y CSRF; OAuth permanece en la API.

## Contratos nuevos

La especificación versionada está en `specs/spec-mdm-manageengine/openapi.yaml`. Todos los endpoints requieren sesión admin con capacidad `gps.installation.manage` y acceso vigente al tenant operativo; las mutaciones exigen Origin y CSRF.

| Ruta | Acción |
| --- | --- |
| `GET /v1/admin/mdm/status` | Estado redactado; `connected` solo tras lectura exitosa. |
| `GET /v1/admin/mdm/devices?cursor=&limit=` | Página en vivo del proveedor. |
| `GET /v1/admin/mdm/inventory?after=&limit=` | Caché Android del cliente configurado, con `last_seen_at`. |
| `POST /v1/admin/mdm/sync` | Sincronización completa bajo bloqueo; devuelve `run_id` y conteo. |
| `PUT /v1/admin/devices/{device_id}/mdm-link` | Asociación única; body `{ "mdm_device_id": "…" }`. |
| `DELETE /v1/admin/devices/{device_id}/mdm-link` | Desvinculación administrativa auditada. |
| `POST /v1/admin/mdm/disconnect` | Limpia access token y solicita revocación remota; exige retirar/rotar el secreto montado antes de reiniciar. |

## Validación y límites

| Puerta | Estado | Evidencia |
| --- | --- | --- |
| OAuth diagnóstico Trial anterior | PASS_REAL_API histórico, **no repetido** | `specs/spec-00-technical-feasibility/mdm-free-api-validation.md`: OAuth y lista vacía HTTP 200 en MSP Cloud Trial; no demuestra edición actual ni teléfonos. |
| Unitarias OAuth/proveedor/seguridad | PASS_SYNTHETIC | `npm test --workspace @geops/api`: 18 OAuth, 17 API/fundación/MDM, 2 cookie/CSRF y 7 GPS preexistentes. |
| Integración PostgreSQL | PASS_SYNTHETIC | `npm run mdm:integration --workspace @geops/api` contra base `geops_verify_2026102104` en PostGIS desechable: migración, sync, deduplicación, vínculo único, auditoría, rechazo sin sesión/CSRF y conservación tras fallo parcial. |
| Consola Web | PASS_SYNTHETIC | `npm run typecheck --workspace @geops/web`, `npm test --workspace @geops/web` (42 pruebas), revisión visual local a 1440 px y 390 px con respuestas de red simuladas. Las capturas no son evidencia de API real ni Staging. |
| Typecheck, build, OpenAPI, imagen | PASS_SYNTHETIC | `npm run typecheck --workspace @geops/api`, `npm run build --workspace @geops/api`, `npm run check --workspace @geops/api-contracts`, `docker build -f infrastructure/docker/api.Dockerfile …`. |
| Sintaxis overlay Compose | PASS_SYNTHETIC | `docker compose -f infrastructure/compose/compose.staging.yaml -f infrastructure/compose/compose.staging.mdm.override.yaml config --no-interpolate --quiet`. |
| Seguridad y formato | PASS_SYNTHETIC | `npm run security:scan` (424 archivos elegibles), Biome en archivos modificados y `git diff --check`. |
| API real actual | BLOCKED | El archivo privado `apps/api/.env.local` del worktree principal contiene nombres de variables de cliente OAuth, región y cliente, pero **no** un refresh grant; sus valores no se copiaron ni se imprimieron. No hay grant de prueba, edición actual confirmada ni Android de laboratorio accesibles en este worktree. No se hizo petición autenticada al tenant actual. |
| Servicio Staging MDM desplegado | BLOCKED | No se aplicó migración ni imagen a Staging; no hay prueba HTTP del servicio MDM activo allí. |
| Teléfono Android real / políticas MDM | BLOCKED | No existe evidencia física de inscripción, estado aplicado o MDM-001…006. |

## Preparación y prueba futura de Staging

1. Confirmar por consola la **edición realmente contratada**, región, cliente MSP, licencia/API y que el tenant y teléfonos usados son exclusivamente de prueba. No copiar datos ni grants de producción.
2. Registrar cliente OAuth con scope `MDMOnDemand.MDMInventory.READ`. Obtener un refresh grant offline mediante el flujo OAuth oficial. Guardar `mdm_client_id`, `mdm_client_secret` y `mdm_refresh_token` como archivos individuales bajo `infrastructure/compose/.local/staging/mdm/`, con acceso limitado al grupo de secretos de Staging. Ningún valor va a Git.
3. Preparar variables `GEOPS_MDM_REGION`, `GEOPS_MDM_EDITION`, `GEOPS_MDM_CUSTOMER_ID`, `GEOPS_MDM_TEST_TENANT=1`; comprobar que región y cliente coinciden con la consola. El overlay `compose.staging.mdm.override.yaml` es opt-in. Revisar conectividad saliente TLS de `stage_egress` y el origen de Staging antes de usarlo.
4. En una ventana de Staging autorizada, aplicar migración `0018`, construir/desplegar la imagen aislada, iniciar sesión admin y consultar status, página live, sincronizar y revisar caché/auditoría. Repetir con dos Android de laboratorio inscritos, una página posterior, baja explícita y 401/403/429. Registrar únicamente HTTP, conteos, tiempos, edición y referencias de evidencia redactadas.
5. Mantener `PASS_STAGING` bloqueado hasta comprobar autenticación real, lista de inscritos y sync persistida en el servicio desplegado. `PASS_REAL_DEVICE` requiere evidencia física de teléfono Android inscrito; las políticas MDM-001…006 exigen pruebas independientes.

## Riesgos y futura integración

- El cliente MSP se identifica por un ID configurado por operador. Su nombre↔ID y la edición Free todavía deben validarse con la cuenta real; el Trial anterior no se traslada.
- La API puede entregar respuestas de paginación distintas a las simuladas. Una página fallida conserva registros previos y marca el run como fallido; no se hacen bajas por inferencia.
- El refresh grant está montado como secreto y se mantiene en memoria; una revocación requiere retirar o rotar ese archivo antes del próximo reinicio. Un cambio de región/cliente exige nueva autorización OAuth.
- `0018` deja `0017` a R4-B. Antes de integrar a la rama principal, revisar conflictos en `main.ts`, `app.ts`, Compose y contratos, ejecutar migraciones 0017→0018 en réplica sintética, repetir pruebas, revisar seguridad y privacidad y confirmar edición/API/Android reales. El merge y cualquier despliegue requieren autorización separada.
