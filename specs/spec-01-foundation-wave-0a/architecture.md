# Arquitectura propuesta para Wave 0A

## Componentes y límites

~~~text
React admin (3501) ── HTTPS/cookie admin ──> Fastify API (3500) ──> PostgreSQL/PostGIS
                                                │
                                                ├─ IdentityService / sesiones PoP
                                                ├─ MdmProvider (Fake | ManageEngineReadOnly)
                                                └─ OAuth server-side / almacén cifrado de grant
Android posterior ── HTTPS/PoP ────────────────> API de identidad
~~~

El backend se organiza por módulos config, db, admin-auth, device-identity, mdm, inventory, audit y health. Los controladores no llaman directamente a ManageEngine. MdmProvider expone listDevices(customerId, cursor, limit), getDevice(customerId, mdmId), integrationStatus() y errores normalizados; no incluye métodos de escritura en 0A. El cliente real, deshabilitado durante 0A y probado solo con mocks, acepta únicamente dominios/región configurados y autenticación documentada en [SPEC-00](../spec-00-technical-feasibility/mdm-free-api-validation.md), sin seguir redirecciones. El fake devuelve datos sintéticos y marca source=fake de forma visible. Customer ID MSP se mantiene como string opaco en configuración de backend por integración, nunca en código ni browser.

## Stack

Node.js 24 LTS, TypeScript 6.0 strict, Fastify 5 y esquemas JSON Schema para entrada/salida. React 19.3, Vite 8, React Router 7 declarativo y cliente fetch tipado desde OpenAPI; PostgreSQL 18/PostGIS 3.6 con pg parametrizado y migraciones SQL versionadas. Los patches y digest se fijarán en lockfile e imágenes al crear proyectos; ver [research.md](research.md). npm workspaces une los tres paquetes JS, Gradle Android queda separado. No worker en 0A.

## Seguridad y flujos

**Administradores.** Bootstrap local de un solo uso, con secreto inicial proporcionado fuera del repositorio, expiración y confirmación en consola local. No endpoint público de registro. Contraseñas Argon2id con parámetros al menos m=19 MiB, t=2, p=1, sal única y calibración en hardware objetivo según [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Cookie de sesión opaca aleatoria, hash en DB, HttpOnly, Secure en HTTPS, SameSite=Lax, Path=/, duración máxima 8 h e inactividad 30 min; rotación al login, logout y recuperación. CSRF por token ligado a sesión y Origin/Referer validado en métodos mutables. CORS de origen exacto configurado, credenciales solo a origen admin. Rate limits por IP y cuenta con respuesta genérica contra enumeración. Recuperación: código temporal de uso único emitido por canal externo aprobado; hasta que exista tal canal, procedimiento presencial de operador con auditoría y doble control, sin auto-recuperación web.

**Dispositivos.** Aplicar [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md) y [contrato de identidad v1](../spec-00-technical-feasibility/identity-api-contract.md) sin rebajar sus garantías. Secretos de invitación nunca se loguean y solo HMAC queda en DB. Clave privada P-256 no exportable en Android Keystore cuando se implemente el agente; en 0A las pruebas usan claves sintéticas. Challenge de un uso, confirmación presencial, verificación MDM independiente y attestation o excepción documentada; sesión opaca de 15 min ligada a clave, todas las llamadas autenticadas con PoP. Reinstalación crea clave e invitación nuevas; pérdida o reasignación revoca sesión/binding/clave previos y exige nueva ceremonia. El fake no autoriza activación real.

**OAuth MDM.** Las credenciales de apps/api/.env.local siguen locales e ignoradas y no se usan en 0A; runtime productivo obtiene secretos de archivo montado/gestor de secretos, no del frontend. Refresh token cifrado en repositorio de grants con clave fuera de DB y log; acceso solo al módulo MDM. Estado OAuth, PKCE si procede y redirección exacta se conservan del diagnóstico existente; el flujo nuevo requiere prueba de contrato antes de migrar. Refresh con exclusión mutua por grant, un reintento tras 401; 403 indica scope/tenant, 429 conserva Retry-After con backoff. Nunca seguir 3xx de API ni reenviar Authorization a otro host. No se ejecuta OAuth real en esta fase documental.

**Errores/observabilidad.** Envelope estable {error:{code,message,request_id}}. No eco de payload ni headers sensibles. Logging JSON con request_id, actor seudónimo, ruta plantilla, status, latencia y audit event; redacción de cookies, Authorization, invitaciones, códigos y tokens. Readiness verifica DB y versión de migración; liveness solo proceso. Rate limits también en endpoints de invitación, claim y sesión.

## Límites de despliegue

geops-api, geops-web y geops-db en red interna propia; solo web/reverse proxy visible. API 3500 y web 3501 son puertos locales candidatos, sujetos a verificación al arrancar. DB sin publicación de puerto por defecto. Dockerfiles multi-stage y usuario no root, health checks, límites de CPU/memoria medidos, restart unless-stopped, volumen PostgreSQL dedicado en /var/lib/postgresql para imagen PG18. Migración se ejecuta como job único antes de readiness, no concurrentemente en réplicas. Desarrollo y producción usan overlays/variables distintos; producción exige TLS, secretos montados, backups cifrados y revisión E4.

No se introducen nuevos ADR: ADR-001/004/006/007/009/012 fijan las decisiones transversales; las elecciones de librería y versionado de esta wave se registran aquí y pueden revisarse con evidencia antes de implementar.

## Extensión futura MDM

El puerto MdmProvider puede ampliarse con operaciones de perfiles y políticas solo mediante una especificación y permisos mínimos separados. La interfaz de 0A no contiene métodos de escritura ni concede capacidades por la existencia de OAuth Trial. El método getDevice sirve para corroborar binding únicamente si la API/edición lo permiten; en fake solo prueba la lógica con registros sintéticos.

Para respuestas de error, los endpoints de identidad conservan expresamente {code,correlation_id} del contrato v1 de SPEC-00; el envelope administrativo general {error:{code,message,request_id}} se limita a rutas nuevas de administración/health.

## Decisiones de implementación fundacional — 2026-10-16

- El paquete `@geops/api-contracts` versiona una copia validada semánticamente del OpenAPI de SPEC-01; el script falla si diverge. Los layouts de bytes de SPEC-00 son funciones puras y vectores sintéticos; las firmas y verificaciones se implementarán en T10–T12.
- La API arranca únicamente con `GEOPS_DATA_MODE=synthetic`, `DATABASE_URL` y sin variables OAuth. El diagnóstico OAuth existente queda fuera de la imagen API. Solo health tiene rutas activas en T04.
- `geops_schema_migrations` guarda versión y SHA-256 del SQL; advisory lock transaccional serializa el job. Readiness consulta PostGIS y compara checksums; una base caída o migración cambiada devuelve 503.
- El pool maneja errores de conexiones inactivas para mantener vivo el proceso cuando PostgreSQL se detiene. El health check DB consulta PostGIS y el job de migración reintenta transitorios de arranque. Ambas decisiones derivan de fallos observados en P03.
- Compose usa red y volumen exclusivos `geops_wave0a_*`, base sin puerto host, API/Web en loopback y secreto sintético local ignorado por Git. No existe overlay de producción en T01–T05.
