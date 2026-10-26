# SPEC-03 Wave 1 — cierre técnico local

> Registro histórico del worktree SPEC-03 original. En la copia de integración con MDM, `0022_client_geofences.sql` pasó a `0024_client_geofences.sql`; ver [informe de integración](mdm-integration-report.md).

**Fecha:** 2026-10-26. **Rama:** `codex/spec03-wave1` en `C:/Users/kmena/.codex/worktrees/geops-clients-routes-sdd/Geops`. **Base:** `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`. **Estado:** `IMPLEMENTED`, `TESTED` local, `TECHNICAL_PASS`; `DEPLOYED = NO` y `OPERATIONAL_PASS = NO`. No hubo commit, push, merge, publicación de imágenes ni despliegue.

## A. Implementación

Se crearon clientes con código único por tenant, dirección, estado y versión, con una sede inicial obligatoria que contiene las coordenadas; se admiten sedes adicionales. El listado filtra por código/nombre y estado. Cliente y sede se editan con ETag y se activan/desactivan sin borrar historial. Las geozonas son círculos con centro `geography(Point,4326)`, radio en metros, permanencia mínima en segundos, estado y revisiones inmutables. Cada guardado publica una nueva revisión. El mapa Web usa Leaflet y la fuente de teselas ya configurada para GPS; los mismos valores recuperados del servidor alimentan formulario y círculo.

La auditoría general registra creación, edición, cambios de estado y publicación de geozona con actor, tenant, identificadores y versión, sin copiar coordenadas al evento. La revisión almacena el motivo. El módulo no altera GPS v2, Android, OAuth, ManageEngine, `mdm_binding`, autenticación de dispositivos ni controlador de despliegue.

## B. Archivos de código

| Archivo | Propósito |
| --- | --- |
| `apps/api/src/db/migrations/0022_client_geofences.sql` | Esquema aditivo, PostGIS, integridad, permisos y revisiones inmutables. |
| `apps/api/src/client-catalog.ts` | Validación, tenant, permisos, transacciones, CRUD, ETag, paginación e idempotencia. |
| `apps/api/src/client-catalog-routes.ts` | Rutas administrativas y sesión/CSRF. |
| `apps/api/src/app.ts`, `main.ts` | Registro condicional y composición del servicio. |
| `apps/api/src/admin-auth/user-administration.ts` | Permite conceder explícitamente `visit.catalog.read/write`. |
| `apps/api/test/client-catalog.integration.mjs` | 57 comprobaciones sobre PostGIS descartable. |
| `apps/api/test/client-catalog-browser-server.mjs` | Servidor loopback, protegido por nombre de base desechable, solo para navegador local. |
| `apps/web/src/ClientCatalog.tsx`, `CatalogMap.tsx` | Listado, formularios, sedes, revisiones, mapa y estados. |
| `apps/web/src/api/client.ts`, `api/client.test.ts` | Transporte del catálogo y dos casos nuevos de contrato Web. |
| `apps/web/src/app.tsx`, `AdminUsers.tsx`, `styles.css` | Navegación, concesión de capacidades y presentación responsive. |
| `apps/web/test/client-catalog.e2e.js` | Flujo Playwright de escritorio y móvil con 15 aserciones. |
| `scripts/run-spec03-browser-e2e.ps1` | Prepara PostGIS sintético descartable, arranca API/Web en loopback, ejecuta Chrome y limpia recursos. |

La documentación de SPEC-03 se actualizó en `README.md`, `plan.md`, `api-contracts.md`, `traceability.md`, `risks.md` y este cierre. Las ADR-021–026 y el SDD original siguen sin commit en el worktree como trabajo preexistente de esta especificación.

## C. Base de datos

La migración `0022_client_geofences.sql` se aplicó y verificó exclusivamente en bases `geops_verify_*` dentro de un contenedor local `postgis/postgis:18-3.6` sin volúmenes. Crea `client`, `client_site`, `client_geofence_revision` y `client_catalog_idempotency`. La FK de cliente apunta al tenant operativo; FKs compuestas con tenant impiden cruces de sedes y geozonas. Las coordenadas se almacenan como `geography(Point,4326)`; un índice GiST cubre el centro de geozona y una consulta `ST_Distance` comprobó la lectura en metros. Una restricción y un trigger preservan límites e inmutabilidad. `admin_permission` es la única tabla compartida modificada por el esquema: su CHECK se amplía para las dos capacidades; no hay concesiones automáticas. `gps_data_tenant_access` se consulta sin alterarla.

La migración es aditiva; eliminar tablas no sería rollback seguro después de guardar historial. El rollback operativo consiste en retirar API/Web del catálogo y conservar los datos para corrección hacia adelante. La numeración y checksums deben reconciliarse con el frente MDM antes de integrar, porque allí existen migraciones hasta 0021. No se aplicó a staging ni a otra base persistente.

## D. API

Todas las rutas están bajo `/v1/admin`:

| Recurso | Operaciones | Permiso |
| --- | --- | --- |
| `/client-capabilities` | GET | Sesión; devuelve capacidades efectivas y límites. |
| `/clients`, `/clients/{id}` | GET listado/detalle, POST, PATCH | `visit.catalog.read/write` según método. |
| `/clients/{id}/deactivate` | POST | `visit.catalog.write`. |
| `/clients/{id}/sites`, `/clients/{id}/sites/{site_id}` | GET listado/detalle, POST, PATCH | `visit.catalog.read/write`. |
| `/clients/{id}/sites/{site_id}/geofences`, `/.../geofences/{revision}` | GET listado/revisión, POST revisión nueva | `visit.catalog.read/write`. |

Todas requieren además acceso al tenant operativo. El servidor deriva `tenant_id`; no acepta un tenant enviado en el cuerpo. Mutaciones requieren Origin, CSRF y `Idempotency-Key`; ediciones y nuevas revisiones requieren `If-Match`. Listas devuelven `{items,next_cursor}`, `limit` 1–100. Errores siguen la envoltura existente `{error:{code,message,request_id}}`. Los límites técnicos efectivos se configuran por `GEOPS_CATALOG_MAX_RADIUS_M` y `GEOPS_CATALOG_MAX_DWELL_S` y se exponen a Web. No hay endpoints públicos de escritura ni rutas de dispositivo para estas entidades.

## E. Web

`/clients` ofrece búsqueda, filtro y listado paginado; `/clients/{id}` muestra detalle, sedes, edición y activación. El formulario de geozona permite elegir centro mediante clic en Leaflet o campos de coordenadas operables por teclado, ajustar radio en metros y permanencia en minutos, cambiar estado, guardar y consultar revisiones. Se probaron el estado vacío de búsqueda, recarga de datos, ancho móvil y navegación Tab entre campos. Captura de verificación: `C:/Users/kmena/.codex/visualizations/2026/10/26/01a1789d-ff96-71e1-8b2d-5ac15c212e93/spec03-wave1-web-mobile.png`.

## F. Pruebas y regresiones

| Ejecución | Resultado |
| --- | --- |
| `client-catalog.integration.mjs` sobre base descartable nueva | 57 comprobaciones aprobadas; 0 fallidas. |
| `npm test` del repositorio, ejecución final | 85 pruebas aprobadas; 0 fallidas, 0 omitidas. |
| `npm run test --workspace @geops/web` final | 43 pruebas aprobadas, incluidas dos nuevas del catálogo; 0 fallidas, 0 omitidas. |
| `npm run gps:integration --workspace @geops/api` | 45 aserciones aprobadas. |
| `npm run gps:events:integration --workspace @geops/api` | 69 aserciones aprobadas. |
| `npm run device:enrollment:integration --workspace @geops/api` | PASS sintético; el script no publica recuento. |
| `npm run build` y typecheck API/Web | PASS. |
| Biome dirigido solo a SPEC-03 | PASS: 14 archivos de código con `biome check` y fixture E2E con `biome check --formatter-enabled=false`; 0 errores y 0 advertencias. El fixture debe conservar la expresión final sin punto y coma para `playwright-cli run-code`. Parser PowerShell PASS. |
| `scripts/run-spec03-browser-e2e.ps1` con CLI Playwright en caché | 15 comprobaciones aprobadas; 0 fallidas. Crea una base PostGIS nueva sin volumen y verifica Chrome a 1280 px y 390 px: login, búsqueda vacía, creación, clic en mapa, círculo, radio 200→250 m, permanencia 15 min, revisiones, recarga y desactivación. |
| Navegador local con datos sintéticos | Recorrido manual adicional y captura móvil; navegación Tab entre campos comprobada. |
| `npm run lint` global, ejecución previa | FAIL: 29 errores y 12 advertencias en archivos GPS/scripts preexistentes y sin modificaciones en esta rama. Se registra como deuda externa `TD-EXT-01` en `risks.md`; no se repitió por instrucción de limitar lint a SPEC-03. |

La suite E2E se ejecutó dos veces con éxito, incluida una ejecución desde cero mediante el comando único; solo requiere Docker, Chrome y el CLI Playwright 0.1.22 disponible en caché local. El script detiene sus procesos y elimina su contenedor descartable al terminar. No se ejecutó validación física en dispositivos.

## G. Regresiones

Las suites GPS de ingestión y eventos, enrolamiento de dispositivos, pruebas generales API/Web y compilación pasan sin cambios a los módulos GPS o MDM. El lint global conserva errores en archivos preexistentes de GPS y scripts, ajenos a Wave 1 y registrados como `TD-EXT-01`. No se observó otra regresión en las verificaciones ejecutadas.

## H. Estado Wave 1

**Wave 1 = `TECHNICAL_PASS` local; `DEPLOYED = NO`.** El CRUD, PostGIS, mapa, radio, permanencia, permisos, auditoría, migración desechable y pruebas E2E/regresiones ejecutadas satisfacen los criterios de aceptación. El radio y la permanencia usan límites técnicos configurables; los valores operativos siguen pendientes de calibración física. La deuda de lint global es externa a SPEC-03. Este resultado local no autoriza despliegue.

| Criterio de aceptación | Evidencia | Resultado |
| --- | --- | --- |
| 1. CRUD de clientes y geozonas de extremo a extremo | Integración: creación, lista, detalle, edición, estados y sedes; Chrome: creación, consulta, revisión de geozona y desactivación. No hay borrado físico por diseño. | PASS |
| 2. Persistencia de clientes | Integración consulta la fila creada; Chrome navega al detalle y recupera el cliente tras guardarlo. | PASS |
| 3. Círculos en PostGIS | Migración `geography(Point,4326)`, `ST_Distance` en metros, restricciones e historial inmutable probados en DB descartable. | PASS |
| 4. Crear y editar desde mapa | Chrome selecciona el centro con clic, publica revisión y edita radio en otra revisión. | PASS |
| 5. Radio representado | Chrome comprueba círculo Leaflet visible y radio persistido 200→250 m; el componente usa `L.circle` con radio en metros. | PASS |
| 6. Permanencia persistida | Chrome guarda 15 minutos y consulta 900 segundos; integración valida límites. | PASS |
| 7. Autenticación y permisos | Integración comprueba sesión, capacidad de lectura/escritura, tenant y CSRF; Chrome hace login real sobre fixture sintético. | PASS |
| 8. Auditoría | Integración verifica eventos de mutación; servicio escribe actor, tenant, entidad y revisión. | PASS |
| 9. Migración en DB descartable | El runner crea una DB PostGIS nueva sin volumen y aplica/verifica `0022` en cada ejecución. | PASS |
| 10. Pruebas automatizadas relevantes | 57 integración, 15 navegador, 85 suite general; build/typecheck y lint dirigido aprobados. | PASS |
| 11. Sin regresiones conocidas | Suites GPS/MDM/Web existentes aprobadas; `TD-EXT-01` documenta lint global anterior, fuera de archivos SPEC-03. | PASS |
| 12. Frentes GPS, MDM y despliegue intactos | `git status` y diff de la rama muestran solo API/Web de catálogo, permisos administrativos, pruebas y documentación; sin cambios de protocolo ni controlador. | PASS |

## I. Próximos pasos

Antes de Wave 2 hay que acordar la regla de sede sin geozona y la publicación de paradas. Antes de Waves 3–4 siguen pendientes la fuente de agente y vínculo temporal, la identidad de ingestión independiente de MDM y la calibración física de radios/precisión/cobertura. La integración deberá reconciliar migraciones y permisos con el frente MDM sin mezclar este worktree con sus cambios.
