# W6-R2 — Plan de promoción staging 0040 → 0042

**Promoción no autorizada ni ejecutada.** La preparación conserva el origen de aplicación `809bb0678feaefdbbe8006a1ba05325ccb1ad0a8`; los commits posteriores cambian solo CI/runner y documentos. El manifiesto estructurado está en [JSON](WAVE6-R2-GHCR-RELEASE-MANIFEST.json). Proyecto `geops-spec02-staging`; API/Web/DB reportados healthy, gate `open`, ledger 0040. Antes de solicitar aprobación hacen falta inventario privilegiado, backup/restore real y ensayo del operador con migración.

## Gates previos obligatorios

1. Reconfirmar estado remoto inmediatamente antes de ventana: gate, tres health, digests, 40 filas/checksums, recursos, ausencia de despliegue concurrente. Corroborar labels OCI de imágenes activas y configuración efectiva.
2. CI remoto PASS del SHA fuente, E2E PASS y API/Web candidatos publicados por digest `linux/amd64`; verificar labels `org.opencontainers.image.revision` y los 42 SQL empaquetados.
3. Respaldo fresco de staging, tamaño/SHA-256, `pg_restore --list` y restauración real aislada; ensayo 0040→0042 y funcional con imágenes candidatas. Registrar tiempos y espacio necesario.
4. Verificar que el controlador simple instalado soporta mantenimiento 0040→0042, gate, backup, migración y recuperación. Un deploy previo 0040→0040 no lo prueba. Documentar comando exacto de manifiesto y retorno tras revisión del operador.
5. Aprobación independiente del usuario para staging. Mantener `mdm_write_disabled`; no cambiar políticas, APK ni GPS.

## Secuencia futura durante ventana aprobada

Con operador existente, bloquear nuevas escrituras mediante gate y drenar ingesta, registrar epoch/conteos, generar backup fresco protegido, fijar imágenes antiguas y nuevas por digest, aplicar 0041 y 0042 con el mecanismo supervisado, verificar ledger 42/checksums y arrancar API/Web candidatos. Ejecutar smoke antes de reabrir gate. Medir cada fase. No usar `docker compose down`, `prune`, borrado de volúmenes ni downgrade SQL. Si falla antes de migrar, restaurar imágenes previas con DB 0040; después de migrar, mantener gate cerrado y recuperar hacia adelante o restaurar el dump 0040 validado con decisión explícita sobre escrituras posteriores. La imagen 0040 no es rollback suficiente sobre DB 0042.

## Smoke posterior, todavía NOT_RUN

| Capa | Prueba y criterio |
| --- | --- |
| Runtime | Controlador `status`: API/Web/DB healthy, refs por digest exactas, proyecto y gate esperados; API interna `/health/ready` JSON `status=ok` y Web `/health` 200. El `/health/ready` HTTPS público observado es SPA y no sirve. |
| DB | PostgreSQL/PostGIS efectivos, 42 filas ledger con checksums exactos, constraints/índices/triggers 0041/0042, conteos base estables. |
| Contratos sin sesión | Rutas existentes y SPEC-05 devuelven el rechazo autenticado esperado; ausencia de 404. Esto solo verifica existencia/auth, no funcionalidad. |
| Auth/RBAC | Login de administrador de laboratorio autorizado; lectura de diagnósticos y workspace con permiso/tenant; rechazo con usuario sin permiso y tenant ajeno. Sesión reciente/CSRF para preview/solicitud, sin escribir en ManageEngine. |
| GPS/diagnóstico | Identidad PoP de laboratorio, envío GPS v2 y ACK/idempotencia; envío de snapshot, lectura admin y timeline correlacionados. No usar ubicación real ni comandar teléfonos. |
| MDM | Consulta de dispositivos y permisos según fuente; `UNKNOWN` cuando no hay tenant real; preview/solicitud bajo RBAC; envío operativo responde `mdm_write_disabled`. |

Las pruebas autenticadas requieren cuentas de laboratorio y fixture autorizadas dentro de staging; registrar respuesta, hora UTC y correlación sin tokens/PII. HTTP 401 sin sesión no constituye PASS funcional. ManageEngine real y Moto G06 continúan pendientes independientes; no bloquean preparar imágenes, pero sí la afirmación de causa raíz GPS o producción.

## Solicitud separada de autorización, preparada pero no presentada

**Destino futuro:** promoción staging del proyecto `geops-spec02-staging`, esquema 0040→0042. **Fuente:** `809bb0678feaefdbbe8006a1ba05325ccb1ad0a8`. **CI:** [run 46164447870](https://github.com/Kmena/Geops/actions/runs/46164447870) PASS. **API/Web candidatas:** digests inmutables del [manifiesto](WAVE6-R2-GHCR-RELEASE-MANIFEST.json); imágenes actuales y hash de ledger 0040 también allí. **Backup real:** PENDIENTE. **Restore/migración aislados:** PENDIENTE. **Ledger fila por fila y labels activos:** PENDIENTE. **Comando de operador probado 0040→0042, ventana y tiempos:** PENDIENTE. **Recuperación:** gate cerrado, avance supervisado o restauración del dump validado con decisión explícita sobre escrituras posteriores.

Presentar esta solicitud al usuario **solo** cuando esos campos tengan evidencia y `STAGING_PROMOTION_READY=PASS`. La presente documentación no autoriza `deploy`.
