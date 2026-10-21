# GEOPS — informe local de recuperación supervisada 14–17

**Fecha:** 21/10/2026. **Rama:** `codex/geops-integration`. **Base de los cambios:** `65cc8befd3d22ecc7950f217accadb70763c22a6`. **Entorno:** worktree aislado y contenedor local PostGIS descartable. No se accedió a Staging ni se ejecutaron migraciones en bases compartidas. Este informe registra evidencia local previa a publicación; el resultado de CI se comunica por separado.

## Causa y diseño

El recuperador previo solo aceptaba un catálogo de 15 migraciones y estados 14/15; el checkout integrado tiene 17. Las condiciones del workflow para la rama antigua omitían los tres ensayos de recuperación en `codex/geops-integration`. El script de réplica histórica también exigía salida 15.

El recuperador nuevo exige un catálogo exacto de 17 nombres y checksums y reconoce únicamente estados íntegros 14, 15, 16 o 17. Verifica ausencia o presencia de objetos, columnas, índices y constraints según el estado; no interpreta 17 filas como prueba suficiente. Mantiene el gate en mantenimiento, identidad exacta de base, OID, epoch, nonce, cuarentena, cero conexiones ajenas, principal activo, dos custodios independientes, request ID único, advisory locks y auditoría. Aplica solo las migraciones pendientes, cada una con SQL y ledger en una transacción. Un fallo deja el gate cerrado y exige una nueva ceremonia. Antes de reabrir verifica estructura 17 y una huella de identidades, permisos, tenant y datos de continuidad preexistentes. La huella de alertas 0016 omite únicamente la columna `evaluated_at` introducida por 0017 para comparar la misma forma histórica.

En una repetición previa a publicación hubo rechazos intermitentes de identidad durante el ensayo. La comprobación contaba también procesos internos `autovacuum worker` como si fueran conexiones incompatibles. Se ajustaron el recuperador, el gate de mantenimiento y el migrador para excluir **solo** ese tipo de proceso; las conexiones cliente y los demás procesos siguen bloqueando el mantenimiento. El test de inyección ahora exige que cada interrupción falle por el error esperado y conserva la prueba de rechazo de una segunda conexión cliente. Este diagnóstico se basa en la única condición variable observada; no hay trazas del worker en el instante exacto de cada rechazo.

## Matriz de evidencia local

| Clasificación | Resultado | Evidencia |
| --- | --- | --- |
| `RECOVERY_14_TO_17` | `PASS` sintético | Fixture poblado 14, migraciones 0015–0017, ledger/checksums, identidad, gate y 48 comprobaciones con inyección de fallos. |
| `RECOVERY_15_TO_17` | `PASS` sintético | Tenant y permiso existentes conservados; índice 0015 faltante impide abrir; restaurado el índice, llega a 17 sin reaplicar 0015. |
| `RECOVERY_16_TO_17` | `PASS` sintético | Alerta resuelta y horario/sesión sintéticos conservados; `evaluated_at` queda desconocido (`NULL`); índice 0016 faltante impide abrir. También pasó una réplica pre/post aislada. |
| `RECOVERY_17_TO_17` | `PASS` sintético | Valida estructura completa, conserva alerta/identidades y no reaplica SQL; un índice 0017 faltante impide abrir. |
| `RECOVERY_FAULT_INJECTION` | `PASS` sintético | Antes de 0015, durante cada migración, después de cada COMMIT, antes de abrir; rollback de transacción, reintento autorizado, replay, concurrencia, checksum, versión desconocida, objeto parcial, OID, nonce, epoch, cuarentena y conexión ajena. |
| `RECOVERY_SECURITY` | `CONDITIONAL_PASS` | Controles anteriores probados localmente y escaneo de secretos PASS. Falta revisión independiente, evaluación del rol SQL y ensayo con réplica fiel. |
| `STAGING_READINESS` | `BLOCKED` | No se inspeccionó la base ni el gate reales; CI remoto y revisión de seguridad pendientes. No hay autorización de despliegue. |

El ensayo del CLI compilado sobre un `geops_dev` **solo dentro del contenedor descartable** pasó: rechazó migración con gate abierto, migró 14→17 con gate cerrado, rechazó `maintenance-finish` legado y abrió mediante recuperación supervisada. El validador de réplica histórica se adaptó a entrada 14–17 y salida 17; el script Ubuntu conserva su nombre de 0015. `clean-reinstall-0015.sh` es destructivo y obsoleto para una actualización persistente: no usarlo para 15→17.

## Verificaciones de repositorio

- `npm test`, `npm run typecheck`, `npm run build`, `npm run lint` y `npm run contracts:check`: salida 0. Lint conserva 12 advertencias preexistentes fuera del cambio.
- `npm run security:scan`: PASS, 419 archivos elegibles en la verificación final previa a publicación. `git diff --check`: salida 0.
- PostgreSQL/PostGIS descartable: migración de fixture 14→17, recuperación 14/15/16/17→17, gate, continuidad 0016→0017, CLI compilado y réplica 16→17: PASS.
- `bash -n` del ensayo Ubuntu: PASS dentro del contenedor descartable. El ensayo Ubuntu completo con una réplica fiel no se ejecutó.
- Workflow CI: eliminadas las condiciones que omitían recuperación en la rama integrada; añadidos fixtures 15/16/17. El resultado de GitHub Actions correspondiente al commit publicado debe verificarse por separado.

## Riesgos y prerrequisitos de Staging

La comprobación estructural cubre los objetos críticos de 0015–0017, pero no sustituye una comparación integral del esquema ni una auditoría independiente. El OID del marcador detecta una restauración lógica en otra base; una restauración física in situ requiere controles operativos adicionales. El operador debe demostrar aislamiento de conexiones y permisos mínimos del rol de migración. Las credenciales de principal/custodios se ingresan por TTY sin argumentos ni logs. La ausencia o corrupción del volumen de gate no se repara inventando un nonce: se exige restauración aislada y cuarentena.

Antes de actualizar Staging: aprobación del cambio y de Seguridad, imagen y SHA aprobados, backup verificado en una réplica aislada, inventario y versión real de ledger, epoch/nonce/OID registrados sin secretos, cero conexiones incompatibles, API/Web GEOPS detenidos y gate en `maintenance`. Ejecutar el recuperador interactivo una vez con solicitud nueva y dos custodios; ante fallo, mantener cerrado, investigar, y repetir con nueva autorización. Comprobar 17 checksums, auditoría, preservación de identidades/grants/sesiones, autenticación y autorización funcional antes de abrir tráfico. No usar `maintenance-finish`, SQL manual ni el instalador de reinstalación limpia.

**Decisión local:** implementación preparada para revisión; Staging sigue bloqueado hasta la evidencia y aprobaciones anteriores.
