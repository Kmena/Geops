# Disposable synthetic PostGIS regressions for the SPEC-03 + MDM integration copy.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$container = "geops-spec03-mdm-$PID"
$tests = @(
  'apps/api/test/spec03-mdm-upgrade.integration.mjs',
  'apps/api/test/mdm-oauth-upgrade.integration.mjs',
  'apps/api/test/mdm-inventory.integration.mjs',
  'apps/api/test/mdm-security.integration.mjs',
  'apps/api/test/mdm-web-oauth.integration.mjs',
  'apps/api/test/gps-continuity-migration.integration.mjs',
  'apps/api/test/migration-0015-upgrade.integration.mjs',
  'apps/api/test/device-enrollment.integration.mjs',
  'apps/api/test/gps-config.integration.mjs',
  'apps/api/test/gps-events.integration.mjs',
  'apps/api/test/gps-mixed.integration.mjs',
  'apps/api/test/gps-continuity.integration.mjs',
  'apps/api/test/gps-scheduler-load.integration.mjs',
  'apps/api/test/gps-capability-bootstrap.integration.mjs',
  'apps/api/test/admin-tenant-bootstrap.integration.mjs',
  'apps/api/test/single-tenant-users.integration.mjs'
)
$started = $false
$failures = @()
Push-Location -LiteralPath $root
try {
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'PostGIS image is not cached.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55443:5432' -d 'postgis/postgis:18-3.6' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostGIS.' }
  $started = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $container pg_isready -h 127.0.0.1 -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'Disposable PostGIS did not become ready.' }
  $env:GEOPS_DATA_MODE = 'synthetic'
  $prefix = Get-Date -Format 'yyyyMMddHHmmss'
  for ($index = 0; $index -lt $tests.Count; $index++) {
    $database = "geops_verify_$prefix$index"
    & docker exec $container psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create $database." }
    $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55443/$database"
    if ($index -ge 7) {
      $env:GEOPS_MIGRATION_TARGET = $database
      $env:GEOPS_CONFIRM_MIGRATION_TARGET = $database
      & node --import tsx apps/api/src/db/migrate.ts
      if ($LASTEXITCODE -ne 0) { throw "Could not initialize $database for $($tests[$index])." }
    }
    Write-Output "RUN $($tests[$index])"
    & node --import tsx $tests[$index]
    if ($LASTEXITCODE -ne 0) { $failures += $tests[$index]; Write-Output "FAIL $($tests[$index])" }
    else { Write-Output "PASS $($tests[$index])" }
  }
  if ($failures.Count -gt 0) { throw "$($failures.Count) integration test(s) failed: $($failures -join ', ')" }
  Write-Output "SPEC-03 + MDM disposable PostGIS regression: $($tests.Count) scripts passed."
} finally {
  if ($started) { & docker stop $container *> $null }
  Pop-Location
}
