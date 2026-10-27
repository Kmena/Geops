# SPEC-03 — Cierre técnico de ajustes posteriores a B30

## Estado Git y alcance

- Base: revisión B30 desplegada `2f89b87f1f636feb7e21d7e09af03959ee95f68d`.
- Worktree aislado: `C:/Users/kmena/.codex/worktrees/spec03-post-b30-adjustments/Geops`.
- Rama: `codex/spec03-post-b30-adjustments`.
- Migraciones 0001–0030, Android, protocolo GPS, MDM, controlador y artefactos B30 permanecen intactos.
- No hubo acceso ni cambios en staging o producción, publicación GHCR, push ni merge.

## Identidad y responsabilidad

La migración 0031 añade `agent_operational_identity` para fijar un agente a un dispositivo GEOPS autorizado. Recupera vínculos B30 activos sin borrar sus filas. `agent_responsibility` conserva la persona a cargo mediante intervalos temporales sin solapamiento, actor, fecha y motivo. Un cambio cierra el intervalo anterior y crea otro; la base impide borrar o reescribir historial. Las asignaciones siguen usando `agent_id`, las posiciones siguen atribuyéndose por vínculo y `captured_at`, y MDM permanece opcional.

La interfaz permite seleccionar un dispositivo existente, registrar el agente, ver detalles GEOPS/MDM y última comunicación, asignar o cambiar responsable y consultar historial. Los agentes B30 no conciliados se muestran como legado; la conciliación exige intervención administrativa. No se generan dispositivos ficticios.

## Búsqueda geográfica

El formulario de cliente/sede tiene búsqueda explícita, resultados múltiples, selección que completa coordenadas, dirección sugerida que se aplica solo con botón, mapa Leaflet con clic y arrastre de marcador, y radio visible. La escritura manual de dirección y coordenadas permanece disponible cuando la búsqueda falla. Una dirección de cliente ya escrita no se sobrescribe.

El endpoint GEOPS fija `https://nominatim.openstreetmap.org/search` y no acepta URL del cliente. La llamada se produce solo con Buscar. El administrador ve un aviso previo y la atribución OpenStreetMap. Hay autenticación, `visit.catalog.read`, tenant operativo, validación de longitud/caracteres, límite global de más de un segundo entre consultas, límite por administrador de 20/minuto, timeout de cinco segundos, tope de 128 KB incluso con respuesta fragmentada, máximo de cinco resultados, caché de 24 horas indexada por hash y errores sanitizados. Las pruebas usan proveedor simulado. La función puede desactivarse con `GEOPS_GEOCODING_DISABLED=YES`.

## API

- `POST /v1/admin/agent-devices`: registro atómico e idempotente desde dispositivo existente; permisos `visit.device.write` y `visit.schedule.write`.
- `GET /v1/admin/agents/:agentId/identity` y `/responsibilities`: detalle e historial; `visit.device.read`.
- `POST /v1/admin/agents/:agentId/responsibilities`: cambio temporal auditado e idempotente; `visit.device.write`.
- `POST /v1/admin/agent-device-links` admite `establish_identity:true` para conciliación; vínculos anteriores conservan su comportamiento salvo que una identidad estable ya impide reasignación conflictiva.
- `GET /v1/admin/geocoding/search?q=...`: búsqueda protegida y limitada.

## Migraciones

- Instalación desde cero: 31 migraciones aplicadas en PostgreSQL/PostGIS descartable.
- Actualización real de esquema B30 con vínculo activo: solo 0031 aplicada; vínculo preservado y fijado como identidad; reintento sin duplicados; 31 checksums iguales a las fuentes. Siete verificaciones aprobadas.
- No se aplicó migración alguna en una base persistente.

## Validación local

| Prueba | Resultado |
| --- | --- |
| Typecheck API/Web/contratos | PASS |
| Build API/Web/contratos | PASS |
| `npm test` (API, Web, contratos, migración, restauración) | PASS; 130 controles |
| Cliente y geozona PostGIS | PASS; 57 controles |
| Rutas PostGIS | PASS; 76 controles |
| Calendario PostGIS | PASS; 70 controles |
| Motor de visitas PostGIS | PASS; 40 controles |
| Vínculo agente–dispositivo/GPS PostGIS | PASS; 53 controles |
| Identidad y responsabilidad post-B30 PostGIS | PASS; 15 controles |
| Geocodificación con proveedor simulado PostGIS | PASS; 14 controles |
| Upgrade B30→0031 PostGIS | PASS; 7 controles |
| Chrome escritorio/móvil, cinco flujos | PASS; 88 controles: clientes 15, post-B30 15, rutas 14, calendario 23, cumplimiento 21 |
| GPS dirigido sobre la fixture descartable | PASS; 143 aserciones: política 48, salud 37, operaciones 58 |
| Lint dirigido | PASS; Biome `check` de 18 archivos de código/pruebas backend y `lint` de 4 E2E |

## Riesgos y límites

- Nominatim público tiene cuota y disponibilidad externas. El uso de mayor volumen requerirá otro proveedor o instancia administrada y una decisión operativa. El texto de búsqueda se envía a ese servicio tras acción expresa, según autorización del usuario.
- La migración no asocia automáticamente agentes B30 que carecen de vínculo activo. Requieren conciliación administrativa; no se inventan identidades.
- Los permisos `visit.device.read/write` y `visit.schedule.write` se conceden por administración autorizada; no se alteraron roles de staging.
- No hay validación física nueva de GPS ni calibración de permanencia.

## Estado

`SPEC03_POST_B30_TECHNICAL_PASS`. La evidencia corresponde exclusivamente al worktree y PostgreSQL/PostGIS descartable; la prueba de geocodificación usó un proveedor simulado. `STAGING_VERSION = B30`; `PRODUCTION_CHANGED = NO`; `SPEC03_OPERATIONAL_PASS = NO`. La integración, publicación y promoción de 0031 requieren un procedimiento posterior y autorización independiente.
