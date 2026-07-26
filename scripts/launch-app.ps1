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
    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $trayScript = Join-Path $PSScriptRoot "optilens-host-tray.ps1"
    Start-Process -FilePath $powerShell -ArgumentList @(
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-STA",
        "-File", $trayScript,
        "-ProjectRoot", $ProjectRoot,
        "-Port", $Port,
        "-HealthUrl", "http://127.0.0.1:$Port/api/health"
    ) -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}

if (-not $NoBrowser) {
    Start-Process $Url
}
