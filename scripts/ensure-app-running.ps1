param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $HealthUrl = "http://127.0.0.1:8080/api/health"
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

if ($HealthUrl -eq "http://127.0.0.1:8080/api/health" -and $Port -ne 8080) {
    $HealthUrl = "http://127.0.0.1:$Port/api/health"
}

$isHealthy = $false

try {
    $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    $isHealthy = [bool] $response.service
} catch {
    $isHealthy = $false
}

if ($isHealthy) {
    Write-Host "OptiLens Local is responding at $HealthUrl."
    return
}

Write-Host "OptiLens Local is not responding. Restarting..."
& (Join-Path $PSScriptRoot "stop-app.ps1") -Port $Port
& (Join-Path $PSScriptRoot "start-app.ps1") -ProjectRoot $ProjectRoot -Port $Port
