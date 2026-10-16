# Desarrollo local de GEOPS Wave 0A

Solo se permiten datos sintéticos. La API Wave 0A no carga `apps/api/.env.local`, rechaza variables OAuth y siempre instancia `FakeMdmProvider`. El diagnóstico OAuth heredado usa otro proceso y no participa en esta wave. SPEC-00 sigue BLOCKED.

## Preparación

En la raíz de GEOPS, con Node 24, npm y Docker Desktop Linux:

```powershell
npm ci --ignore-scripts
npm run contracts:check
npm run lint
npm run typecheck
npm test
npm run build
node scripts/create-local-compose-env.mjs
```

El generador añade únicamente claves sintéticas faltantes al archivo ignorado `infrastructure/compose/.env.local` sin imprimirlas. No copiar credenciales OAuth de `apps/api/.env.local` a Compose. Ambos archivos locales están ignorados y no rastreados por Git.

Comprobar inmediatamente antes del primer arranque que 3500 y 3501 estén libres:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3500,3501 -ErrorAction SilentlyContinue
```

Si otro servicio ocupa un puerto, no detenerlo automáticamente; ajustar el entorno GEOPS de forma explícita.

## Arranque

```powershell
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml config --quiet
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml up -d --build
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml ps --all
```

API: `http://127.0.0.1:3500/health/live` y `/health/ready`; Web: `http://127.0.0.1:3501/`. PostgreSQL no publica puerto. El migrador debe terminar con exit 0 y API/DB/Web aparecer sanos. Los nombres `geops-wave0a`/`geops_wave0a_*` aíslan contenedores, red y volumen.

Para crear el primer administrador **ficticio**, seguir [admin-recovery.md](../operations/admin-recovery.md); el comando interactivo no muestra contraseña. La consola solo contiene inventario GEOPS y MDM fake. La invitación, la activación y la rotación de identidad se prueban con scripts en DB desechable, no con Android.

## Pruebas de integración

`apps/api/test/integration-smoke.mjs` y `identity-edge.mjs` leen exclusivamente la configuración sintética del contenedor API y exigen una base nueva llamada `geops_verify_<timestamp>`. Crear la base aislada en el contenedor GEOPS, copiar el script a `/work/apps/api/test` y ejecutarlo con `GEOPS_TEST_DB` apuntando a ella. No ejecutarlos sobre `geops_dev`; el bootstrap inicial es único. La evidencia sanitizada y las limitaciones están en [T06–T18](../../specs/spec-01-foundation-wave-0a/implementation-evidence-T06-T18.md). Para restore, seguir [runbook](../operations/backup-restore-synthetic.md).

Para detener solo GEOPS sin borrar el volumen:

```powershell
docker compose --env-file infrastructure/compose/.env.local -f infrastructure/compose/compose.dev.yaml down
```

Una prueba fake no valida ManageEngine Free, Android Keystore ni seguridad operativa de la identidad.
