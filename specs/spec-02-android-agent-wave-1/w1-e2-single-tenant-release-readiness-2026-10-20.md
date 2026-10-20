# W1-E2 — preparación de publicación de administración para una empresa

**Fecha:** 2026-10-20. **Estado:** `BLOCKED` para publicación y actualización de Staging. Se preservó el árbol heredado; no hubo commit, push, CI remoto, servidor, migración de Staging ni concesión real. El HEAD revisado fue `ce0866a66a9a2e79492acaa0eed0739243b2824e` en `codex/spec-02-wave-1`.

## Alcance y decisiones

ADR-019 sigue **propuesto**. La decisión de negocio de una empresa y capacidades múltiples está implementada localmente: un principal obtiene `gps.user.manage` por ceremonia local con contraseña y dos custodios; establece `synthetic` de modo explícito; cada usuario recibe capacidades y acceso tenant por separado. La API verifica sesión, capacidad, Origin, CSRF y estado vigente; invita con token de un solo uso y limita intentos; cambios llevan UUID, motivo y auditoría. No se exige otro administrador para operaciones GPS ordinarias. La recuperación crítica y transferencia conservan controles reforzados. No se habilitó MDM, GPS real ni dispositivos.

## Hallazgos de seguridad y correcciones locales

1. **Cuarentena incompleta de backups:** una copia restaurada podía conservar invitaciones administrativas y concesiones GPS/tenant aunque las cuentas y sesiones quedaran bloqueadas. `quarantineSyntheticRestore` ahora consume invitaciones y revoca capacidades y ambos ámbitos tenant; `verifyForReopen` exige que todos estén inactivos. La regresión de restore y el ensayo de `pg_dump`/`pg_restore` lo verifican.
2. **Gate abierto tras mantenimiento sin vínculo al marcador:** una restauración anterior con el mismo epoch podía superar el control de tráfico. El gate abierto después de 0015 conserva el nonce de mantenimiento y lo compara con la base en cada control. `beginMaintenance` también verifica el vínculo si se inicia una actualización posterior. Gate abierto heredado sin nonce sigue siendo legible para la versión previa. Una base con marcador alterado queda cerrada.
3. **Rollback operativo pendiente:** si 0015 falla, la transacción SQL conserva 0014 y el gate queda en `maintenance`; `maintenance-finish` rechaza reabrir porque faltan las 15 migraciones. No existe aún un procedimiento aprobado para cancelar ese mantenimiento y volver al binario previo conservando acceso. Si 0015 tiene éxito, el binario previo no interpreta el gate abierto con nonce. La cuarentena de un backup restaurado revoca identidades y permisos, por lo que tampoco equivale a restaurar servicio. **No publicar ni programar actualización hasta diseñar y ensayar recuperación autorizada**, con control reforzado y revisión independiente; no forzar el gate ni copiar uno anterior.

## Evidencia local, solo datos sintéticos

- PostgreSQL/PostGIS desechable en contenedor local con bases separadas `geops_verify_*` y un `geops_dev` **dentro de ese contenedor**. No se accedió al `geops_dev` del servidor.
- Upgrade 0014→0015 con administrador, sesión administrativa, sesión de dispositivo sintético, nueve permisos y epoch previos: PASS; un choque de esquema forzado produjo error y rollback transaccional a 14 migraciones, sin cambio del CHECK de permisos; el reintento aplicó solo 0015 sin crear grants automáticos. Ambas sesiones y el epoch se conservaron.
- Ensayo con el migrador **compilado** sobre una restauración sintética 0014 llamada `geops_dev`: rechazó gate abierto y epoch incorrecto; con gate en mantenimiento aplicó 0015, preservó usuario, ambas clases de sesión, permisos y epoch, rechazó finalizar con 14 migraciones y reabrió solo con checksums de 15. Alterar el nonce después de reabrir bloqueó tráfico.
- Backup `pg_dump -Fc` de la base sintética con administrador, sesión, diez permisos e invitación; `pg_restore` a otra base. La copia no reabrió antes de cuarentena. Conteos origen `(administradores activos, sesiones, permisos, invitaciones, migraciones) = (1,1,10,1,15)`; copia después de cuarentena `(0,0,0,0,15)`. La reapertura controlada usó epoch nuevo. No se usaron secretos ni coordenadas reales.
- API autenticada de usuarios/tenant: 42 comprobaciones PASS; mantenimiento de gate: 13 PASS; regresión restore con invitación y grants: PASS. Node/Web, contratos, typecheck, lint, build, escaneo de secretos y `git diff --check`: PASS local. No hubo E2E de navegador contra Staging ni revisión independiente.

## Gates y siguiente procedimiento

1. Seguridad debe aprobar ADR-019, custodia/entrega de invitaciones, y un rollback que permita recuperar servicio después de fallo de 0015 sin restaurar identidades antiguas ni eludir el gate. Probarlo en contenedor y CI.
2. Ensayar backup/restore de una **réplica sintética que reproduzca el estado observado** de Staging; la muestra local reconstruye 0014 desde las migraciones, no verifica el estado remoto. Comprobar 14 checksums, sesiones, grants y epoch reales por un operador autorizado antes de la ventana.
3. Después de cerrar esos gates, reejecutar pruebas, escaneo y diff; revisar el conjunto heredado de cambios; crear commits trazables, comprobar remoto y publicar solo esta rama. GitHub Actions debe terminar antes de programar Staging. La publicación de código no autoriza el despliegue.
4. En la ventana futura seguir el [runbook de administración](single-tenant-administration-runbook-2026-10-19.md): backup, gate de mantenimiento, migrador 0015, verificación y apertura; luego ceremonias del principal/tenant. No ejecutar `gate init`, migración con gate abierto ni SQL manual.

**Readiness:** `BLOCKED` para publicación y actualización; W1-E2 físico permanece bloqueado. El SHA remoto y el resultado CI de esta revisión no existen porque no se hizo push.

## Addendum: recuperación local de 0015

El bloqueo técnico de reanudación tiene una [implementación hacia adelante](migration-0015-safe-recovery-2026-10-20.md) y ensayo sintético. Las instrucciones anteriores de `maintenance-finish` y de exigir rollback al binario viejo quedan **superadas** para `geops_dev`: el CLI las rechaza y usa recuperación supervisada. El gate abierto queda ligado además al OID de la base, lo que bloquea una restauración lógica a una base nueva con marcador copiado. El estado de publicación sigue `BLOCKED` hasta revisión independiente, CI y ensayo de una réplica que represente el Staging observado; no hay SHA publicado nuevo ni autorización de actualización.

## Gate final de release

Se prepararon un [ensayo manual Ubuntu y paquete de revisión](migration-0015-final-release-gate-2026-10-20.md) para una copia privada aislada de Staging. La evidencia sintética local verifica migración, cuarentena y permisos, pero no acredita todavía el dump real ni revisión independiente. **Readiness: `BLOCKED`**; no hacer push ni despliegue por el resultado de estas pruebas.
