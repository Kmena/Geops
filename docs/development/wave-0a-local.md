# Desarrollo local de GEOPS Wave 0A (T01–T05)

Este entorno es exclusivo para datos sintéticos. No cargar `apps/api/.env.local`, no iniciar el diagnóstico OAuth en el mismo puerto 3500 y no conectar ManageEngine. La API fundacional solo implementa `/health/live` y `/health/ready`; las demás rutas de `packages/api-contracts/openapi.yaml` pertenecen a tareas posteriores.

## Preparación

En la raíz de `geops`, con Node 24, npm y Docker Desktop Linux activos:

```powershell
npm ci --ignore-scripts
npm run contracts:check
npm run lint
npm run typecheck
npm test
npm run build
node scripts/create-local-compose-env.mjs
```

El último comando crea una clave aleatoria de base **solo sintética** en `infrastructure/compose/.env.local`, sin mostrarla; si ya existe, la conserva. El archivo y `apps/api/.env.local` están ignorados por Git. No copiar credenciales OAuth al archivo Compose.

Comprobar inmediatamente antes de iniciar que 3500 y 3501 están libres:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3500,3501 -ErrorAction SilentlyContinue
```

Si aparece otro proceso, liberar el puerto o elegir otro puerto local revisando la configuración. No detener servicios ajenos de forma automática.

## Arranque y comprobación

```powershell
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml config --quiet
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml build
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml up -d --no-build
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml ps --all
```

API: `http://127.0.0.1:3500/health/live` y `/health/ready`. Web placeholder: `http://127.0.0.1:3501/`; salud Web: `/health`. La base PostGIS no publica puerto host. El job `geops-migrate` debe terminar con exit 0; ready devuelve 503 si la base o la versión/checksum de migración falla. Los contenedores, volumen y red tienen nombres `geops-wave0a`/`geops_wave0a_*`.

Para detener solo GEOPS sin borrar el volumen:

```powershell
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml down
```

La validación local P03/P04 y sus límites están en [evidencia T01–T05](../../specs/spec-01-foundation-wave-0a/implementation-evidence-T01-T05.md). Un resultado sintético no cierra SPEC-00, Free, Android ni producción.
