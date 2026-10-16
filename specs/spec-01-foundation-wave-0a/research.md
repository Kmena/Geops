# Investigación y auditoría — corte 2026-10-16

## Evidencia del repositorio

- Rama auditada: codex/spec-01-wave-0a; árbol limpio antes de este trabajo.
- Fuente de producto: [PRD v1.1](../prd/GEOPS-PRD-v1.1.md); [cierre SPEC-00](../spec-00-technical-feasibility/closure-report.md) y [entrada 0A](../spec-00-technical-feasibility/wave-0a-readiness.md).
- ADR vigentes: [001 monorepo](../architecture/adr/ADR-001-monorepo.md), [004 infraestructura](../architecture/adr/ADR-004-infraestructura.md), [006 privacidad](../architecture/adr/ADR-006-privacidad-administracion.md), [007 MDM](../architecture/adr/ADR-007-mdm-externo.md), [009 geoespacial](../architecture/adr/ADR-009-datos-geoespaciales.md), [012 identidad](../architecture/adr/ADR-012-identidad-dispositivo.md). Los demás ADR se mantienen aplicables a waves posteriores.
- Contratos revisados: [identidad](../spec-00-technical-feasibility/identity-api-contract.md), [aprovisionamiento](../spec-00-technical-feasibility/device-provisioning.md), [API candidata](../spec-00-technical-feasibility/api-contracts.md) y [modelo conceptual](../spec-00-technical-feasibility/data-model.md).
- Ya existen directorios apps/android, apps/api, apps/web, packages/api-contracts e infrastructure/{docker,compose,nginx}; la mayoría contiene solo .gitkeep. apps/api incluye una herramienta diagnóstica OAuth aislada (mdm-oauth-core.mjs, mdm-oauth-dev.mjs, test/mdm-oauth.test.mjs, package.json y .env.example). No es la API de producto. Reutilizar sus casos simulados y lecciones, no copiar su servidor local como módulo de producción.
- SPEC-00 registra OAuth e inventario vacío con HTTP 200 solo en MSP Cloud Trial; M01–M10 no acreditan Free. El intento GET /customers sin X-CUSTOMER redirigió con 302. Customer ID de DEFAULT_CUSTOMER fue proporcionado por inspección de la consola; tratarlo como configuración por tenant de desarrollo y no como constante ni prueba Free.
- Comprobación puntual de puertos: no se detectaron listeners TCP en 3500 ni 3501 el 2026-10-16. La disponibilidad debe repetirse antes de iniciar Compose; no es una reserva.

## Tensiones documentales resueltas para el alcance

| Hallazgo | Interpretación para 0A |
| --- | --- |
| PRD desea uso de ManageEngine Free; evidencia actual solo Trial. | Diseñar interfaz y fake; integración real de lectura queda condicionada a Free. No inferir paridad entre ediciones. |
| SPEC-00 identidad figura lista para diseño, pero W0A-E2 pide revisión de seguridad. | La auditoría inicial requería revisión; el 2026-10-16 ADR-012 quedó aprobado provisionalmente para implementación sintética. P10–P17 y revisión de seguridad del código siguen pendientes. |
| En wave-readiness de SPEC-00 aparece PRD como no rastreado, mientras hoy está versionado. | Texto histórico desactualizado; usar el PRD versionado como fuente y no modificar SPEC-00 en este corte. |
| PRD prevé rastreo cada 60 s e historial de 90 días; 0A solo crea fundamentos. | No construir captura, ingesta, retención operativa ni garantías de cadencia en 0A. |
| ADR-012 exige verificación física MDM para activación; Android real pertenece a waves posteriores. | Implementar en 0A la máquina de estados y bloqueo por defecto; el fake sirve solo para pruebas sintéticas. No activar teléfonos reales por simple registro API. |

## Selección de tecnología

| Tema | Elección propuesta | Motivo y alternativa evaluada |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | [Calendario oficial](https://nodejs.org/en/about/previous-releases). Pin de patch y lockfile al implementar. |
| Lenguaje | TypeScript 6.0 con strict, tipos y módulos explícitos | [Notas oficiales](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html); validar compatibilidad de dependencias en CI antes de fijar patch. |
| HTTP | Fastify 5 | Esquemas de entrada/salida y serialización integrados según [documentación](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/); Express requeriría más ensamblaje para contrato y validación. Fastify 5 soporta Node 20+ según [guía oficial](https://fastify.dev/docs/v5.10.x/Guides/Migration-Guide-V5/). |
| Web | React 19.3, Vite 8, React Router 7 declarativo | Versiones actuales en [React](https://react.dev/versions), [Vite](https://vite.dev/releases) y [Router](https://reactrouter.com/start/declarative/routing). Vite 8 requiere Node 20.19+/22.12+, cubierto por Node 24. |
| Datos | PostgreSQL 18 + PostGIS 3.6; cliente pg y SQL parametrizado | PostgreSQL 18 está soportado por [política oficial](https://www.postgresql.org/support/versioning/) y la imagen [postgis/postgis:18-3.6](https://github.com/postgis/docker-postgis) existe. Prisma no ofrece tipo geography nativo y requiere SQL crudo para PostGIS ([documentación Prisma](https://docs.prisma.io/docs/orm/prisma-client/using-raw-sql/safeql)); un solo camino SQL reduce divergencia. pg soporta parámetros ([documentación](https://node-postgres.com/features/queries)). |
| Monorepo JS | npm workspaces solo para apps/api, apps/web y packages/api-contracts | [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces/) permite un lockfile y enlaces locales. Android permanece Gradle independiente. |
| Asincronía | Sin worker en 0A | Ningún procesamiento de colas se implementa. Introducir geops-worker cuando ingesta/outbox lo requiera, con su propia especificación. |

La imagen PostGIS 18 cambia la ruta de datos a /var/lib/postgresql y la imagen oficial documenta arquitectura amd64; verificar plataforma Docker del equipo/servidor antes de fijar digest. La elección de versiones es propuesta documental, no prueba de compatibilidad ejecutada.

## Reutilización del diagnóstico OAuth

La suite existente apps/api/test/mdm-oauth.test.mjs contiene casos simulados de state, PKCE, código vencido, refresh, scope, región, respuesta vacía, rate limit, conexión, 403, 401 con reintento, revocación, Customer ID grande como string, redirección sin seguimiento y preservación de X-CUSTOMER. Su servidor de diagnóstico está vinculado al desarrollo local; el adaptador de producto debe portar comportamientos y ampliar pruebas de concurrencia/cifrado sin reutilizar endpoints de diagnóstico públicamente. El cierre de SPEC-00 consigna 18 pruebas simuladas aprobadas; no son evidencia de Free.
