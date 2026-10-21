# GEOPS — Revisión focalizada de seguridad MDM

**Base:** `90ab9e9f10f6377e739e8bb64da9aef378c59fe2`. **Rama:** `codex/geops-mdm-security`. **Alcance:** hallazgos de desconexión, sincronización, respuestas del proveedor y login administrativo. Esta revisión de implementación no sustituye la auditoría independiente ni autoriza activar ManageEngine.

## Cambios y controles

| Hallazgo | Corrección | Evidencia sintética | Riesgo residual |
| --- | --- | --- | --- |
| Desconexión solo en memoria | `mdm_connection_control` guarda `DISCONNECTING` antes de la llamada remota. Un advisory lock compartido cubre cada consulta, refresh y sincronización; el exclusivo espera operaciones en curso y bloquea las nuevas. El digest del grant anterior impide reutilizarlo tras reinicio. Reconexión exige grant distinto verificado, sesión, CSRF, capacidad, tenant y motivo; la auditoría conserva solo el hash del motivo. | `mdm-security.integration.mjs`: revocación fallida, reinicio, operación concurrente, repetición, rotación, permisos y ruta HTTP. | P2: si la revocación remota tuvo éxito pero falló el registro local de ese resultado, el estado queda cerrado y exige reconciliación supervisada; nunca se reactiva automáticamente. Retener de forma privada el grant anterior hasta confirmar revocación. |
| Caché parcial tras fallo | El recorrido y los detalles se reúnen antes de mutar la caché. La publicación es una transacción. `RUNNING`, `SUCCESS`, `PARTIAL` y `FAILED` distinguen intento incompleto de inventario válido. IDs duplicados entre páginas, bucles y límites rechazan el run. No se borran registros por ausencia. | `mdm-inventory.integration.mjs`: fallo en páginas, duplicados, concurrencia, caché preservada, reintento y página vacía válida. | P2: el proveedor puede cambiar su semántica de paginación; exige validación real antes de activar. |
| Respuesta sin cota | Máximo 1 MiB por respuesta, 100 elementos por página, 200 páginas y 5000 IDs Android relevantes por recorrido, más timeout. Se cancela el stream al superar la cota. Errores y auditoría solo registran códigos saneados, nunca payloads ni tokens. | `mdm-real.test.ts`: JSON inválido, tamaño declarado, transferencia fragmentada, duplicados, timeout y 5xx. | P3: un chunk único ya entregado por la pila HTTP puede superar temporalmente la cota antes de cancelarse; la respuesta no se concatena ni procesa. |
| Login limitado solo en memoria | `admin_login_limit` persiste contadores HMAC de cuenta/IP en PostgreSQL. Advisory locks serializan intentos entre procesos; bloqueo temporal máximo de 15 minutos y expiración a 30 minutos. | `mdm-security.integration.mjs`: cinco fallos, reinicio de servicio, 10 intentos concurrentes, IP distinta, caducidad y login correcto. | P2: detrás de un proxy, varios usuarios pueden compartir la IP observada y sufrir un bloqueo temporal común; revisar la fuente de IP confiable antes de activar MDM real. |

## Esquema y compatibilidad

`0019_mdm_security.sql` es aditiva para datos e identidades existentes. Cambia la restricción de `mdm_sync_run.outcome` para aceptar `PARTIAL` y añade dos tablas. El catálogo de recuperación supervisada reconoce 0014–0019 y comprueba estructuras, checksums, epoch y gate antes de reabrir. La API nueva requiere 0019 para el login; no debe ejecutarse sobre una base 0018. El procedimiento histórico `clean-reinstall-0018.sh` queda para su versión anterior y **no** es un procedimiento de despliegue de esta rama.

La configuración predeterminada conserva `MDM_ENABLED=false`: no se carga OAuth ni se sincroniza MDM. GEOPS permanece single-tenant (`synthetic`); no se certifica aislamiento multiempresa. Las identidades y sesiones GPS no dependen del vínculo de inventario ManageEngine.

## Puertas pendientes

1. CI de la rama publicada, incluida la ejecución real de los dos tests MDM/PostGIS nuevos.
2. Revisión independiente de la ceremonia de reconexión y de la procedencia de IP detrás del proxy.
3. Plan de migración 0018→0019 con gate cerrado y procedimiento de imagen compatible, antes de cualquier Staging futuro.
4. Verificación real de OAuth, edición/licencia y paginación ManageEngine con secretos de prueba, en un entorno autorizado separado.
5. Pruebas físicas para MDM-001…006. Ninguna de estas correcciones demuestra control de Android por MDM.

No se accedió a Staging ni a teléfonos durante este frente; las pruebas usaron datos sintéticos y PostgreSQL/PostGIS descartable.
