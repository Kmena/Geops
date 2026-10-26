# Repeatable synthetic Wave 5 suite. No persistent database, GPS ACK or deployment.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$container = "geops-wave5-$PID"
$database = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss')
$started = $false
Push-Location -LiteralPath $root
try {
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'PostGIS image is not cached.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55444:5432' -d 'postgis/postgis:18-3.6' | Out-Null
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
  if ($LASTEXITCODE -ne 0) { throw 'Could not create disposable verification database.' }
  $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55444/$database"
  $env:GEOPS_DATA_MODE = 'synthetic'
  $tests = @(
    'apps/api/test/client-catalog.integration.mjs',
    'apps/api/test/route-catalog.integration.mjs',
    'apps/api/test/visit-schedule.integration.mjs',
    'apps/api/test/visit-evaluation.integration.mjs',
    'apps/api/test/agent-device-links.integration.mjs',
    'apps/api/test/compliance-dashboard.integration.mjs'
  )
  foreach ($test in $tests) {
    & node --import tsx $test
    if ($LASTEXITCODE -ne 0) { throw "Integration failed: $test" }
  }
  $upgradeDatabase = $database + '9'
  & docker exec $container psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $upgradeDatabase" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create disposable upgrade database.' }
  $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55444/$upgradeDatabase"
  & node --import tsx apps/api/test/agent-device-upgrade.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Wave 4B upgrade rehearsal failed.' }
  Write-Output "SPEC-03 Wave 5 disposable PostGIS: $($tests.Count + 1) scripts passed."
} finally {
  if ($started) { & docker stop $container *> $null }
  Pop-Location
}
