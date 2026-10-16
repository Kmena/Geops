# ADR-013 — Época externa y restauración cerrada por defecto

**Fecha:** 2026-10-16. **Estado:** adoptado para ensayos sintéticos de Wave 0A; aprobación operativa y producción pendientes.

## Contexto

Un `pg_dump` tomado antes de revocar una identidad repuso después claves, sesiones y administradores activos. La cuarentena de PostgreSQL los anulaba al ejecutarse, pero no impedía que una API atendiera solicitudes entre `pg_restore` y la cuarentena. Una marca guardada solo en la base restaurada también retrocedería con el backup.

## Decisión

1. La API Wave 0A exige un archivo `security-gate.json` en un volumen GEOPS exclusivo, separado del volumen y los backups de PostgreSQL. La ausencia, corrupción o fase `closed` devuelve 503 en todas las rutas salvo liveness. Cada solicitud comprueba la época externa contra la fila `security_epoch` de la base. Readiness también falla cerrado.
2. Al iniciar mantenimiento se escribe atómicamente `closed` con una nueva época UUID y se sincroniza el archivo antes de detener API/Web. Esa época nueva invalida cualquier copia con la época antigua. Se esperan las solicitudes pendientes y se comprueba que no quedan conexiones de API/workers antes de tocar la base.
3. Se restaura siempre a una base sintética nueva `geops_verify_<número>_restore`. Con API y workers detenidos, se aplican migraciones y la cuarentena revoca todas las credenciales restauradas, bloquea administradores/custodios y actualiza la época de DB en una transacción. La reapertura exige esquema listo, época coincidente, evento de cuarentena, cero credenciales activas y ninguna otra conexión. `open` es idempotente si ya coincide.
4. La secuencia de cierre, cuarentena y reapertura deja eventos sanitizados en un journal fuera del backup y en `audit_event`. Si se pierde el volumen externo, solo se puede crear una marca **cerrada** sobre una base restaurada aislada con confirmación explícita; nunca se abre automáticamente. El bootstrap de una marca nueva exige base vacía.
5. La recuperación administrativa posterior necesita solicitud temporal y dos aprobaciones autenticadas de custodios distintos. La ruta heredada que aceptaba dos etiquetas queda deshabilitada. El alta de custodios reales y la verificación humana siguen fuera de la aceptación local.

## Garantía y límites

El ensayo sintético demostró que un backup antiguo no pasa el gate después del cierre y que la cuarentena invalida credenciales antes de abrir. La comparación por solicitud protege también frente a un reinicio de API durante mantenimiento. Una solicitud ya aceptada antes del cierre puede terminar: por eso el procedimiento **debe detener API/workers y esperar su salida antes de restaurar**. La consulta de conexiones y el gate no sustituyen el aislamiento de red ni garantizan detener un proceso ajeno con acceso directo a PostgreSQL.

El volumen externo es un dominio de confianza operativo: pérdida o manipulación exige mantener el servicio cerrado e investigar; no se reconstruye un estado abierto desde un backup. Una restauración no autorizada que omita cerrar el gate y reponga una copia con la misma época, o la manipulación simultánea de DB y volumen externo, queda fuera de la garantía actual. Para producción se necesita orquestación con control de acceso, respaldo del journal, prueba Linux/CI, revisión independiente y política de recuperación de custodios. Ninguna prueba local acredita ManageEngine Free, Android real o producción.

## Adenda: orquestación y destino de migraciones — 2026-10-16

La secuencia se encapsula en `scripts/restore-synthetic.mjs`: preparación y reapertura son comandos separados. `prepare` cierra el gate, detiene y drena Web/API y jobs GEOPS, comprueba contenedores/conexiones, restaura en destino `*_restore`, migra con destino confirmado, pone en cuarentena y verifica; deja gate cerrado. `reopen` exige evidencia `restore.verified`, destino activo, época exacta y autorización explícita del operador. La API usa `app.close()` al recibir SIGTERM; si no termina en 30 s, Docker la mata y el proceso no restaura hasta constatar cero conexiones. La evidencia de fases se sincroniza en archivo local ignorado, sin secretos. Esto cubre un ensayo sintético, no un controlador de tráfico de producción.

El migrador ya no arranca como dependencia de API: reside en el perfil Compose `maintenance`. `DATABASE_URL`, `GEOPS_MIGRATION_TARGET`, `GEOPS_CONFIRM_MIGRATION_TARGET` y `GEOPS_TEST_DB` (si existe) deben designar la misma base; nunca se reescribe la URL. `geops_dev` exige autorización adicional, cero conexiones y gate cerrado si tiene esquema. Esta decisión corrige el caso observado donde `GEOPS_TEST_DB` alteró silenciosamente el destino. Los tests locales y PostgreSQL aislado prueban rechazo de discordancia e idempotencia; falta ensayo operativo completo y revisión independiente. El estado de SPEC-01 y las puertas externas no cambian.
