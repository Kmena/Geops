# Contratos API propuestos — SPEC-03

**Estado:** esta tabla KMZ sigue como diseño para W2–W6; ninguno de sus endpoints está implementado. W1-A dispone de la API de catálogo indicada abajo, con evidencia en [w1-a-evidence.md](w1-a-evidence.md). Base futura /v1/admin/kmz-imports; JSON y UTC salvo upload binario. Reutilizar sesión admin, cookie HttpOnly, CSRF de [admin-auth/routes.ts](../../apps/api/src/admin-auth/routes.ts), request_id y errores saneados. GET requiere catalog.import.read; upload/PATCH/rematch/cancel requieren catalog.import.write; validate/confirm requieren catalog.import.confirm y lectura del plan. Ninguna capacidad se concede por ser administrador o tener permisos GPS. Para los futuros endpoints KMZ, toda mutación exige Idempotency-Key y X-CSRF-Token; las revisiones exigen If-Match.

| Método y recurso | Propósito | Respuesta |
| --- | --- | --- |
| POST /v1/admin/kmz-imports | Carga binaria KMZ en streaming, hash y sesión; Content-Type application/vnd.google-earth.kmz o application/zip validado por contenido. | 202, import_id, state, sha256, expires_at, status_url |
| GET /v1/admin/kmz-imports | Lista paginada de sesiones autorizadas. | 200, items, next_cursor |
| GET /v1/admin/kmz-imports/{id} | Estado, contadores, hash, versión, expiración. | 200, ETag |
| GET /v1/admin/kmz-imports/{id}/records | Filtros state/group/week/warning/action/search, cursor, limit ≤ 100. | 200, filas y next_cursor |
| GET /v1/admin/kmz-imports/{id}/records/{recordId} | Original, propuesta, candidatos, señales, decisión y geometría segura. | 200, ETag |
| PATCH /v1/admin/kmz-imports/{id}/records/{recordId} | Corrección y decisión explícita; motivo y target_version para LINK/UPDATE. | 200, nueva fila/ETag, invalidación del plan |
| POST /v1/admin/kmz-imports/{id}/bulk-decisions | Aplicar una acción a IDs explícitos tras previsualización de conteos; operación atómica dentro de staging. | 200, resultado por fila y session_version |
| POST /v1/admin/kmz-imports/{id}/rematch | Recomparar con catálogo vigente; no altera decisiones aceptadas sin marcar conflictos. | 202/200, versión y resultados |
| POST /v1/admin/kmz-imports/{id}/validate | Construir plan/digest y bloqueos; requiere capacidad de confirmación. | 200, plan y ETag |
| POST /v1/admin/kmz-imports/{id}/confirm | Confirmar plan validado con digest, ETag, clave idempotente y motivo. | 200 si completó; 202 solo si se aprobó publicación atómica asíncrona |
| GET /v1/admin/kmz-imports/{id}/result | Ledger y resumen, incluso tras timeout de confirmación. | 200 o 202 mientras procesa |
| POST /v1/admin/kmz-imports/{id}/cancel | Cancelar sesión no aplicada; no deshace COMPLETED. | 200 |

## DTO principales

ImportRecord: record_id, import_id, source_path, source_kind (CLIENT_POINT, WEEKLY_STOP, TERRITORY_GROUP, GEO_FEATURE, BRANCH_POINT, ROUTE_LINE, OTHER), parent_path, original {name, code, description, geometry}, normalized {name, code, point}, proposed {name, code, point, group_id, route_draft_id}, classification, warnings[], candidates[], decision, revision. Geometría KML se representa en WGS84; no se devuelve XML activo. Candidatos: target_id, target_version, signals[] {rule_id, matcher_version, field, value_summary, distance_m}, score solo informativo.

Decision: action (CREATE_ESTABLISHMENT, LINK_AUTHORIZED_CUSTOMER, UPDATE_SELECTED_FIELDS, EXCLUDE, LINK_GROUP, CREATE_GROUP, DRAFT_ROUTE), target_id opcional, target_version opcional, selected_fields[], proposed_values, reason. CREATE_ESTABLISHMENT produce candidato geográfico, no customer comercial. LINK_AUTHORIZED_CUSTOMER requiere customer del CSV/XLSX autorizado o vínculo manual explícito, target_version y motivo; ausencia del catálogo bloquea identidad automática. UPDATE_SELECTED_FIELDS requiere target_id, target_version, campos permitidos y motivo; un campo ausente en KMZ no se envía como null ni se borra. Un cliente candidato y una parada semanal tienen decisiones separadas. DRAFT_ROUTE solo admite paradas enlazadas a cliente/pin confirmados; carecer de calendario, recurrencia o vigencia impide activarla, y el nombre de carpeta no asigna dispositivo.

ValidationPlan: plan_digest, session_version, catalog_revision, matcher_version, counts por action y entity_type (candidato geográfico, vínculo comercial autorizado, actualización selectiva, grupo, borrador, exclusión), blocking_issues[] {record_id, code, detail}, warnings[], expires_at. Polígonos y línea no figuran como operación publicable. ConfirmRequest: plan_digest, reason; If-Match es el ETag del plan. ConfirmResult: import_id, commit_id, committed_at, counts, operations[] {record_id, action, target_id, outcome}, audit_correlation_id.

## Semántica de errores y límites

400 INVALID_KMZ o BAD_REQUEST; 401/403 autenticación/capacidad; 404 sin revelar importación ajena; 409 REBASE_REQUIRED, STALE_ETAG, IDEMPOTENCY_CONFLICT, STATE_CONFLICT; 410 IMPORT_EXPIRED; 413 FILE_TOO_LARGE o EXPANSION_LIMIT; 422 INVALID_RECORD, UNRESOLVED_CONFLICT o COMMERCIAL_SOURCE_REQUIRED; 429 cuota; 503 fallo temporal. Un error de parser no muestra rutas internas, XML crudo ni datos sensibles. [D-05](decisions.md#d-05--cuotas-de-carga) contiene límites iniciales para pruebas, aún no validados para producción. Upload y listas no se someten al bodyLimit JSON general de 64 KiB de [app.ts](../../apps/api/src/app.ts); el streaming debe tener límites propios y no aumentar globalmente esa cuota. TTL temporal propuesto de D-06: 30 días; confirm en EXPIRED devuelve 410.

If-Match y Idempotency-Key siguen el patrón de [gps-policy-routes.ts](../../apps/api/src/gps-policy-routes.ts). Un mismo key+request digest devuelve la respuesta persistida; key reutilizada con payload distinto falla. GET result permite recuperación tras timeout. Paginación opaca y orden estable por source_path/record_id. Ninguna ruta de lectura entrega el archivo original sin autorización y decisión explícita sobre retención/descarga.

## Dependencias de catálogo W1

W1-A implementa GET /v1/admin/catalog/revision y GET/POST de sources, customers, establishments, pins, groups y routes; GET/PATCH/DELETE por ID; GET/POST/DELETE de vínculos de establecimiento con cliente; GET/POST/DELETE de miembros de grupo; GET/POST/PATCH/DELETE de paradas de ruta. Los listados principales y las paradas tienen cursor UUID, orden por ID y límite máximo 100. GET exige catalog.import.read; las mutaciones exigen catalog.import.write, sesión admin, Origin/CSRF, motivo y, para edición, borrado o asociación, If-Match. Las respuestas de recurso incluyen ETag y version. Los detalles completos de rutas están en [w1-a-evidence.md](w1-a-evidence.md).

W1-A no implementa búsqueda comercial por namespace, proximidad ni endpoints CSV/XLSX. El cliente creado por API siempre es CANDIDATE; no existe POST de customer desde KMZ ni mecanismo API para convertirlo en VERIFIED. La fuente se crea PENDING; la identidad VERIFIED exige una futura fuente CSV/XLSX autorizada y un contrato de W1-B. El catálogo incrementa catalog_revision en cada escritura mediante triggers. El contrato público comercial queda PENDING_VALIDATION hasta recibir esquema y autorización D-01.

**Corrección W1-A-R:** nuevas asociaciones a fuentes, establecimientos, clientes, pins o rutas archivadas se rechazan con 422; ETag obsoleto o dependencia activa devuelve 409. Una denegación de escritura 403/409 se audita después del rollback, usando request_id para evitar duplicación del mismo intento. Si audit_event no puede persistir un rechazo obligatorio, el servicio devuelve 503 y no muta el catálogo. Los vínculos cliente–establecimiento guardan actor, ambos IDs, fechas y motivos en eventos transaccionales de creación/desvinculación. [Evidencia](w1-a-r-evidence.md).

La migración 0019 amplió el CHECK de admin_permission y las allowlists de gestión de usuarios para catalog.import.read/write/confirm, preservando denegación por defecto, grants auditados y revocación. La autenticación sola no equivale a permiso.
