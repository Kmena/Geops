# Actualización supervisada de GEOPS Staging: 0018 → 0021

Este procedimiento se ejecuta **manualmente por SSH** en `/opt/geops-staging`. El script [upgrade.sh](upgrade.sh) solo actúa sobre el proyecto Compose `geops-spec02-staging`, su base `geops_dev` y los servicios existentes. Versión de aplicación objetivo: `03e582fba66c0d29eab885e109d3404e86b140a3`. El commit que contiene este procedimiento es descendiente de esa versión; el script comprueba que el código API/Web, contratos, Dockerfiles y Compose permanezcan idénticos al commit objetivo. Nunca crea una base nueva ni elimina volúmenes.

La condición de entrada comunicada por el operador es: versión `90ab9e9f` en ejecución, 18 migraciones, API/Web nuevos ya construidos, backup creado y restaurado satisfactoriamente, MDM deshabilitado. **El script vuelve a comprobar** SHA, configuración Compose, IDs aprobados de imágenes, catálogo SQL embebido, ledger/checksums, gate y epoch. El respaldo restaurado y la aprobación de los IDs de imágenes son evidencias externas: el argumento literal `CONFIRMED` registra la confirmación humana, no sustituye esos documentos.

## Preparación SSH

1. Obtener la ventana de cambio y la aprobación de Seguridad, administrador y dos custodios. Registrar fuera del repositorio el reporte de backup/restauración y los IDs de las imágenes aprobadas (`sha256:...`). Si falta una de estas evidencias, detenerse.
2. En `/opt/geops-staging`, usar un checkout **limpio** del commit que contiene `upgrade.sh`. No usar `reset --hard` ni `git clean` para fabricar limpieza. El script admite detached HEAD y exige que `03e582f...` sea ancestro sin cambios en el código de aplicación/Compose correspondiente.
3. Verificar que `infrastructure/compose/.env.staging` pertenezca al operador, sea privado (sin permisos de grupo/otros) y configure `GEOPS_STAGE_IMAGE_TAG=03e582fba66c0d29eab885e109d3404e86b140a3`. La imagen API y Web deben existir localmente con ese tag. No incluir contraseñas en este archivo para la ceremonia; el CLI las solicita sin eco.
4. Verificar por separado el origen de los IDs aprobados; un tag Docker por sí solo es mutable. No aceptar IDs copiados únicamente de la misma consulta local que se pretende verificar.

Ejemplo de variables **no secretas** en la sesión SSH (sustituir los dos IDs por los aprobados):

```bash
cd /opt/geops-staging
API_IMAGE_ID='sha256:<64 hex de la imagen API aprobada>'
WEB_IMAGE_ID='sha256:<64 hex de la imagen Web aprobada>'
scripts/staging/upgrade.sh check "$API_IMAGE_ID" "$WEB_IMAGE_ID"
```

`check` exige gate `open`, exactamente 18 filas de ledger y API/Web en ejecución con tags `90ab9e9f…`; no detiene servicios. También comprueba que las imágenes nuevas tienen IDs distintos y que la imagen API contiene exactamente los 21 SQL del checkout, con sus SHA-256. Si falla, no iniciar la actualización.

## Aplicación

Con preflight satisfactorio, un UUID nuevo para esta ceremonia y motivo de 8–240 caracteres:

```bash
REQUEST_ID=$(uuidgen)
scripts/staging/upgrade.sh apply "$API_IMAGE_ID" "$WEB_IMAGE_ID" \
  "$REQUEST_ID" 'admin@example.invalid' 'custodian-1@example.invalid' \
  'custodian-2@example.invalid' 'Actualizacion supervisada GEOPS Staging 0018 a 0021' CONFIRMED
```

Sustituir los correos de ejemplo por las identidades reales autorizadas. El script detiene `geops-web` y `geops-api`, exige cero conexiones ajenas a `geops_dev`, inicia `maintenance-start` con el **epoch existente** y verifica el marcador. Luego invoca **interactivamente** `geops-gate-init maintenance-recover` desde la imagen API nueva; el CLI solicita la contraseña del administrador y las de los dos custodios sin eco. No pasarlas por argumentos, variables, historial, logs o ficheros.

El recuperador existente comprueba credenciales, autorización, identidad de base, epoch/nonce/OID, estructura e inventario; aplica **0019, 0020 y 0021** una a una con transacciones y checksums, audita y solo entonces abre el gate. El script comprueba nuevamente las 21 filas y el epoch, arranca API y después Web con los IDs aprobados y espera sus healthchecks. La salida `Local checks PASS` **no** declara Staging aceptado.

Tras la salida satisfactoria, el operador verifica HTTPS, login administrativo, lectura de políticas/asignaciones, dispositivos, sesiones/posiciones, alertas GPS, autenticación y autorización por tenant, y que MDM permanezca deshabilitado. Registrar tiempos, códigos y recuentos sin contraseñas, tokens ni coordenadas. No activar ManageEngine. Las pruebas físicas POCO/Huawei son una puerta distinta.

## Reanudación y fallos

Si el proceso se interrumpe con gate `maintenance`, API/Web detenidas y ledger íntegro de 18, 19, 20 o 21 migraciones, diagnosticar primero el fallo. Usar **otro UUID y una ceremonia completa**:

```bash
REQUEST_ID=$(uuidgen)
scripts/staging/upgrade.sh resume "$API_IMAGE_ID" "$WEB_IMAGE_ID" \
  "$REQUEST_ID" 'admin@example.invalid' 'custodian-1@example.invalid' \
  'custodian-2@example.invalid' 'Reanudacion autorizada GEOPS Staging 0018 a 0021' CONFIRMED
```

`resume` no repite `maintenance-start`; el recuperador retoma exclusivamente migraciones faltantes. Un checksum incorrecto, objeto parcial, epoch distinto, nonce/OID no coincidente, conexión ajena o credencial inválida detiene la ceremonia. No ejecutar `geops-migrate` ni `maintenance-finish` por separado; tampoco abrir el gate a mano.

Ante error posterior a la apertura, el script detiene Web/API y trata de devolver el gate a `maintenance` con el mecanismo existente. Si la base no permite esa verificación, usa `gate close` como último recurso: **rota el epoch externo y bloquea tráfico**. Ese estado `closed` no admite `resume`; requiere un plan de restauración/reconciliación supervisado y autorización independiente. Si tampoco puede confirmar el cierre, imprime `CRITICAL`; mantener Web/API detenidas y escalar sin reiniciarlas.

No volver al binario `90ab9e9f` después de confirmar migraciones nuevas. No restaurar un backup encima de `geops_dev`, copiar un gate antiguo, borrar volúmenes, usar `docker compose down -v`, reiniciar otros proyectos ni modificar producción. Una corrección se aplica hacia delante; la restauración se ensaya aparte con cuarentena, epoch y credenciales nuevos según el procedimiento existente.

## Condiciones de detención

- SHA objetivo ausente, checkout sucio, código de aplicación/Compose diferente, imágenes o IDs no aprobados.
- Proyecto, redes, volúmenes, `MDM_ENABLED=false` o ruta de configuración diferentes de lo esperado.
- Backup/restauración no acreditados; administrador o dos custodios no disponibles.
- Gate/epoch/ledger/checksums distintos de la línea base o conexiones ajenas a PostgreSQL.
- Error en migración, recuperación, salud API/Web, marcador o verificación funcional posterior.

Los ensayos locales con Docker/PostGIS prueban el procedimiento en datos descartables; no certifican la topología, secretos, imágenes aprobadas ni estado real de Staging. Codex no accede al servidor AWS y no ha desplegado esta actualización.

## Ensayo local del 21/10/2026

- Bash Linux dentro de `node:24`, repositorio montado en solo lectura: `bash -n scripts/staging/upgrade.sh` **PASS**. `sh -n infrastructure/staging/api-entrypoint.sh` y `git diff --check` **PASS**.
- `docker compose config --format json` con `.env.staging` temporal **sin secretos**: nombre, servicios, tag objetivo y `MDM_ENABLED=false` correctos. Ese archivo temporal fue retirado.
- Imagen API local etiquetada con el SHA objetivo: los **21 nombres y SHA-256** de SQL embebidos coincidieron con el checkout. Este control no acredita por sí solo la procedencia de la imagen; por eso el script exige IDs aprobados aparte.
- Contenedor local `postgis/postgis:18-3.6` con puerto efímero en `127.0.0.1`, sin volumen nombrado y con autenticación `trust` solo para el ensayo. Se preparó `geops_verify_20261021` con esquema **18** y datos sintéticos; `maintenance-recovery-versions.integration.mjs 18` terminó **PASS**. La prueba inyecta checksum 0018 incorrecto e índice faltante y comprueba que el gate permanece cerrado; después ejecuta 0019→0021, preserva identidad/epoch y verifica rechazo de replay. Lectura final: 21 migraciones y PostGIS disponible. El contenedor se detuvo con `--rm` y no quedaron contenedores/volúmenes Staging locales.
- El wrapper `upgrade.sh apply/resume` **no se ejecutó extremo a extremo**: no se construyó una réplica de toda la topología Compose de Staging ni se usaron identidades/custodios reales. Los controles de orquestación y reapertura requieren un ensayo sobre una réplica aislada y revisión operacional antes de ejecutar por SSH. Este límite no se presenta como PASS de Staging.
