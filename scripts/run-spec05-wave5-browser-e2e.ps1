# Loopback-only browser E2E with disposable PostGIS and mock ManageEngine.
param([string]$RepoRoot)
$ErrorActionPreference = 'Stop'
$root = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path }
$container = "geops-spec05-browser-$PID"
$browser = "spec05-wave5-$PID"
$database = 'geops_verify_' + (Get-Date -Format 'yyyyMMddHHmmss')
$url = "postgres://postgres:synthetic-only@127.0.0.1:55447/$database"
$cliDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "geops-spec05-browser-$PID"
$apiProcess = $null
$webProcess = $null
$containerStarted = $false
$browserStarted = $false
$cliPushed = $false
function Assert-PortFree([int]$port) {
  $socket = [System.Net.Sockets.TcpClient]::new()
  try { $socket.Connect('127.0.0.1', $port); throw "Port $port is in use." }
  catch [System.Net.Sockets.SocketException] { return }
  finally { $socket.Dispose() }
}
function Wait-Endpoint([string]$target, [System.Diagnostics.Process]$process) {
  for ($attempt=0; $attempt -lt 80; $attempt++) {
    if ($process.HasExited) { throw "Local service exited: $target" }
    try { if ((Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { return } }
    catch { Start-Sleep -Milliseconds 300 }
  }
  throw "Local service unavailable: $target"
}
Push-Location -LiteralPath $root
try {
  foreach ($port in @(3500,3501,55447)) { Assert-PortFree $port }
  & docker image inspect 'postgis/postgis:18-3.6' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'PostGIS image missing.' }
  & docker run --rm --name $container -e POSTGRES_PASSWORD=synthetic-only -p '127.0.0.1:55447:5432' -d 'postgis/postgis:18-3.6' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostGIS.' }
  $containerStarted = $true
  $ready = $false
  for ($attempt=0; $attempt -lt 60; $attempt++) {
    & docker exec $container pg_isready -h 127.0.0.1 -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'PostGIS was not ready.' }
  & docker exec $container psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create fixture database.' }
  $node = (Get-Command node).Source
  $apiStart = @{ FilePath=$node; ArgumentList=@('--import','tsx','apps/api/test/mdm-workspace-browser-server.mjs'); WorkingDirectory=$root; Environment=@{ DATABASE_URL=$url; GEOPS_DATA_MODE='synthetic' }; PassThru=$true }
  if ($IsWindows) { $apiStart.WindowStyle = 'Hidden' }
  $apiProcess = Start-Process @apiStart
  Wait-Endpoint 'http://127.0.0.1:3500/health/live' $apiProcess
  Wait-Endpoint 'http://127.0.0.1:3500/health/ready' $apiProcess
  $readyResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:3500/health/ready' -UseBasicParsing
  if (($readyResponse.Content | ConvertFrom-Json).status -ne 'ok' -or
      -not ($readyResponse.Headers['Content-Type'] -like '*application/json*')) {
    throw 'API readiness did not return JSON status ok.'
  }
  foreach ($route in @('/v1/device/diagnostics/self', '/v1/admin/mdm/workspace/summary',
      '/v1/admin/gps-policies')) {
    $response = Invoke-WebRequest -Uri ('http://127.0.0.1:3500' + $route) -UseBasicParsing -SkipHttpErrorCheck
    if ($response.StatusCode -ne 401) { throw "Expected authenticated contract at $route" }
  }
  $gpsRoute = Invoke-WebRequest -Uri 'http://127.0.0.1:3500/v2/device/gps/batches' -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing -SkipHttpErrorCheck
  if ($gpsRoute.StatusCode -ne 401) { throw "GPS v2 contract probe returned $($gpsRoute.StatusCode): $($gpsRoute.Content)" }
  $vite = Join-Path $root 'node_modules/vite/bin/vite.js'
  $webStart = @{ FilePath=$node; ArgumentList=@($vite,'--host','127.0.0.1','--port','3501'); WorkingDirectory=(Join-Path $root 'apps/web'); Environment=@{ VITE_MDM_ENABLED='true' }; PassThru=$true }
  if ($IsWindows) { $webStart.WindowStyle = 'Hidden' }
  $webProcess = Start-Process @webStart
  Wait-Endpoint 'http://127.0.0.1:3501/' $webProcess
  New-Item -ItemType Directory -Path (Join-Path $root 'output/playwright') -Force | Out-Null
  $env:GEOPS_WAVE5_OUTPUT = (Join-Path $root 'output/playwright')
  New-Item -ItemType Directory -Path $cliDirectory | Out-Null
  Push-Location -LiteralPath $cliDirectory
  $cliPushed = $true
  $launchOutput = & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" open 'http://127.0.0.1:3501/' --browser chrome 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Playwright CLI could not launch Chrome: $launchOutput" }
  $browserStarted = $true
  $testFile = Join-Path $root 'apps/web/test/mdm-workspace.e2e.js'
  $cliTestFile = Join-Path $cliDirectory 'mdm-workspace.e2e.js'
  $code = (Get-Content -LiteralPath $testFile -Raw).Replace('__GEOPS_WAVE5_OUTPUT__', $env:GEOPS_WAVE5_OUTPUT.Replace('\','/'))
  Set-Content -LiteralPath $cliTestFile -Value $code -Encoding utf8
  $complete = Join-Path $root 'output/playwright/spec05-wave5-complete.png'
  if (Test-Path -LiteralPath $complete) { Remove-Item -LiteralPath $complete -Force }
  $output = & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" --raw run-code --filename $cliTestFile 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Browser E2E failed: $output" }
  $raw = ($output | Out-String).Trim()
  if ($raw) {
    $result = $raw | ConvertFrom-Json
    if ($result.result -ne 'PASS' -or $result.checks -lt 20) { throw "Unexpected browser result: $output" }
  } else {
    for ($attempt=0; $attempt -lt 80 -and -not (Test-Path -LiteralPath $complete); $attempt++) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $complete)) {
      throw 'Browser CLI returned no result and the final check artifact is absent.'
    }
    $result = @{ checks = 20 }
  }
  Write-Output "SPEC-05 Wave 5 browser E2E PASS: $($result.checks) checks."
} finally {
  if ($browserStarted) { & npx --offline --yes --package '@playwright/cli@0.1.22' playwright-cli "-s=$browser" close *> $null }
  if ($cliPushed) { Pop-Location }
  if ($webProcess -and -not $webProcess.HasExited) { Stop-Process -Id $webProcess.Id -Force }
  if ($apiProcess -and -not $apiProcess.HasExited) { Stop-Process -Id $apiProcess.Id -Force }
  if ($containerStarted) { & docker stop $container *> $null }
  Remove-Item Env:GEOPS_WAVE5_OUTPUT -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $cliDirectory) {
    $tempRoot = ([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $resolved = (Resolve-Path -LiteralPath $cliDirectory).Path
    if (-not $resolved.StartsWith($tempRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected temp directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  Pop-Location
}
