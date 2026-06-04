param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

Set-Location $ProjectRoot
node --check server.js

& (Join-Path $PSScriptRoot "stop-app.ps1") -Port $Port
& (Join-Path $PSScriptRoot "start-app.ps1") -ProjectRoot $ProjectRoot -Port $Port
