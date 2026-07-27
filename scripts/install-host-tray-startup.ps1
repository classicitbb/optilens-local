param(
    [string] $ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$startupDirectory = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupDirectory "OptiLens Local Host Monitor.vbs"
$oldLauncherPath = Join-Path $startupDirectory "OptiLens Local Host Monitor.cmd"
$monitorExe = Join-Path $ProjectRoot "OptiLensHostMonitor.exe"
$buildScript = Join-Path $PSScriptRoot "build-monitor-exe.ps1"
if (-not (Test-Path $monitorExe)) { & $buildScript -ProjectRoot $ProjectRoot }
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$trayScript = Join-Path $PSScriptRoot "optilens-host-tray.ps1"

if (Test-Path $monitorExe) {
@"
Set shell = CreateObject("WScript.Shell")
shell.Run """$monitorExe""", 1, False
"@ | Set-Content -LiteralPath $launcherPath -Encoding Ascii
} else {
@"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & "$powerShell" & """ -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -STA -File """ & "$trayScript" & """", 0, False
"@ | Set-Content -LiteralPath $launcherPath -Encoding Ascii
}

Remove-Item -LiteralPath $oldLauncherPath -Force -ErrorAction SilentlyContinue

Write-Host "Host monitor will start at sign-in: $launcherPath"
