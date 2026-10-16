# Specify — alcance y criterios

## Objetivo y límites

Wave 0A establece un monorepo ejecutable localmente, API administrativa mínima, identidad de dispositivo en backend, adaptador MDM de lectura desacoplado, base PostgreSQL/PostGIS y consola administrativa básica. Solo se usan datos ficticios en pruebas. GEOPS mantiene DB, secretos, redes y despliegue independientes de Inventori/Billing.

Quedan fuera: app Android real, inscripción física, activación operativa, escrituras MDM o perfiles, GPS, mapa operativo, rutas, visitas, captación, alertas, IA, despliegue productivo y afirmaciones sobre edición Free. La implementación futura debe bloquear la activación real cuando falte verificación física MDM conforme a [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md).

## Historias de Wave 0A

| Historia | Resultado observable al terminar implementación | PRD | Tareas | Pruebas |
| --- | --- | --- | --- | --- |
| S01 Fundación | Desarrollador inicia API, web y DB aisladas; health y migraciones muestran estado. | Base técnica RF-01–RF-15 | T01–T05, T18 | P01–P04 |
| S02 Administración | Administrador aprovisionado por procedimiento seguro inicia/cierra sesión, revoca y recupera acceso; acciones auditadas. | Usuarios admin; RF-15 | T06–T08, T15 | P05–P09 |
| S03 Identidad backend | Admin emite invitación individual; dispositivo sintético demuestra clave y obtiene sesión PoP; reuso, rotación y revocación fallan/funcionan según contrato. | RF-02, RF-03 parcialmente | T09–T12, T15 | P10–P17 |
| S04 MDM desacoplado | API lista inventario desde fake con cliente MSP explícito, paginación/errores; proveedor real queda de solo lectura y opt-in. | RF-01, RF-02 parcialmente | T13–T14 | P18–P22 |
| S05 Consola básica | Admin ve su sesión, estado de integración e inventario sintético; estados de carga, vacío y error accesibles. | RF-02 parcialmente | T16–T17 | P23–P25 |

Estas historias están especificadas; S01 tiene implementación fundacional parcial T01–T05 y S02–S05 siguen sin implementar. S03 no equivale a una inscripción Android ni certifica vínculo MDM. El fake nunca produce evidencia de proveedor real.

## Trazabilidad del PRD por resultado

| Requisito | Cobertura 0A | Diferido |
| --- | --- | --- |
| RF-01 administración MDM | Puerto/adaptador, OAuth server-side y modo de lectura condicionado. | Cuenta Free, políticas, perfiles, despliegue de app, dispositivos reales. |
| RF-02 inventario/vínculo | IDs GEOPS, modelo de binding y lectura fake; posible cliente real detrás de bandera. | Vínculo verificado con dos Android. |
| RF-03 agente Android | Contrato backend de identidad y sesiones. | Keystore y agente Kotlin, permisos, GPS, offline. |
| RF-04–RF-13 | Sin implementación; contratos futuros no condicionan 0A. | Waves 1–5. |
| RF-14 retención | Diseño de particiones/borrado y postura de privacidad. | Posiciones reales y proceso de purga de 90 días. |
| RF-15 administración/auditoría | Identidad admin, sesión, eventos auditables. | Analítica y reportes operativos. |
| CA-01–CA-12 / VAL-01–VAL-08 | Solo los criterios ligados a S01–S05 se verifican con pruebas sintéticas. | Criterios de GPS/MDM/Android se prueban en waves y piloto. |

## Criterios de aceptación de la implementación futura

1. Trazabilidad S01–S05 a tareas P01–P25 y resultados reproducibles; ningún resultado fake se registra como PASS de SPEC-00.
2. API aplica validación de esquemas, auth por defecto, errores sin secretos, rate limit y auditoría; solo liveness es público sin datos.
3. Admin único inicial se aprovisiona mediante comando local de un solo uso; no hay registro público ni credenciales por defecto.
4. El backend implementa íntegro el contrato de identidad v1: invitación 256 bits/10 min, claim/challenge, confirmación presencial, clave P-256, sesión 15 min y PoP, rotación, revocación. Activación real queda bloqueada hasta verificación independiente MDM y revisión W0A-E2.
5. Integración MDM separa credenciales Zoho de sesiones GEOPS; cliente real es lectura únicamente y deshabilitado por defecto. Paginación, 401/403/429, refresh single-flight y CUSTOMER string están cubiertos con mocks.
6. PostgreSQL/PostGIS inicia con migraciones versionadas, integridad e índices; backup y restore ensayados con datos ficticios antes de considerar uso real.
7. Web nunca recibe OAuth/refresh token MDM; sesión admin usa cookie segura HttpOnly/SameSite y protección CSRF para mutaciones.
8. Límite inicial: prueba sintética de 25 identidades y carga administrativa definida en [test-plan.md](test-plan.md); no afirmar SLO productivo sin medición.

## Requisitos no funcionales medibles para aceptación local

- Disponibilidad: liveness 200 durante funcionamiento; readiness cambia a 503 dentro de 10 s de una caída simulada de DB y vuelve a 200 dentro de 60 s de restaurar DB/migraciones en P03. Reinicio conserva estado persistente. Son objetivos locales por medir; SLO productivo pendiente.
- Rendimiento: con 25 dispositivos sintéticos, p95 de lectura paginada de inventario fake menor a 500 ms y login p95 menor a 1 s en entorno de CI documentado; son objetivos de aceptación, no mediciones actuales.
- Seguridad: 100% de rutas mutables con auth, CSRF o PoP según actor; secretos ausentes de Git/logs/respuestas; pruebas negativas P08/P12/P15/P22.
- Mantenibilidad: contrato OpenAPI validado en CI y migraciones reversibles o con plan de rollback explícito; TypeScript strict y análisis estático sin errores.
- Observabilidad: cada solicitud registra request_id, ruta, resultado y latencia, sin tokens/PII; métricas de errores y salud.
- Recuperación: restauración de backup ficticio en entorno aislado y prueba de revocación tras restore; RPO/RTO productivos pendientes.
- Portabilidad: Compose probada en Windows Docker Desktop y Linux amd64, paths/line endings independientes; cualquier incompatibilidad de imagen se documenta antes de implementación.

## Trazabilidad de criterios y validaciones del PRD

| Grupo PRD | Destino y estado |
| --- | --- |
| CA-01, CA-12; VAL-01, VAL-02 | Fuera de 0A: MDM Free y Android Fully Managed requieren evidencia de SPEC-00, no fake. |
| CA-02–CA-05; VAL-03–VAL-05 | Waves 1–2: captura, offline, horario, heartbeat y alertas; 0A solo identidad backend. |
| CA-06–CA-09; VAL-06 | Waves 3–5: pines, visitas, captación y dashboard; sin implementación 0A. |
| CA-10 | 0A diseña particiones/retención; ejecución y verificación de purga de 90 días corresponden a wave de ingesta. |
| CA-11; VAL-08 | 0A establece DB/red/secretos propios y prueba aislamiento sintético; capacidad/migración de servidor compartido se verifica antes de despliegue. |
| VAL-07 | 0A cubre auth y privacidad por diseño; validación legal/avisos y Android real siguen pendientes. |
