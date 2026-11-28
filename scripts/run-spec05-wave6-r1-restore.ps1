# Synthetic-only dump/restore rehearsal. Never accepts an external DB URL.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$container = "geops-spec05-restore-$PID"
$base = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss')
$source = $base + '1'
$restored = $base + '2'
$started = $false
Push-Location -LiteralPath $root
try {
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Cached PostGIS image required.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55448:5432' -d 'postgis/postgis:18-3.6' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostGIS.' }
  $started = $true
  $ready = $false
  for ($i=0; $i -lt 80; $i++) {
    & docker exec $container pg_isready -h 127.0.0.1 -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'Disposable PostGIS did not become ready.' }
  foreach ($name in @($source,$restored)) {
    & docker exec $container createdb -U postgres $name
    if ($LASTEXITCODE -ne 0) { throw "Could not create $name" }
  }
  $env:GEOPS_DATA_MODE = 'synthetic'
  $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55448/$source"
  & node --import tsx apps/api/test/spec05-staging-restore.mjs seed
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic seed failed.' }
  & docker exec $container pg_dump -U postgres -d $source -Fc -f /tmp/spec05-source.dump
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic pg_dump failed.' }
  $hash = & docker exec $container sha256sum /tmp/spec05-source.dump
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic dump checksum failed.' }
  & docker exec $container pg_restore --list /tmp/spec05-source.dump *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic dump catalog invalid.' }
  & docker exec $container pg_restore --exit-on-error --no-owner --no-acl -U postgres -d $restored /tmp/spec05-source.dump
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic pg_restore failed.' }
  $env:DATABASE_URL = "postgres://postgres:synthetic-only@127.0.0.1:55448/$restored"
  & node --import tsx apps/api/test/spec05-staging-restore.mjs verify
  if ($LASTEXITCODE -ne 0) { throw 'Restored schema/identity check failed.' }
  Write-Output "Synthetic dump SHA-256: $(($hash -split ' ')[0])"
} finally {
  Remove-Item Env:DATABASE_URL,Env:GEOPS_DATA_MODE -ErrorAction SilentlyContinue
  if ($started) { & docker stop $container *> $null }
  Pop-Location
}
