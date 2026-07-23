param(
    [string] $ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$startupDirectory = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupDirectory "OptiLens Local Host Monitor.cmd"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$trayScript = Join-Path $PSScriptRoot "optilens-host-tray.ps1"

@"
@echo off
start "" /min "$powerShell" -NoProfile -ExecutionPolicy Bypass -STA -File "$trayScript"
"@ | Set-Content -LiteralPath $launcherPath -Encoding Ascii

Write-Host "Host monitor will start at sign-in: $launcherPath"
