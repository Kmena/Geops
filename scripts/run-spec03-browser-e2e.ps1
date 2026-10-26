# SPEC-03 Waves 1-3 browser verification. Requires cached PostGIS image, Chrome, Docker and cached Playwright CLI.
# Everything runs on loopback and uses a temporary, synthetic database inside a volume-free container.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$container = "geops-spec03-e2e-$PID"
$browser = "spec03-e2e-$PID"
$database = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss')
$databaseUrl = "postgres://postgres:synthetic-only@127.0.0.1:55442/$database"
$cliDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "geops-spec03-e2e-$PID"
$testFile = Join-Path $root 'apps/web/test/client-catalog.e2e.js'
$routeTestFile = Join-Path $root 'apps/web/test/route-catalog.e2e.js'
$scheduleTestFile = Join-Path $root 'apps/web/test/visit-schedule.e2e.js'
$apiProcess = $null
$webProcess = $null
$containerStarted = $false
$browserStarted = $false
$cliLocationPushed = $false

function Assert-PortFree([int]$port) {
  $socket = [System.Net.Sockets.TcpClient]::new()
  try {
    $socket.Connect('127.0.0.1', $port)
    throw "Port $port is already in use; stop the conflicting local service first."
  } catch [System.Net.Sockets.SocketException] {
    return
  } finally {
    $socket.Dispose()
  }
}

function Wait-Endpoint([string]$url, [System.Diagnostics.Process]$process) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) { throw "Local server exited while waiting for $url." }
    try {
      $response = Invoke-WebRequest -Uri $url -Headers @{ Accept = 'text/html' } -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "Local server did not become ready: $url"
}

Push-Location -LiteralPath $root
try {
  foreach ($port in @(3500, 3501, 55442)) { Assert-PortFree $port }
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'The PostGIS image is not cached locally.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55442:5432' -d 'postgis/postgis:18-3.6' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostGIS.' }
  $containerStarted = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $container pg_isready -h 127.0.0.1 -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'Disposable PostGIS did not become ready.' }
  & docker exec $container psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create disposable verification database.' }

  $env:DATABASE_URL = $databaseUrl
  $env:GEOPS_DATA_MODE = 'synthetic'
  & node --import tsx apps/api/test/client-catalog.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Catalog integration fixture failed.' }
  & node --import tsx apps/api/test/route-catalog.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Route integration fixture failed.' }
  & node --import tsx apps/api/test/visit-schedule.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Visit schedule integration fixture failed.' }
  & node --import tsx apps/api/test/visit-evaluation.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Visit evaluation integration fixture failed.' }
  & node --import tsx apps/api/test/agent-device-links.integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Agent-device and persisted-GPS integration fixture failed.' }

  $node = (Get-Command node).Source
  $apiProcess = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', 'apps/api/test/client-catalog-browser-server.mjs') -WorkingDirectory $root -Environment @{ DATABASE_URL = $databaseUrl; GEOPS_DATA_MODE = 'synthetic' } -WindowStyle Hidden -PassThru
  Wait-Endpoint 'http://127.0.0.1:3500/health/live' $apiProcess
  $vite = Join-Path $root 'node_modules/vite/bin/vite.js'
  $webRoot = Join-Path $root 'apps/web'
  $webProcess = Start-Process -FilePath $node -ArgumentList @($vite, '--host', '127.0.0.1', '--port', '3501') -WorkingDirectory $webRoot -WindowStyle Hidden -PassThru
  Wait-Endpoint 'http://127.0.0.1:3501/' $webProcess

  New-Item -ItemType Directory -Path $cliDirectory | Out-Null
  Push-Location -LiteralPath $cliDirectory
  $cliLocationPushed = $true
  & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" open 'http://127.0.0.1:3501/' --browser chrome *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Cached Playwright CLI could not open Chrome.' }
  $browserStarted = $true
  $output = & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" --raw run-code --filename $testFile
  if ($LASTEXITCODE -ne 0) { throw "Browser E2E failed: $output" }
  $result = ($output | Out-String).Trim() | ConvertFrom-Json
  if ($result.result -ne 'PASS' -or $result.checks -ne 15) { throw "Unexpected browser E2E result: $output" }
  Write-Output "SPEC-03 browser E2E: $($result.checks) checks passed (desktop and 390 px mobile)."
  $routeOutput = & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" --raw run-code --filename $routeTestFile
  if ($LASTEXITCODE -ne 0) { throw "Route browser E2E failed: $routeOutput" }
  $routeResult = ($routeOutput | Out-String).Trim() | ConvertFrom-Json
  if ($routeResult.result -ne 'PASS' -or $routeResult.checks -ne 14) { throw "Unexpected route browser E2E result: $routeOutput" }
  Write-Output "SPEC-03 Wave 2 browser E2E: $($routeResult.checks) checks passed (desktop and 390 px mobile)."
  $scheduleOutput = & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" --raw run-code --filename $scheduleTestFile
  if ($LASTEXITCODE -ne 0) { throw "Schedule browser E2E failed: $scheduleOutput" }
  $scheduleResult = ($scheduleOutput | Out-String).Trim() | ConvertFrom-Json
  if ($scheduleResult.result -ne 'PASS' -or $scheduleResult.checks -ne 20) { throw "Unexpected schedule browser E2E result: $scheduleOutput" }
  Write-Output "SPEC-03 Wave 3 browser E2E: $($scheduleResult.checks) checks passed (desktop and 390 px mobile)."
  Push-Location -LiteralPath $root
  try {
    & node --import tsx apps/api/test/gps-policy.integration.mjs
    if ($LASTEXITCODE -ne 0) { throw 'GPS policy regression failed.' }
    & node --import tsx apps/api/test/gps-health.integration.mjs
    if ($LASTEXITCODE -ne 0) { throw 'GPS health regression failed.' }
    & node --import tsx apps/api/test/gps-operations.integration.mjs
    if ($LASTEXITCODE -ne 0) { throw 'GPS operations regression failed.' }
  } finally {
    Pop-Location
  }
} finally {
  if ($browserStarted) {
    & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" close *> $null
  }
  if ($cliLocationPushed) { Pop-Location }
  if ($webProcess -and -not $webProcess.HasExited) { Stop-Process -Id $webProcess.Id -Force }
  if ($apiProcess -and -not $apiProcess.HasExited) { Stop-Process -Id $apiProcess.Id -Force }
  if ($containerStarted) { & docker stop $container *> $null }
  if (Test-Path -LiteralPath $cliDirectory) {
    $temporaryRoot = ([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $resolvedCliDirectory = (Resolve-Path -LiteralPath $cliDirectory).Path
    if (-not $resolvedCliDirectory.StartsWith($temporaryRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Playwright output is outside the temporary directory.'
    }
    Remove-Item -LiteralPath $resolvedCliDirectory -Recurse -Force
  }
  Pop-Location
}
