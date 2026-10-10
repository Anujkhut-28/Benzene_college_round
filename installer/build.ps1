# Stages node + playwright browsers for the installer, then runs Inno Setup.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $PSScriptRoot "runtime"

New-Item -ItemType Directory -Force $runtime | Out-Null
Copy-Item (Get-Command node).Source (Join-Path $runtime "node.exe") -Force

$browsers = Join-Path $runtime "browsers"
if (-not (Test-Path $browsers)) {
  Copy-Item "$env:LOCALAPPDATA\ms-playwright" $browsers -Recurse
}

$iscc = Get-ChildItem "C:\Program Files*\Inno Setup 7\ISCC.exe" | Select-Object -First 1 -ExpandProperty FullName
& $iscc (Join-Path $PSScriptRoot "handsfree.iss")