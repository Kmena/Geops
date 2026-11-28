# Disposable PostGIS only. No GEOPS staging or production connection is accepted.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$container = "geops-spec05-wave2-$PID"
$database = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss')
$started = $false
Push-Location -LiteralPath $root
try {
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'PostGIS image is not cached.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55445:5432' -d 'postgis/postgis:18-3.6' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostGIS.' }
  $started = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $container pg_isready -h 127.0.0.1 -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'Disposable PostGIS did not become ready.' }
  & docker exec $container psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create disposable database.' }
  $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55445/$database"
  $env:GEOPS_DATA_MODE = 'synthetic'
  & node --import tsx apps/api/test/device-diagnostics.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'SPEC-05 integration failed.' }
  $regressions = @(
    @('1', 'apps/api/test/mdm-inventory.integration.mjs'),
    @('2', 'apps/api/test/mdm-managed-enrollment.integration.mjs'),
    @('3', 'apps/api/test/spec03-b32-upgrade.integration.mjs'),
    @('4', 'apps/api/test/spec03-maintenance-recovery.integration.mjs'),
    @('5', 'apps/api/test/gps-mixed.integration.mjs')
  )
  foreach ($item in $regressions) {
    $nextDatabase = $database + $item[0]
    & docker exec $container psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $nextDatabase" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create $nextDatabase" }
    $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55445/$nextDatabase"
    if ($item[0] -eq '5') {
      & node --import tsx apps/api/test/prepare-disposable-migrations.mjs
      if ($LASTEXITCODE -ne 0) { throw 'GPS regression migration failed.' }
    }
    & node --import tsx $item[1]
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $($item[1])" }
  }
} finally {
  Remove-Item Env:DATABASE_URL,Env:GEOPS_DATA_MODE -ErrorAction SilentlyContinue
  if ($started) { & docker stop $container *> $null }
  Pop-Location
}
