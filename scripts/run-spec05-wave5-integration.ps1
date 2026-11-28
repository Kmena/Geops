# SPEC-05 Wave 5. Loopback PostGIS and synthetic data only.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$container = "geops-spec05-wave5-$PID"
$database = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss')
$started = $false
Push-Location -LiteralPath $root
try {
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'PostGIS image is not cached.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55446:5432' -d 'postgis/postgis:18-3.6' | Out-Null
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
  $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55446/$database"
  $env:GEOPS_DATA_MODE = 'synthetic'
  & node --import tsx apps/api/test/mdm-policy.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Wave 5 integration failed.' }
} finally {
  Remove-Item Env:DATABASE_URL,Env:GEOPS_DATA_MODE -ErrorAction SilentlyContinue
  if ($started) { & docker stop $container *> $null }
  Pop-Location
}
