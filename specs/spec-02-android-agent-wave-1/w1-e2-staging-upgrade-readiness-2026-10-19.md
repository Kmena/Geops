# W1-E2 — publicación y actualización propuesta de Staging

**Fecha:** 2026-10-19. **Base desplegada indicada por negocio:** `6f95241`. **Destino:** `codex/spec-02-wave-1`, con imagen etiquetada por el SHA que apruebe CI. Este documento prepara una ventana posterior; no autoriza ni ejecuta despliegue, instalación Android o GPS real.

## Decisión de compatibilidad

`git diff 6f95241 -- apps/api/src/db/migrations infrastructure/compose` no muestra migraciones ni cambios Compose para W1-E2. La base ya inicializada debería contener `0001`–`0014`, pero **su estado efectivo no se ha observado**. La actualización propuesta es exclusivamente de imágenes API/Web y conserva `geops_spec02_stage_pgdata`, `geops_spec02_stage_security`, `geops_spec02_stage_backups`, secretos, redes y el sitio Caddy/DuckDNS. No se ejecutan `geops-migrate`, `geops-gate-init`, `gate close` ni restauraciones sobre `geops_dev`.

La rama actual del migrador rechaza una migración de `geops_dev` con gate abierto. `closeGate` cambia el epoch externo; `gate open` solo permite una base aislada `geops_verify_*_restore` después de cuarentena. Por ello, **una futura actualización que añada migraciones queda bloqueada** hasta diseñar, probar y aprobar un modo de mantenimiento que cierre tráfico, preserve y verifique continuidad de epoch/base y reabra sin tratar un upgrade como un restore. No usar `gate init` para sortearlo. Si los checksums o el epoch de Staging difieren de `6f95241`, detener este plan y corregir primero la discrepancia.

## Preflight obligatorio de la ventana posterior

1. Registrar por canal restringido SHA de código/imagen actualmente desplegado, tag y digest API/Web, Compose efectivo, nombres de volúmenes y estado de salud. Confirmar que la PoC de la IP sigue en su sitio HTTPS independiente. No modificar Caddy, DuckDNS, puertos, redes ni contenedores de Inventori/Billing.
2. Consultar **solo lectura** el gate externo en `stage_security` y la fila `security_epoch` en `geops_dev`. Deben estar en fase `open` con el mismo epoch. Registrar un digest del archivo externo y conservar el volumen; no divulgar su contenido en logs de CI.
3. Comparar `geops_schema_migrations` contra los 14 nombres y SHA-256 de los archivos SQL del SHA destino; exigir igualdad exacta, sin versiones extras ni faltantes. Verificar PostGIS y ausencia de migración en curso. Una diferencia detiene la actualización.
4. Confirmar que el SHA destino tiene CI completo y escaneo de secretos aprobado. Ejecutar `docker compose --env-file infrastructure/compose/.env.staging -f infrastructure/compose/compose.staging.yaml config --quiet` con el tag candidato. Comprobar que los tres volúmenes y la red externa conservan sus nombres.
5. Ejecutar el servicio `geops-backup` existente y verificar SHA-256 del dump. Ensayar su restauración en una **base desechable aislada** y comparar migraciones y recuentos no sensibles. Conservar una copia protegida del gate/diario independiente; no usar esa copia para reabrir una restauración in situ. No continuar si la restauración de ensayo o la custodia de backup falla.

## Cambio de imágenes, solo tras autorización separada

Usar el mismo archivo Compose y un `GEOPS_STAGE_IMAGE_TAG` inmutable derivado del commit aprobado. Construir o adquirir imágenes API/Web del mismo SHA y comprobar sus digests. Durante una ventana con administrador disponible:

1. Detener únicamente `geops-web` y `geops-api`; dejar `geops-db`, volúmenes, red externa y Caddy intactos. Confirmar que el acceso Web de Staging queda aislado durante la sustitución.
2. **No ejecutar ningún servicio de mantenimiento de migración o gate.** Cambiar solo el tag de imagen en el archivo local ignorado, validar `compose config --quiet` y arrancar `geops-api` con `up -d --no-deps --no-build geops-api`; esperar `/health/ready`. Arrancar luego `geops-web` del mismo modo.
3. Releer gate y epoch: ambos deben coincidir exactamente con los valores previos. Confirmar que la tabla de migraciones sigue teniendo los mismos 14 pares versión/checksum. Si cualquiera cambia, aislar Staging y escalar; no intentar `gate init` ni restauración in situ.
4. Ejecutar smoke HTTPS en `geops-staging.duckdns.org`: raíz/assets/refresh, `/health/ready`, `/v1/*`, login/logout, cookie exclusiva Secure/HttpOnly, CSRF y Origin, 401/403/404/429, PoP, permisos, aislamiento tenant y logs sanitizados. Verificar que el sitio PoC en la IP conserva raíz, `/api/*` y `/health/*`. Los ensayos de registro GPS usan únicamente identidades y datos sintéticos autorizados.
5. Registrar go/no-go, hashes de imágenes, resultado de salud y auditoría. La primera instalación física y captura real requieren autorización y gate de privacidad separados.

## Rollback

Antes de aceptar nuevas inscripciones o datos GPS, si fallan API/Web o el smoke, detener solo esos dos servicios, restablecer el tag y digest anteriores y arrancarlos con el mismo Compose, sin tocar DB ni gate. Verificar `/health/ready`, UI, PoC, versión/checksum de 14 migraciones y epoch original. Como no hay cambio de esquema, este rollback de imágenes es el único permitido por este plan.

Si falla integridad, base, gate o restauración: detener API/Web y preservar los tres volúmenes, dump, journal y logs sanitizados. El [procedimiento de restore existente](staging-readiness-2026-10-19.md) **no permite reabrir `geops_dev` restaurada in situ**; se necesita un diseño y aprobación separados. No borrar volúmenes ni copiar un gate antiguo para forzar tráfico.

## Publicación y gates

- Publicar solo commits revisados en `codex/spec-02-wave-1`; no merge, tag, release ni despliegue por la publicación. El APK firmado y su keystore local están ignorados por Git; su transferencia y custodia deben aprobarse por separado.
- CI debe ejecutar Node/Web, contratos, Kotlin/JVM, Android debug y regresiones PostgreSQL/PostGIS, incluida inscripción; Android release firmado se verifica localmente. CI no prueba un teléfono ni el certificado TLS efectivo de Staging.
- **Readiness de actualización de imágenes:** `READY_WITH_CONDITIONS`, sujeto a preflight real, backup/restore de ensayo, CI y ventana autorizada. **Readiness físico/operativo:** `BLOCKED` por prueba Android, revisión independiente de seguridad/privacidad, atestación/MDM y E2E real. MDM-001–006 conservan sus requisitos originales.
