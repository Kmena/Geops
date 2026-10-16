# Plan de implementación futura — Wave 0A

## Secuencia y dependencias

1. **Puertas de inicio.** Aplicar [wave-readiness.md](wave-readiness.md): ADR-012 aprobado provisionalmente, datos/dispositivos sintéticos exclusivamente y responsables externos por rol. T01–T05 pueden comenzar sin Free ni piloto; sus ventanas externas siguen pendientes.
2. **Fundación.** Crear npm workspaces y lockfile, TS strict, lint/test, paquete de contratos, Fastify y web shell sin migrar ciegamente la herramienta OAuth. CI ejecuta chequeos reproducibles.
3. **Datos/Compose.** Crear Dockerfiles multi-stage, geops-api/web/db, redes y volumen propio; migraciones SQL y PostGIS; comprobar plataforma amd64/volumen PG18, puertos 3500/3501 al arranque y ausencia de colisiones. Job de migración previo a readiness.
4. **Seguridad admin.** Bootstrap local de un uso, hashes Argon2id, sesión cookie, CSRF, logout, recovery operativa y auditoría. No credencial por defecto.
5. **Identidad.** Persistencia, transiciones, invitación/claim/PoP, rotación y revocación en backend con fake y claves sintéticas. El endpoint activate real mantiene guardia de verificación física MDM y revisión de seguridad.
6. **MDM.** Extraer del diagnóstico existente solo comportamiento verificable a MdmProvider y pruebas simuladas; cliente real read-only diseñado y probado con mocks, deshabilitado en la ejecución sintética; sin OAuth ni llamadas MDM reales en 0A. Web muestra status e inventario sintético.
7. **Cierre de 0A.** Pruebas [test-plan.md](test-plan.md), revisión de seguridad, backup/restore ficticio, trazabilidad y evidencia. Nada de esto cierra SPEC-00.

Tareas detalladas en [tasks.md](tasks.md). Lotes 2–4 pueden avanzar en paralelo después de contratos base, pero migración, auth y activación deben integrarse secuencialmente con pruebas de seguridad.

## Topología Compose prevista

| Servicio | Exposición local | Salud/dependencias | Persistencia |
| --- | --- | --- | --- |
| geops-db | Sin puerto host por defecto | pg_isready + SELECT postgis_version(); recursos medidos | Volumen geops-pgdata en /var/lib/postgresql para PG18. |
| geops-api | 127.0.0.1:3500 en desarrollo; tras proxy en despliegue | Depende de DB healthy y migración completada; /health/ready | Sin estado en FS; grants cifrados en DB, clave externa. |
| geops-web | 127.0.0.1:3501 en desarrollo; proxy/TLS en despliegue | GET página; API por proxy mismo origen | Ninguno. |
| geops-migrate | Sin puerto; one-shot | Corre tras DB healthy, antes API | Solo schema_migrations. |

Red geops-internal exclusiva, DB solo en red interna; la red de exposición/proxy se define por entorno. Dockerfiles multi-stage con dependencias congeladas y usuario no root. Compose dev usa bind mounts y datos ficticios; producción usa imágenes con digest, secretos montados, TLS en proxy y límites de CPU/memoria basados en prueba. restart unless-stopped para API/web/db, no reinicio infinito de migración fallida. No geops-worker hasta colas reales.

## Configuración y secretos

Validación al inicio de variables requeridas por modo: DB_URL, ADMIN_SESSION_KEY/CSRF_KEY, INVITATION_HMAC_KEY, MDM_PROVIDER_MODE, MDM_REGION, MDM_CUSTOMER_ID y OAuth Client ID/Secret solo si modo real. La .env.local existente contiene credenciales reales y queda fuera de 0A; usar solo configuración ficticia aislada y plantillas versionables. Producción: archivos de secretos o secret manager, permisos mínimos, clave de cifrado separada de DB, rotación documentada. No imprimir configuración completa ni incluir valores en errores. Fallar cerrado si falta variable o edición/scope no verificados.

## Migraciones y recuperación

Migraciones secuenciales numeradas, checksum, lock de advisory, transacciones cuando aplique, dry-run en DB desechable; jamás cambios automáticos de esquema al iniciar cada réplica. Backup antes de migrar, restore ensayado, rollback mediante migración compensatoria o restauración documentada cuando no sea reversible. No publicar datos reales hasta completar aviso, retención y entorno seguro.

## Evidencia esperada

PR con commits futuros separados por componente, salida de CI, validación de OpenAPI, pruebas sintéticas, logs sanitizados, resultado de puertos/plataforma, restauración y checklist de seguridad. La presente ejecución solo produce el plan; no crea PR ni commits.
