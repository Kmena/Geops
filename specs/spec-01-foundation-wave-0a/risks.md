# Revisión de amenazas y riesgos — 2026-10-16

**Resultado documental:** no se identificó un bloqueo crítico para comenzar T01–T05 con datos sintéticos. Se detectaron dos ambigüedades de contrato que se corrigieron en SPEC-00: la query string de PoP y el reto de attestation antes de generar la clave, incluida la rotación. La corrección documental no demuestra que el control funcione; R03 y R08 siguen abiertos hasta pruebas automatizadas y revisión de seguridad de la implementación. ADR-012 tiene aprobación **provisional** para este alcance.

## Amenazas de aprovisionamiento

| Amenaza | Límite de confianza / impacto | Control exigido y prueba | Estado residual |
| --- | --- | --- | --- |
| Invitación robada, caducada o reclamada dos veces | Portador externo intenta obtener identidad ajena o bloquear inscripción. | 256 bits, TTL 10 min, HMAC, CAS y unicidad; P10/P13 con reloj simulado y carreras. Activación exige comparación física y vínculo MDM independiente. | OPEN: diseño, sin pruebas. Un atacante puede inutilizar una invitación; requiere reemisión. |
| MDM ID/UDID copiado o tenant equivocado | El dato declarativo se usa como autenticación. | Nunca autorizar por identificador; binding tenant+MDM único y comprobación independiente; P11/P12 y A06. | OPEN: Free y teléfono real pendientes. |
| Clave o cadena de attestation sustituida | Un reclamante presenta clave exportable o cadena de otro intento. | Reto derivado antes de key generation, cadena anclada, challenge y SPKI coincidentes; cadena inválida rechazada; P12/P16. Falta de soporte exige excepción registrada. | OPEN: revisión de seguridad y Android A01/A02 pendientes. |
| Código corto o evidencia de activación falsificados | Admin remoto activa identidad sin mirar teléfono o con texto libre. | El código es comparación visual, no factor criptográfico; evidence_ref debe apuntar a registro inmutable ligado a claim, tenant, MDM y operador. api_read verifica server-side; manual_two_traits no habilita activación real en 0A; P12. | OPEN: procedimiento físico/manual solo se valida en piloto. |
| Bearer copiado, replay o reloj alterado | Petición falsificada con sesión robada. | PoP firmado exacto, nonce atómico 10 min, ventana ±5 min, token 15 min y estado consultado por llamada; P14/P15. Query rechazada en /v1/device. | OPEN: pruebas pendientes. |
| Rotación con nueva clave no controlada por Keystore | Reemplazo de clave por una exportable o carrera que deja dos activas. | Dos firmas, reto de attestation de rotación, verificación de nueva SPKI, CAS y revocación atómica; P16. | OPEN: pruebas y revisión de Android pendientes. |
| Pérdida, reinstalación o reasignación | Clave vieja sigue activa o se atribuyen datos al empleado nuevo. | Suspensión/revocación inmediata, nueva invitación/aprobación, nuevo binding/asignación con vigencia; P17/A05. | OPEN: prueba sintética y piloto pendientes. |
| Logs, proxy o configuración filtran secretos | Invitación, OAuth o credencial admin queda accesible. | Redacción, no registrar cuerpos/headers, entorno sintético separado de .env.local, proxy confiable para IP/rate limit; P08/P15/P22. | OPEN: revisión de implementación pendiente. |

## Registro de riesgos

| ID | Riesgo / señal | Control y evidencia requerida | Responsable por rol / estado |
| --- | --- | --- | --- |
| R01 | ManageEngine Free no permite API/scopes/volumen de Trial. | M01–M10 en Free; fake y Trial jamás equivalen a PASS Free. | Integrador MDM / EXTERNAL_PENDING. |
| R02 | Región, Customer ID, scopes, 3xx o tokens MSP erróneos. | Cliente read-only opt-in, host allowlist, X-CUSTOMER string, no redirects, mocks 401/403/429; Free antes de uso real. | Backend + Integrador MDM / OPEN. |
| R03 | Suplantación, replay, attestation, activación y ciclo de vida. | ADR-012 provisional; P10–P17, revisión de seguridad de código y A01–A06 antes de uso real. | Responsable de seguridad / OPEN_TEST_PENDING. |
| R04 | PostGIS/volumen/plataforma del host fallan. | Comprobar arquitectura/digest, P03/P04 y restore sintético antes de desplegar. | DevOps/Operaciones / OPEN. |
| R05 | Bootstrap/sesiones admin y OAuth exponen secretos. | P05–P09/P22, CSRF, redacción y secretos externos; sin datos reales. | Seguridad + Backend / OPEN. |
| R06 | Privacidad/retención/backups sin aprobación para datos reales. | Prohibición explícita de empleados, clientes, dispositivos y ubicaciones reales en 0A; aviso/retención/entorno antes de waves con datos reales. | Responsable de privacidad + Producto / EXTERNAL_PENDING. |
| R07 | Versiones o puertos 3500/3501 incompatibles/ocupados. | Pin y pruebas de compatibilidad; comprobar puertos inmediatamente antes de ejecutar. | DevOps / OPEN. |
| R08 | OpenAPI o descripciones divergen del contrato byte a byte. | Aclaraciones SPEC-00 incorporadas; T03/P02 con vectores exactos; no inferir query/attestation. | Arquitectura + Backend / OPEN_TEST_PENDING. |
| R09 | Fake/Trial se interpreta como aprobación operativa o despliegue. | Etiquetar fuente y edición; gates separados Free/Android/producción. | QA/Producto / OPEN. |
| R10 | Proxy permite X-Forwarded-For falsificado o rate limit evadido. | Confiar solo en proxies declarados; probar límites por IP/identidad detrás de proxy; P13/P22. | Backend + DevOps / OPEN. |

No se declara ningún riesgo RESOLVED por esta revisión: los controles son decisiones de diseño y faltan resultados de pruebas. Las correcciones de texto eliminan ambigüedad para implementar, no acreditan seguridad efectiva.

## Responsables y destino de validación

| Trabajo pendiente | Responsable por rol | Wave / evidencia de cierre |
| --- | --- | --- |
| Contratos y suite sintética P10–P17 | Arquitecto técnico, Backend y Seguridad | Wave 0A; pruebas + revisión de seguridad de implementación. |
| ManageEngine Free M01–M10 | Integrador MDM y QA | Wave 0B antes de activar adaptador real; fecha/persona nominal aún por asignar. |
| Dos Android A01–A06, Keystore y Fully Managed | Responsable de dispositivos Android, Integrador MDM y QA de piloto | Wave 0B/1; modelos, ventana y persona nominal pendientes. |
| Aviso, retención, datos reales y respaldos | Privacidad/Producto y Operaciones | Antes de cualquier wave que trate datos reales o producción. |
| Puertos, aislamiento y despliegue | DevOps/Operaciones | Wave 0A local para P03/P04; producción prohibida. |

La recuperación administrativa autoservicio y la aceptación del modo manual de verificación MDM siguen sin aprobación operativa. Solo se diseñan procedimientos sintéticos; no crear bypass ni credenciales predeterminadas.

## Seguimiento tras implementación T01–T05 — 2026-10-16

- **R04 sigue OPEN:** PostGIS, volumen, migración, checksum y restore ficticio pasaron en Windows/amd64. La primera migración encontró una carrera de arranque; el health check ahora consulta PostGIS y el job reintenta. Falta Linux CI y el escenario de revocación de P04, dependiente de T09/T12.
- **R07 sigue OPEN:** los puertos 3500/3501 estaban libres justo antes de iniciar Compose y los servicios GEOPS solo publican en loopback. La disponibilidad debe repetirse en cada arranque y no garantiza otros hosts.
- **R05 sigue OPEN:** se verificó que el esqueleto no carga OAuth ni registra errores internos; faltan autenticación admin y revisión completa de secretos de T06–T08/T14–T15.
- **R08 sigue OPEN:** OpenAPI y vectores sintéticos pasan, pero la firma/attestation real aún no se implementó ni recibió revisión de seguridad.
- **R01/R03/R06/R09/R10** conservan sus puertas externas y de implementación; ninguna prueba local los resuelve.

Una prueba de caída reveló un error no manejado del pool `pg` que terminaba la API. Se corrigió y P03 se repitió con 503/200. Se conserva el fallo inicial en [evidencia](implementation-evidence-T01-T05.md); no se interpreta la corrección como cierre de riesgos operativos.
