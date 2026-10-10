<#
.SYNOPSIS
    Runs HandsFree locally. No API key and no LM Studio required.

.DESCRIPTION
    Checks prerequisites, installs dependencies on first run, verifies the decision
    model is present, then starts the control server and opens the control page.

.PARAMETER Port
    Port for the control page. Default 8787.

.PARAMETER Headless
    Run the controlled browser without a visible window.

.PARAMETER StartUrl
    URL the controlled browser opens on launch.

.PARAMETER Cpu
    Force CPU inference instead of the GPU.

.PARAMETER Model
    Path to a decision-model .gguf. Defaults to models/ then common install locations.

.EXAMPLE
    .\run.ps1

.EXAMPLE
    .\run.ps1 -Port 9000 -StartUrl https://news.ycombinator.com/
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$Headless,
    [switch]$Cpu,
    [string]$StartUrl = "https://example.com/",
    [string]$Model = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  $m" -ForegroundColor Red }

Write-Host ""
Write-Host "HandsFree - local setup" -ForegroundColor White
Write-Host ""

Write-Host "[1/6] Node"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node not found. Install Node 20+ from https://nodejs.org"
  exit 1
}
$ver = (node -v) -replace "^v", ""
Ok "node $ver"
if ([version]($ver -replace "[^0-9.].*$", "0.0.0") -lt [version]"20.0.0") {
  Warn "Node 20 or newer is required (found $ver)."
}

Write-Host "[2/6] Dependencies"
if (-not (Test-Path "node_modules")) {
  Info "installing (first run, this takes a minute)..."
  npm install --silent
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed"; exit 1 }
  Ok "installed"
} else {
  Ok "node_modules present"
}

$pw = Join-Path $env:LOCALAPPDATA "ms-playwright"
if (-not (Test-Path $pw)) {
  Info "installing Chromium for Playwright (first run)..."
  npx playwright install chromium | Out-Null
  Ok "Chromium installed"
} else {
  Ok "Chromium present"
}

Write-Host "[3/6] Decision model"
if ($Model) { $env:HANDSFREE_MODEL = $Model }
$modelInfo = node -e "import('./src/model-path.js').then(m=>{const i=m.modelInfo();console.log(i.path||'')})" 2>$null
if ([string]::IsNullOrWhiteSpace($modelInfo)) {
  Fail "No decision model found."
  Warn "Download Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf into: $root\models"
  Warn "or set HANDSFREE_MODEL to the full path of a .gguf file."
  exit 1
}
Ok (Split-Path $modelInfo -Leaf)

Write-Host "[4/6] Port check"
$busy = $false
try { Invoke-WebRequest "http://127.0.0.1:$Port/api/state" -TimeoutSec 3 -UseBasicParsing | Out-Null; $busy = $true } catch { }
if ($busy) {
  Warn "Port $Port is already serving a HandsFree instance."
  $answer = Read-Host "  [k]ill and restart, [o]pen the running one, or [n]ew port"
  switch ($answer.ToLower()) {
    "k" {
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
        try { if ($_.CommandLine -like "*server.js*") { Stop-Process -Id $_.ProcessId -Force; Ok "stopped pid $($_.ProcessId)" } } catch {}
      }
      Start-Sleep -Seconds 2
    }
    "o" { Ok "opening the running instance"; Start-Process "http://localhost:$Port"; exit 0 }
    default { $Port = Read-Host "  Enter a free port" }
  }
} else {
  Ok "port $Port is free"
}

Write-Host "[5/6] Configuration"
$env:HANDSFREE_BACKEND = "local"
$env:HANDSFREE_GPU = if ($Cpu) { "false" } else { "true" }
$env:PORT = "$Port"
Ok ("backend=local · gpu=" + $env:HANDSFREE_GPU + " · no API key needed")

Write-Host "[6/6] Starting"
$nodeArgs = @("src/server.js", "--port", "$Port", "--start-url", $StartUrl)
if ($Headless) { $nodeArgs += "--headless" }
Info "loading model (first run takes a few seconds)..."

$log = Join-Path $root "server.log"
$err = Join-Path $root "server.err.log"
Remove-Item $log, $err -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -NoNewWindow
Write-Host "  server pid $($proc.Id) · log: server.log" -ForegroundColor Gray
Write-Host "  Control page:  http://localhost:$Port" -ForegroundColor White
Write-Host ""

Start-Sleep -Seconds 6
if ($proc.HasExited) {
  Fail "The server exited. Last errors:"
  if (Test-Path $err) { Get-Content $err -Tail 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red } }
  exit 1
}
Start-Process "http://localhost:$Port"

Write-Host "Running. Press Ctrl+C to stop, or close this window." -ForegroundColor Gray
try {
  while (-not $proc.HasExited) { Start-Sleep -Seconds 2 }
  if (Test-Path $err) { Get-Content $err -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red } }
} catch {
  $proc | Stop-Process -Force -ErrorAction SilentlyContinue
}