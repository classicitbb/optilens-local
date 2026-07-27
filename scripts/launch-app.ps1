param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $Url = "",
    [switch] $NoBrowser,
    [switch] $NoTray
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

if (-not $Url) {
    $Url = "http://127.0.0.1:$Port/"
}

Set-Location $ProjectRoot

& (Join-Path $PSScriptRoot "start-app.ps1") -ProjectRoot $ProjectRoot -Port $Port

if (-not $NoTray) {
    $monitorExe = Join-Path $ProjectRoot "OptiLensHostMonitor.exe"
    if (-not (Test-Path $monitorExe)) { & (Join-Path $PSScriptRoot "build-monitor-exe.ps1") -ProjectRoot $ProjectRoot }
    Start-Process -FilePath $monitorExe -WorkingDirectory $ProjectRoot
}

if (-not $NoBrowser) {
    Start-Process $Url
}
