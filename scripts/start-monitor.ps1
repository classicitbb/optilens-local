param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$exe = Join-Path $ProjectRoot "OptiLensHostMonitor.exe"
if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot "build-monitor-exe.ps1") -ProjectRoot $ProjectRoot }
Start-Process -FilePath $exe -ArgumentList @("--port", [string]$Port, "--tray") -WorkingDirectory $ProjectRoot
