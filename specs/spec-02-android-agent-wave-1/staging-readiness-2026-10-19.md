# SPEC-02 — consolidación Git y preparación Staging (2026-10-19)

**Clasificación: READY_WITH_CONDITIONS para preparar el entorno sintético; BLOCKED para ejecutar el despliegue hasta cumplir el checklist previo.** No es aprobación operativa, de seguridad independiente ni de Android físico. Este corte no desplegó, hizo push o merge, consultó GPS real, ni cambió la PoC, ManageEngine, Inventori o Billing.

## 1. Preflight, alcance y Git

Rama `codex/spec-02-wave-1`, HEAD de partida `d72cdb49d95915f8772ffcb6818698e4439c1a57`. Se auditó el diff heredado de ocho documentos SPEC-00, el estudio MDM y ADR-014 propuesto: conservan requisitos MDM-001–006 y SPEC-00 `BLOCKED`; no seleccionan MDM ni afirman PASS físico. Su commit debe ser separado del código SPEC-02. Se revisaron el agente Kotlin, migraciones 0009–0014, API, Web, contratos, ADR-015–018 y documentos SPEC-02. `security:scan` inspeccionó 306 archivos elegibles y pasó; búsqueda adicional no halló claves privadas ni pares de coordenadas reales. Hay claves, contraseñas y coordenadas **sintéticas** en fixtures de prueba, no para Staging. Archivos `.env`, certificados, dumps, APK y secretos permanecen ignorados. El escaneo automatizado no reemplaza revisión humana de cada valor nuevo.

Commits locales trazables creados: `f3f7f01` conserva el addendum MDM SPEC-00/ADR-014; `2678513` consolida implementación y documentación SPEC-02 W1-A–E1. La preparación Staging se registra en un tercer commit separado. Ninguno incluye secretos ni artefactos privados. No hacer push ni merge.

## 2. Evidencia de consolidación

`npm run build`, `npm run typecheck`, `npm run contracts:check`, `npm test`, `npm run lint` y `npm run security:scan` pasaron. Lint informó 12 advertencias preexistentes de aserción no nula en W1-B, sin errores. PostgreSQL/PostGIS **desechable** `geops_verify_20261019` aplicó las 14 migraciones; pasaron políticas 44, configuración 24, salud 37, eventos 69, operaciones 40 y scheduler de 25 dispositivos/175 ventanas con 4 aserciones. La prueba de scheduler fue acotada (2519 ms); **no acredita carga sostenida**. Backup `pg_dump -Fc` y `pg_restore` en otra base del mismo contenedor: recuentos idénticos `14 migraciones | 175 ventanas | 7 auditorías | 6 ticks | 1 política`. Un `ALTER TABLE` seguido de `ROLLBACK` dejó cero columnas de prueba. No es restore operativo ni revalidación de secretos.

El núcleo Kotlin tuvo evidencia de 14 pruebas JVM y wire en el [Corte 2](w1-e1-c2-sessions-positions-2026-10-19.md); en esta consolidación no se localizó JDK 17/Gradle/kotlinc para **repetirlas**. No se construyó APK. Web pasó 10 pruebas Node, pero **no hubo E2E de navegador autenticado**. La integración HTTP autenticada de `GpsRemote` con el backend se conserva como evidencia parcial.

## 3. Infraestructura Staging propuesta

[Compose Staging](../../infrastructure/compose/compose.staging.yaml) crea un proyecto `geops-spec02-staging` separado, PostGIS exclusivo (`geops_dev` solo dentro de su contenedor), volúmenes `stage_pgdata`, `stage_security` y `stage_backups`, redes DB/app internas y red de borde propia. Solo HTTPS se publica en `127.0.0.1:${GEOPS_STAGE_HTTPS_PORT}:8443`; API, Web y DB no publican puertos. Para acceso remoto, la integración del proxy del servidor debe ser aprobada y conservar la verificación TLS hacia ese loopback; la configuración aquí **no modifica el proxy existente**. [Nginx HTTPS](../../infrastructure/nginx/geops-staging-https.conf) termina TLS con certificado exclusivo; [Nginx Web](../../infrastructure/nginx/geops-staging-web.conf) sirve la SPA y reenvía `/v1/` a la API privada.

La API acepta únicamente `GEOPS_DATA_MODE=synthetic`, rechazo de OAuth ManageEngine y cookie segura. [Entrypoint](../../infrastructure/staging/api-entrypoint.sh) lee seis secretos de archivos de Staging, no de variables Compose; no imprime valores. `db_password` debe ser base64url de 32+ caracteres y cada clave de API exactamente 32 bytes codificados como base64url de 43 caracteres. El host debe guardar archivos `.local/staging/secrets` con permisos mínimos, copias separadas y certificado para el origen HTTPS exacto. No reutilizar claves ni backups de ningún servicio existente. Las imágenes y servicios tienen cuotas CPU/memoria/PID, logs `local` rotados, API silenciosa y logs de acceso Nginx apagados. Health checks cubren DB/PostGIS, API readiness con restore gate, Web y proxy. Retención de posiciones/salud sigue provisional a 90 días, cuarentena a siete; [backup manual](../../infrastructure/staging/backup.sh) escribe dump y SHA-256 en volumen exclusivo, sin borrar automáticamente copias porque el plazo de backup no está aprobado.

`npm run staging:check` pasó la inspección estática del Compose, incluidas redes, volúmenes, secretos y el único puerto loopback. `docker compose config --quiet` y `sh -n` de ambos scripts pasaron. **No se construyeron ni iniciaron los servicios Staging.** La capacidad real del servidor, dominio, puerto libre, certificado, DNS y límites de recursos siguen sin verificarse.

## 4. Seguridad y restricciones abiertas

- Identidad/PoP SPEC-01, revocación y aislamiento tenant pasaron casos sintéticos; no se enroló un equipo ni se autorizó MDM real. Las capacidades `gps.installation.manage` y `gps.tenant.grant` de [ADR-018](../architecture/adr/ADR-018-operaciones-gps-sinteticas-propuesto.md) no tienen concesión automática y requieren aprobación SDD y revisión independiente.
- El administrador con capacidad de conceder tenant puede proponer acceso amplio; la elegibilidad por organización y el mecanismo operativo para asignar/revocar esa capacidad siguen pendientes. No crear grants SQL ad hoc en Staging para aparentar autorización.
- El gate de restore valida epoch externo. Su reapertura/quarantena implementada acepta únicamente `geops_verify_*_restore`, **no una restauración in situ de `geops_dev`**. El ensayo local comprobó integridad, no reactivación. Un rollback con migración incompatible debe dejar Staging apagado hasta reconstrucción sintética autorizada o diseño de restore aprobado; nunca reutilizar sesiones/PoP de un backup sin cuarentena.
- Política definitiva de retención, auditoría, borrado de backups y custodia/rotación de claves pendiente. No declarar revisión independiente de seguridad.

## 5. Checklist antes de cualquier despliegue posterior

1. Registrar propietario del servidor, inventario de contenedores/redes/volúmenes, CPU/RAM/disco libre, DNS, puerto loopback disponible y ruta del proxy HTTPS existente. Confirmar que ningún recurso se comparte con PoC, Inventori o Billing.
2. Cerrar o aceptar explícitamente para **Staging sintético** los gates de ADR-018, privacidad, alcance de administradores y comportamiento de restore. Obtener revisión independiente antes de uso con datos reales.
3. Repetir Kotlin con JDK 17/Gradle y fijar toolchain; verificar build de imágenes con SHA inmutable, Compose `config --quiet`, `staging:check`, escaneo de imágenes y disponibilidad de certificados exclusivos. Mantener la política de egress sin ManageEngine/GPS real.
4. Preparar archivos ignorados bajo `infrastructure/compose/.local/staging/secrets/` y `.env.staging`, cada secreto nuevo y exclusivo; verificar permisos y nunca imprimir `docker compose config` completo en logs compartidos.
5. Verificar que la base esté vacía antes de migrar, confirmar destino `geops_dev` **del proyecto Staging** y ejecutar migración/gate de inicio por pasos. No ejecutar migraciones en ninguna otra base.
6. Después de un despliegue autorizado, ejecutar E2E **en navegador**: login real, permisos de lectura concedidos por proceso aprobado, filtros/motivo, 401/403/409/429, tenant cruzado, cierre de sesión y acciones deshabilitadas. Mantener solo fixtures sintéticos.
7. Ejecutar carga sostenida de 25 identidades sintéticas durante ventana acordada (por ejemplo 30 minutos) incluyendo PoP, sesiones, posiciones, salud, consultas y scheduler; registrar p95, error rate, memoria, CPU, espacio, cola y ticks duplicados. El ensayo de 2519 ms no sustituye esta prueba.
8. Ensayar dump, checksum y restore en **otro** contenedor/volumen del proyecto de pruebas; verificar 14 migraciones, recuentos, FKs, índices y rechazo de credenciales antiguas. Acordar RPO/RTO y procedimiento de reapertura antes de depender de backups.

## 6. Procedimiento de despliegue propuesto, no ejecutado

Con aprobación posterior, usar checkout aislado del commit revisado y un tag de imagen inmutable. Completar los controles anteriores y usar `docker compose --env-file infrastructure/compose/.env.staging -f infrastructure/compose/compose.staging.yaml` como prefijo **solo** en el servidor aprobado. Validar `config --quiet`; construir `geops-api` y `geops-web`; iniciar únicamente `geops-db`; confirmar identidad de proyecto/base y backup previo; ejecutar una sola vez `run --rm geops-migrate` y después `run --rm geops-gate-init` sobre base vacía. Iniciar `geops-api`, `geops-web` y `geops-https` en ese orden; comprobar readiness y TLS por el puerto loopback, luego probar la ruta del proxy externo autorizada. `geops-api bootstrap <correo>` requiere terminal interactivo para contraseña y no concede capacidades GPS automáticamente. Mantener rutas de escritura sin operación real y nunca habilitar Android físico por este procedimiento.

## 7. Procedimiento de rollback propuesto, no ejecutado

Si falla una imagen **sin cambio de esquema**, aislar HTTPS y API de Staging, conservar evidencia/logs sanitizados y regresar al tag anterior solo tras comprobar compatibilidad con la base actual. Si falla una migración, identidad, epoch o integridad: cerrar acceso, detener el proyecto Staging y conservar volúmenes/dump; restaurar una copia en base desechable separada y verificarla. **No reabrir** `geops_dev` restaurada con el mecanismo actual. Para continuar un experimento puramente sintético, preparar una nueva base/volumen vacíos y gate fresco mediante un procedimiento de reemplazo aprobado, sin borrar volúmenes existentes hasta verificar objetivo y preservar evidencia. Ningún paso toca servicios externos del servidor.

## 8. Gates y decisión

`READY_WITH_CONDITIONS` describe **artefactos locales**: Compose y procedimientos listos para revisión, sin despliegue. La ejecución en el cloud existente está `BLOCKED` hasta comprobar aislamiento real, dominio/TLS, secretos, recursos, toolchain Kotlin, E2E autenticado y estrategia de restore/rollback. W1-E1 no está cerrada, W1-E2 y teléfonos físicos no se habilitan. Negocio/seguridad deben aprobar por separado cualquier cambio de alcance o uso operativo.
