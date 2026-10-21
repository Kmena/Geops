# GEOPS Staging — reinstalación limpia 0001–0018

**Alcance autorizado:** descartar únicamente los datos de prueba y el gate anteriores de `geops-spec02-staging`. El respaldo `geops_spec02_stage_backups` permanece. Este procedimiento se ejecuta manualmente en Ubuntu después de publicar y aprobar el SHA; Codex no accede al servidor. No usar el procedimiento de recuperación 14–18 para esta reinstalación deliberada.

## Antes de la ventana

Confirmar fuera de banda que el respaldo existente ya tuvo checksum y restauración aislada satisfactorios, que los tres titulares de contraseñas nuevas están disponibles y que el descarte definitivo sigue autorizado. El script comprueba de nuevo que al menos un dump del volumen de respaldos tiene checksum válido y catálogo legible. Esto no sustituye el ensayo de restauración ya realizado.

El operador debe tener Docker Compose, Python 3, OpenSSL, `sha256sum`, `pg_restore` en la imagen PostGIS local, consola TTY privada y membresía vigente en el grupo exclusivo `geops-stage-secrets`. El archivo privado de variables Compose debe pertenecerle y tener modo 0600. Los seis secretos base existentes también deben pertenecerle y estar en modo 0600 o 0640 con el GID del grupo. Si falta uno de estos requisitos, `check` detiene el proceso. La red externa de Caddy se conserva; las redes internas deben tener las etiquetas de este proyecto y no tener consumidores ajenos.

## Actualizar el checkout sin tocar otros proyectos

Ejecutar como el operador `abi` en su sesión interactiva. Sustituir solo `<SHA_PUBLICADO>` y la ruta privada real del env existente. La clave SSH existente se usa únicamente para Git; no copiarla al repositorio.

```bash
set -Eeuo pipefail
cd /opt/geops-staging
sha='<SHA_PUBLICADO>'
STAGE_ENV='/ruta/privada/staging.env'
test -f "$STAGE_ENV" && test ! -L "$STAGE_ENV"
test -z "$(git status --porcelain)"
GIT_SSH_COMMAND='ssh -i /home/abi/.ssh/geops_deploy -o IdentitiesOnly=yes' \
  git fetch git@github.com:Kmena/Geops.git codex/geops-integration
test "$(git rev-parse FETCH_HEAD)" = "$sha"
git switch --detach "$sha"
test "$(git rev-parse HEAD)" = "$sha"
test -z "$(git status --porcelain)"
grep -Eq '^GEOPS_STAGE_IMAGE_TAG=[0-9a-f]{40}$' "$STAGE_ENV"
sed -i "s/^GEOPS_STAGE_IMAGE_TAG=.*/GEOPS_STAGE_IMAGE_TAG=$sha/" "$STAGE_ENV"
chmod 600 "$STAGE_ENV"
grep -Fx "GEOPS_STAGE_IMAGE_TAG=$sha" "$STAGE_ENV" >/dev/null
bash scripts/staging/clean-reinstall-0018.sh check "$sha" "$STAGE_ENV"
```

Revisar la salida: SHA exacto, seis servicios esperados y **solo** los volúmenes `geops_spec02_stage_pgdata` y `geops_spec02_stage_security` como descartables. `check` se puede repetir: no detiene servicios ni modifica volúmenes/redes/secretos persistentes; solo prueba lectura con contenedores temporales sin red. Rechaza checkout sucio, SHA incorrecto, volúmenes/redes ajenos, respaldo ausente o inválido, secretos expuestos y configuración MDM activa. No usar el override MDM.

## Descarte aprobado e inicialización

El siguiente comando **elimina definitivamente** los dos volúmenes anteriores. Solo ejecutarlo en la ventana aprobada después de revisar `check`:

```bash
bash scripts/staging/clean-reinstall-0018.sh reset "$sha" "$STAGE_ENV" DISCARD_ONLY_GEOPS_SPEC02_STAGING
```

El script detiene y elimina solo contenedores de los seis servicios GEOPS Staging, vuelve a comprobar la identidad de cada volumen, elimina únicamente DB y gate antiguos, rota seis secretos exclusivos, construye API/Web, inicia PostGIS, aplica 0001–0018, compara **nombres y checksums** del ledger con los 18 SQL publicados, comprueba estructura PostGIS/alertas/MDM y ausencia de identidades, inicializa gate nuevo y verifica `open` con epoch igual al de DB. **API y Web quedan detenidas.** No usa contraseñas antiguas, `maintenance-recover`, `down -v`, `prune` ni borra la red Caddy o el volumen de respaldos. Si falla, mantener API/Web detenidas y diagnosticar; no repetir `reset` ni abrir el gate manualmente.

```bash
dc=(docker compose --env-file "$STAGE_ENV" -f "$PWD/infrastructure/compose/compose.staging.yaml" --profile maintenance)
"${dc[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc \
  'SELECT count(*) FROM geops_schema_migrations'
"${dc[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc \
  'SELECT count(*) FROM admin_user; SELECT count(*) FROM recovery_custodian; SELECT count(*) FROM geops_device; SELECT epoch FROM security_epoch WHERE singleton=true'
"${dc[@]}" ps geops-api geops-web
```

Se esperan 18 migraciones, cero usuarios/custodios/dispositivos y exactamente un epoch. La verificación de checksums y correspondencia del gate ya es obligatoria dentro de `reset`.

## Bootstrap autorizado en TTY privado

Tres personas custodian tres contraseñas nuevas y distintas: administrador principal y dos custodios independientes. Se introducen en los prompts sin eco; no las ponga en argumentos, variables de entorno, archivos, tickets, capturas o logs. Usar correos autorizados y un motivo de auditoría concreto de 8–240 caracteres. Cada ceremonia usa UUID nuevo. Los custodios se requieren para el alta inicial y recuperación excepcional; la administración ordinaria posterior corresponde al principal por capacidades.

```bash
read -r -p 'Correo del administrador principal: ' principal
read -r -p 'Correo del primer custodio: ' custodio1
read -r -p 'Correo del segundo custodio: ' custodio2
read -r -p 'Motivo aprobado: ' motivo
test "$principal" != "$custodio1" && test "$principal" != "$custodio2" && test "$custodio1" != "$custodio2"
"${dc[@]}" run --rm --no-deps -i geops-api bootstrap "$principal"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES geops-api recovery provision "$custodio1"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES geops-api recovery provision "$custodio2"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES geops-api gps-capabilities grant-initial "$principal" "$custodio1" "$custodio2" "$(cat /proc/sys/kernel/random/uuid)" "$motivo"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES geops-api gps-capabilities establish-tenant "$principal" "$custodio1" "$custodio2" "$(cat /proc/sys/kernel/random/uuid)" "$motivo"
"${dc[@]}" exec -T geops-db psql -U geops_stage -d geops_dev -Atc \
  "SELECT (SELECT count(*) FROM admin_user WHERE state='ACTIVE'),(SELECT count(*) FROM recovery_custodian WHERE state='ACTIVE'),(SELECT count(*) FROM admin_permission WHERE revoked_at IS NULL),(SELECT count(*) FROM geops_operating_tenant WHERE tenant_id='synthetic')"
```

Resultado esperado: `1|2|10|1`. `grant-initial` asigna las diez capacidades solo al principal; `establish-tenant` crea el tenant único `synthetic` y sus accesos. Ambos comandos requieren las tres contraseñas y auditan la ceremonia. No usar SQL manual para crear o conceder permisos. Si alguna ceremonia falla, no iniciar API/Web hasta resolverla mediante los comandos autorizados.

## Arranque y aceptación funcional

```bash
"${dc[@]}" up -d --wait geops-api geops-web
"${dc[@]}" ps geops-db geops-api geops-web
curl --fail --silent --show-error https://geops-staging.duckdns.org/health/ready
curl --silent --show-error -o /dev/null -w '%{http_code}\n' https://geops-staging.duckdns.org/v1/admin/auth/me
curl --silent --show-error -o /dev/null -w '%{http_code}\n' https://geops-staging.duckdns.org/v1/admin/mdm/status
```

Sin sesión, los dos endpoints administrativos deben dar 401. En navegador autenticado, verificar login, diez capacidades y `tenant_ids:["synthetic"]`, Usuarios y permisos, creación de política DRAFT con horario, inventario/registro sintético, vistas de dispositivos/sesiones y alertas de continuidad. Verificar que MDM no aparece en Web, que sus siete endpoints devuelven 503 `mdm_disabled` **con sesión válida**, que no hay solicitudes OAuth ni sincronización, y que no hay nuevos puertos públicos. La prueba funcional no debe usar teléfono ni GPS real. Comprobar por separado que la PoC sigue respondiendo en su URL; no modificar Caddy, Inventori ni Billing.

El éxito de salud de contenedores o de CI no sustituye estas comprobaciones de navegador. No declarar PASS_STAGING antes de completarlas.
