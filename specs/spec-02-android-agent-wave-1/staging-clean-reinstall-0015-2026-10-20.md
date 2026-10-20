# GEOPS Staging — reinstalación limpia con 0015

**Estado:** procedimiento preparado; migraciones y flujos funcionales probados solo con recursos desechables. El script completo no se ejecutó contra Staging. No se accedió a AWS. La decisión del propietario permite descartar la base, el administrador, el gate y la configuración exclusivos de GEOPS Staging. Ejecutar únicamente en una ventana de despliegue autorizada y con un SHA publicado y aprobado. El ensayo de actualización 0014→0015 ya no forma parte de esta reinstalación.

## Alcance exacto

- Proyecto Compose: `geops-spec02-staging`. Solo se detienen sus seis servicios. Caddy sigue en el proyecto de la PoC y la red externa `geops_spec02_stage_edge` permanece.
- Solo se eliminan `geops_spec02_stage_pgdata` y `geops_spec02_stage_security`, tras comprobar sus etiquetas Compose y que ningún contenedor de otro proyecto los monte. `geops_spec02_stage_backups` permanece intacto. No se usa `docker compose down -v`, `prune` ni borrado de redes.
- Se reemplazan los seis archivos de secretos propios de Staging en `infrastructure/compose/.local/staging/secrets`, una vez detenido el servicio. Permanecen propiedad del operador y son legibles solo por él y un grupo dedicado. No se modifican certificados, claves de Caddy, PoC, Inventori, Billing ni MDM.
- El script exige Docker local por socket Unix, SHA exacto, árbol limpio, origen HTTPS y nombre de proyecto esperados. Acepta un checkout con detached HEAD. `check` solo crea contenedores temporales sin red para probar la lectura de secretos; no modifica recursos persistentes. `reset` requiere el marcador literal de descarte. Si una identidad de recurso no coincide, se detiene.

## Preparación en Ubuntu, tras autorización

El operador debe tener una consola privada con TTY, Docker Compose, Python 3, OpenSSL y el checkout del SHA aprobado. Mantener el archivo env privado (modo 0600) con `GEOPS_STAGE_IMAGE_TAG=<SHA aprobado>`, `GEOPS_STAGE_ORIGIN=https://geops-staging.duckdns.org` y `GEOPS_STAGE_SECRET_GID=<GID del grupo dedicado>`. Crear previamente el grupo local `geops-stage-secrets` con un GID libre entre 2000 y 60000, añadir **solo** al operador y abrir una nueva sesión para activar su membresía. No debe ser grupo primario de otra cuenta. Por ejemplo, si 24001 está libre: `sudo groupadd --gid 24001 geops-stage-secrets` y `sudo usermod -aG geops-stage-secrets abi`; comprobar `getent group geops-stage-secrets` e `id -G` tras volver a iniciar sesión. El script rechazará cualquier diferencia de GID o membresía.

Los directorios `.local`, `.local/staging` y `.local/staging/secrets` siguen perteneciendo al operador y con permisos 0700. Los seis secretos existentes pueden estar en modo 0600; después de la rotación serán propiedad del operador, grupo dedicado y modo **0640**. Compose añade ese grupo únicamente a DB, API, migrador, gate y backup; Web no recibe secretos. Los archivos basados en `file:` se montan directamente, por lo que declarar `uid`, `gid` o `mode` en `secrets:` no corregiría sus permisos. El script rechaza enlaces simbólicos y comprueba la lectura real desde contenedores temporales como UID 1000 (Node) y UID 999 (PostgreSQL) antes de detener servicios, y de nuevo tras rotar los secretos. Confirmar fuera de banda que los dos custodios serán personas distintas y que pueden custodiar sus contraseñas.

```bash
cd /ruta/privada/Geops
sha=$(git rev-parse HEAD)
env_file=/ruta/privada/staging.env
bash scripts/staging/clean-reinstall-0015.sh check "$sha" "$env_file"
```

Examinar la salida de `check`, la lista exacta de recursos y el SHA aprobado. Después de la autorización de la ventana:

```bash
bash scripts/staging/clean-reinstall-0015.sh reset "$sha" "$env_file" DISCARD_ONLY_GEOPS_SPEC02_STAGING
```

El script detiene solo los servicios Compose de GEOPS Staging, elimina únicamente sus volúmenes de DB y gate, rota sus secretos, construye API/Web, arranca PostgreSQL, aplica **0001–0015** desde cero, comprueba 15 filas de migración y ausencia de identidades, e inicializa un gate nuevo. **Deja API y Web detenidas** para realizar el bootstrap autorizado. Si una etapa falla, no iniciar API/Web ni repetir `reset` sin inspeccionar el estado. Ninguna de estas instrucciones fue ejecutada en el servidor por Codex.

## Bootstrap interactivo y arranque

Utilizar correos individuales aprobados y un motivo de auditoría concreto de 8 a 240 caracteres. Las contraseñas se introducen en TTY; nunca como argumentos, variables de entorno, tickets o comandos guardados. Cada ceremonia usa un UUID nuevo. `docker compose run -i` conserva stdin y asigna TTY cuando se ejecuta desde una terminal interactiva; no usar `-T`.

```bash
dc=(docker compose --env-file "$env_file" -f "$PWD/infrastructure/compose/compose.staging.yaml" --profile maintenance)
read -r -p 'Correo del administrador principal: ' principal
read -r -p 'Correo del primer custodio: ' custodio1
read -r -p 'Correo del segundo custodio: ' custodio2
read -r -p 'Motivo aprobado: ' motivo

"${dc[@]}" run --rm --no-deps -i geops-api bootstrap "$principal"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES geops-api recovery provision "$custodio1"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES geops-api recovery provision "$custodio2"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES geops-api gps-capabilities grant-initial "$principal" "$custodio1" "$custodio2" "$(cat /proc/sys/kernel/random/uuid)" "$motivo"
"${dc[@]}" run --rm --no-deps -i -e GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY=YES geops-api gps-capabilities establish-tenant "$principal" "$custodio1" "$custodio2" "$(cat /proc/sys/kernel/random/uuid)" "$motivo"
"${dc[@]}" up -d --wait geops-api geops-web
```

`grant-initial` concede las diez capacidades, incluida `gps.user.manage`, solo al principal. `establish-tenant` crea exactamente `synthetic` y concede al principal acceso de datos y salud. La API permite después crear usuarios con distintos subconjuntos de capacidades y acceso tenant independiente. No crear un segundo administrador para estas operaciones ordinarias. Los custodios siguen siendo necesarios para la ceremonia inicial y recuperación excepcional. No usar SQL para conceder permisos.

## Comprobación funcional de la ventana

1. Confirmar que `https://geops-staging.duckdns.org/` responde por HTTPS y que la PoC sigue en `https://18.209.159.208/`. Una petición sin sesión a `/v1/admin/auth/me` debe devolver 401. Confirmar que DB/API/Web están saludables y que no se publicaron puertos nuevos.
2. Iniciar sesión en GEOPS Web con el principal. `/v1/admin/gps-capabilities` debe devolver las diez capacidades, incluida `gps.user.manage`, y `tenant_ids:["synthetic"]`. `/v1/admin/users` debe mostrar la cuenta principal; denegaciones 401/403 deben conservarse.
3. En **Usuarios y permisos**, crear un usuario sintético bloqueado, entregar su invitación por canal privado, activarlo con contraseña propia, concederle dos capacidades concretas y luego revocar una. Confirmar la diferencia de acceso con su propia sesión y la auditoría. No usar correos o tokens reales en capturas.
4. Crear una política GPS de prueba en DRAFT con zona IANA, días, horas y frecuencias; editar una versión, consultar historial y verificar que una acción sin `gps.policy.write` recibe 403. No asignar capturas reales.
5. Registrar un dispositivo **sintético** como borrador y generar una invitación; verificar que solo `gps.installation.manage` permite hacerlo y que el token no aparece en URL ni logs. No instalar APK ni usar teléfono.
6. Abrir el dashboard y las vistas de sesiones/salud. Verificar estado vacío o sintético identificable, sin presentar GPS observado inexistente como dato real. Probar refresh y cierre de sesión. Si cualquiera de estas funciones falla, **no declarar éxito operativo** por la salud de contenedores.

## Validación previa de Codex

Build, typecheck, contratos, pruebas Node/Web, lint y escaneo de secretos pasaron; lint informó 12 advertencias existentes. Compose y Caddy pasaron sus comprobaciones estáticas y la prueba local aislada de rutas. PostgreSQL/PostGIS desechable aplicó las 15 migraciones desde cero, creó un gate nuevo y pasó las suites sintéticas de políticas, inscripción, capacidades, usuarios y tenant. Kotlin/JVM `syntheticTest` también pasó. El script pasó `bash -n`; el preflight se ensayó con detached HEAD y SHA exacto, y la lectura de archivos de modo 0640 se comprobó desde contenedores con los UID previstos. El flujo destructivo `reset` de Ubuntu no se ejecutó. La prueba manual HTTPS, las ceremonias interactivas y el navegador quedan para la ventana autorizada. Publicar este procedimiento no autoriza el despliegue por sí mismo.
