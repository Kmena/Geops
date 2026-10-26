# Local-only, synthetic, disposable PostgreSQL/PostGIS migration matrix.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$compose = Join-Path $root 'infrastructure/compose/compose.spec03-release-lab.yaml'
$project = "geops-spec03-release-$PID"
$env:GEOPS_LAB_PG_PORT = '55446'
$started = $false
Push-Location -LiteralPath $root
try {
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Cached PostGIS image required; no pull attempted.' }
  $started = $true
  & docker compose -p $project -f $compose up -d --no-build --pull never --wait --wait-timeout 120
  if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated Compose lab.' }
  $scenarios = @(
    @{ Name='fresh'; File=$null },
    @{ Name='b23'; File='apps/api/test/spec03-mdm-upgrade.integration.mjs' },
    @{ Name='b27'; File='apps/api/test/agent-device-upgrade.integration.mjs' },
    @{ Name='poco-continuity'; File='apps/api/test/gps-continuity.integration.mjs'; Init=$true }
  )
  foreach ($scenario in $scenarios) {
    $database = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss') + ([int](Get-Random -Minimum 10 -Maximum 99))
    & docker compose -p $project -f $compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create disposable $($scenario.Name) database." }
    $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:$($env:GEOPS_LAB_PG_PORT)/$database"
    $env:GEOPS_DATA_MODE = 'synthetic'
    if ($scenario.Init) {
      & node --import tsx scripts/deploy/spec03-fresh-migration.mjs
      if ($LASTEXITCODE -ne 0) { throw "Could not initialize disposable $($scenario.Name) database." }
    }
    if ($scenario.File) {
      & node --import tsx $scenario.File
    } else {
      & node --import tsx scripts/deploy/spec03-fresh-migration.mjs
    }
    if ($LASTEXITCODE -ne 0) { throw "Migration scenario failed: $($scenario.Name)" }
  }
  Write-Output 'SPEC-03 release migration matrix: fresh, B23->B30, B27->B30, replay, POCO continuity PASS.'
} finally {
  if ($started) { & docker compose -p $project -f $compose down --volumes --remove-orphans *> $null }
  Pop-Location
}
