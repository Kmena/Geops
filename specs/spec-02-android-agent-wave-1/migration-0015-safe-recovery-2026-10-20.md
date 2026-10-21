# SPEC-02 — recuperación supervisada de esquemas 14–17

**Estado (21/10/2026):** implementación y ensayos sintéticos locales de recuperación 14→17, 15→17, 16→17 y verificación 17→17. Pendientes revisión independiente de Seguridad, ejecución remota de CI, réplica fiel de Staging y autorización de despliegue. Este documento no autoriza operar sobre Staging, restaurar la base activa ni usar GPS real.

## Ampliación a 0017

El binario de recuperación exige exactamente el catálogo de 17 migraciones de esta versión. Antes de la ceremonia comprueba que el ledger es un prefijo ordenado de longitud 14, 15, 16 o 17, con checksums idénticos. Verifica además la estructura correspondiente: tablas, índices, columnas, nulabilidad, constraints y objetos ausentes antes de su migración. Un ledger de 17 filas no basta para abrir el gate. `resolved_at` nace en 0016; 0017 añade `evaluated_at`, el índice de paginación y la cuota de lectura.

Con el gate en `maintenance` y el marcador/epoch/nonce/OID idénticos, el principal activo y dos custodios distintos autorizan un `requestId` nuevo. La recuperación toma advisory locks, exige cero conexiones ajenas, conserva una huella SHA-256 de identidades, permisos y datos de continuidad ya existentes y ejecuta únicamente las migraciones pendientes en orden. Cada migración usa su propia transacción; SQL y fila del ledger se confirman juntos. Tras cada COMMIT vuelve a comprobar identidad, estructura y huella. El error deja el gate cerrado; un reintento exige otra ceremonia y `requestId` nuevo. La validación final del esquema 17 y la auditoría preceden la escritura del gate `open`.

| Estado inicial verificado | Acción supervisada | Estado de salida permitido |
| --- | --- | --- |
| 14 | 0015, 0016, 0017 en orden | 17 íntegro y gate abierto |
| 15 | 0016, 0017 | 17 íntegro y gate abierto |
| 16 | 0017 | 17 íntegro y gate abierto |
| 17 | No reaplica SQL; valida y audita | 17 íntegro y gate abierto |
| Incompleto, alterado, desconocido o restaurado sin cuarentena | Ninguna migración ni apertura | Gate cerrado; investigar o restaurar de forma aislada |

La prueba de inyección cubre fallos antes de 0015, durante 0015/0016/0017 (rollback), después de cada COMMIT y después de auditar pero antes de abrir. También cubre checksums, objetos parciales o faltantes, identidad de base, nonce, epoch, cuarentena, credenciales, replay, conexiones ajenas y concurrencia. Los ensayos de estado 15–17 conservan tenant sintético, permisos, sesiones y epoch. El CLI compilado migró una copia sintética con nombre `geops_dev` dentro de un contenedor descartable; el `maintenance-finish` legado fue rechazado. La evidencia local no sustituye la revisión independiente ni confirma la topología real de Staging.

Para Staging: detener solo API/Web GEOPS, realizar backup verificable, comprobar imagen aprobada y versión actual, cerrar el gate mediante `maintenance-start` una sola vez, verificar cero conexiones ajenas y ejecutar interactivamente `maintenance-recover` desde la imagen compatible. No ejecutar `maintenance-finish` ni abrir manualmente el gate. Si falla, conservar gate, volumen y base; diagnosticar y repetir la ceremonia con UUID nuevo únicamente tras verificar ledger, estructura y marcador. Antes de servicio, comprobar auditoría, epoch/nonce/OID, 17 checksums, datos existentes, autenticación y autorización. No copiar sesiones o credenciales de una restauración a un entorno abierto: la restauración sigue el procedimiento aislado de cuarentena y rotación.

`scripts/release-0015/ubuntu-rehearsal.sh` conserva el nombre histórico, pero su verificador acepta ahora copias aisladas en 14–17 y exige salida 17. `scripts/staging/clean-reinstall-0015.sh` sigue siendo un procedimiento destructivo antiguo de 15 migraciones: **no utilizarlo para la actualización persistente 15→17**. En el ensayo local se validó también una réplica sintética 16→17 con el verificador pre/post. La ejecución completa del ensayo Ubuntu sobre una réplica fiel de Staging continúa pendiente.

## Historia de 0015 (evidencia anterior a la ampliación)

## Estrategia

Recuperación **hacia adelante** con API/Web detenidas. La versión nueva es el puente: lee gates `open` heredados sin nonce y los nuevos con nonce; el binario antiguo no puede servir la base 0015. El gate `maintenance` permanece cerrado durante todo el procedimiento. El comando supervisado verifica nombre exacto de base, epoch, nonce, OID de la base, ausencia de otras conexiones, checksums de 0001–0014 y el estado transaccional completo de 0015. Solo acepta 14 migraciones sin objetos de 0015 o 15 con los objetos esperados. Requiere contraseña del principal, dos custodios activos distintos, UUID nuevo, motivo y confirmación explícita de imagen compatible. Registra autorización y validación en `audit_event` y escribe el journal externo antes de abrir. Un UUID ya usado se rechaza; un reintento después de interrupción requiere uno nuevo y toda la ceremonia.

`database_oid` en el marcador vincula el gate a la encarnación local de la base. Una restauración lógica en una **base nueva** conserva el OID antiguo en el dump y no supera la verificación. Si falta el volumen de seguridad, no hay recuperación de mantenimiento: solo el protocolo de restore aislado puede crear un gate `closed` nuevo, poner en cuarentena todas las identidades y abrir con epoch nuevo. Nunca copiar el gate anterior.

## Estados y decisiones

| Fallo | Estado observable | Acción permitida | Acción prohibida / condición de servicio |
| --- | --- | --- | --- |
| Antes de `maintenance-start` | Gate `open` heredado, 14 checksums | Mantener versión anterior y repetir preflight | Aplicar 0015 con gate abierto |
| Durante el cierre, antes del COMMIT del marcador | Gate `maintenance`, marcador ausente o discordante, 14 | Parar; conservar evidencia; restaurar **aislado** y cuarentenar, o investigar mediante cambio de seguridad específico | Inventar nonce, forzar gate o reanudar automáticamente |
| Tras cierre, antes de 0015 | Gate `maintenance`, marcador/OID/epoch iguales, 14 checksums, sin objetos 0015 | Comando supervisado aplica 0015 transaccionalmente | Reabrir con 14 o arrancar API |
| Durante 0015 | La transacción abortada deja 14 y ningún objeto, o COMMIT deja 15 | Verificar ledger/objetos y reintentar con UUID nuevo | Reparar tablas a mano o tratar 14 con objetos como íntegro |
| Después del COMMIT, antes de abrir | 15 checksums y objetos, gate `maintenance` | Comando supervisado omite SQL y valida integridad | Ejecutar binario antiguo o alterar el epoch |
| Fallo al escribir gate `open` | Journal/auditoría pueden registrar validación; gate sigue `maintenance` o ya `open` | Leer gate y tráfico; si sigue cerrado, nueva ceremonia; si abierto, verificar marcador y salud | Repetir sin inspección; usar el mismo UUID |
| API nueva incompatible | Gate `maintenance` si se detecta antes de abrir; `open` si se detecta después | Antes: corregir imagen y reanudar. Después: detener API/Web, ejecutar `maintenance-start` con el puente nuevo para cerrar y crear nonce nuevo, corregir imagen y repetir recuperación supervisada | Mantener API incompatible sirviendo, forzar gate o volver al binario anterior tras 0015 |
| Reinicio de host/contenedor | Gate y ledger según una de las filas anteriores | Rehacer preflight y ceremonia con conexiones aisladas | Suponer que un log de éxito implica gate abierto |
| Pérdida de volumen de seguridad | Gate ilegible o ausente; tráfico denegado | Restore aislado, cuarentena, credenciales nuevas y epoch nuevo | Regenerar gate `maintenance/open` para la base activa |
| Backup anterior a 0015 | Restauración aislada con 14; sesiones/grants históricos | Validar dump; migrar en copia, cuarentenar, supervisar recuperación administrativa | Reusar sesiones, custodios, invitaciones, tokens o permisos automáticamente |
| Backup posterior a 0015 | Restauración aislada con 15, marcador con OID de origen | Validar dump y checksums; cuarentena, nuevo epoch y recredencialización | Copiar nonce/gate original o restaurar sobre base activa |

Si el gate quedó `open` pero la API falla, **no** se promete rollback sin interrupción: detener API/Web, iniciar otro mantenimiento con el puente nuevo (`maintenance-start` verifica el nonce y OID actuales), corregir la imagen y repetir la ceremonia con UUID nuevo. No usar `closeGate`, que rota el epoch y está destinado a restauración. Restaurar identidad anterior requiere cuarentena y nuevas credenciales. La revisión independiente debe aprobar este límite operativo antes de publicar.

## Ensayo de recuperación y apertura

1. Preparar backup consistente y restaurarlo solo en base aislada. Comprobar checksums 0014, inventario de administradores/sesiones/grants/invitaciones/revocaciones, `security_epoch`, tamaño y prueba de lectura del dump. Preservar el gate y journal en volumen separado. Nunca copiar secretos a la réplica.
2. Detener **solo** API/Web GEOPS; exigir cero conexiones ajenas a `geops_dev`. Verificar digest inmutable de la imagen nueva, contratos, build y compatibilidad con 0015. Registrar autorización de cambio y dos custodios de recuperación independientes.
3. Ejecutar `gate maintenance-start` con base y epoch exactos. Si ya está en `maintenance`, no repetir `start`. Comprobar `maintenance-verify` y que API siga denegada. Un marcador ausente o discrepante detiene la recuperación.
4. Desde la imagen nueva con volumen de gate escribible, ejecutar interactivamente `maintenance-recover <principal> <custodio1> <custodio2> <UUID-nuevo> <motivo>` con `GEOPS_DATA_MODE=synthetic`, `GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev`, `GEOPS_CONFIRM_MAINTENANCE_EPOCH=<epoch>`, `GEOPS_CONFIRM_FORWARD_RECOVERY=YES` y `GEOPS_CONFIRM_COMPATIBLE_RELEASE=YES`. El comando solicita tres contraseñas sin eco. No pasar contraseñas por argumentos, variables o logs. El servicio Compose `geops-gate-init` puede ejecutar ese subcomando mediante `docker compose run --rm -it` con las variables explícitas; su volumen de gate es escribible. **No usar `gate maintenance-finish` para `geops_dev`.**
5. Comprobar 15 checksums, objetos 0015, auditoría, gate `open` vinculado al marcador, epoch original y preservación de sesiones, permisos, invitaciones y revocaciones. Arrancar API/Web nueva solo después de pruebas autenticadas y de salud. Una falla deja el gate cerrado y exige diagnóstico y UUID nuevo.

## Evidencia y límites

El ensayo local crea 0014 con administrador, sesiones de administrador y dispositivo, nueve permisos y epoch; fuerza interrupción antes de SQL, después del COMMIT y antes de abrir. Comprueba replay, credenciales inválidas, marcador/OID alterado, pérdida del gate, objeto parcial, concurrencia, ausencia de duplicación de migración y conservación de identidad: **27 comprobaciones PASS** en PostGIS desechable. Un segundo mantenimiento después de abrir prueba la recuperación de una API incompatible. La prueba previa de migración fuerza error SQL y verifica rollback a 14; el ensayo de migrador compilado con nombre `geops_dev` dentro del contenedor rechaza el `maintenance-finish` legado. Un dump posterior a 0015 se restauró en otra base y pasó la cuarentena de credenciales. El OID protege restauraciones lógicas en una base nueva; no demuestra detección de una restauración **in situ** sobre el mismo OID ni de snapshots físicos del cluster. Esas operaciones están prohibidas por el runbook y requieren control operacional independiente. Tampoco se ha probado aún el estado observado real de Staging, un reinicio completo de Docker en cada fase, ni el comportamiento de la imagen nueva en un E2E autenticado tras apertura.
