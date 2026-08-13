param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $HealthUrl = "http://127.0.0.1:8080/api/health/live"
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$maintenanceLock = Join-Path $ProjectRoot "data\maintenance.lock"
$stopMarker = Join-Path $ProjectRoot "data\service-stop.requested"
if (Test-Path $stopMarker) {
    Write-Host "OptiLens Local is intentionally stopped. Skipping watchdog restart."
    return
}
if (Test-Path $maintenanceLock) {
    $age = (Get-Date) - (Get-Item $maintenanceLock).LastWriteTime
    if ($age.TotalMinutes -lt 15) {
        Write-Host "OptiLens Local is being updated. Skipping watchdog restart."
        return
    }
    Remove-Item -LiteralPath $maintenanceLock -Force -ErrorAction SilentlyContinue
}

if ($HealthUrl -eq "http://127.0.0.1:8080/api/health/live" -and $Port -ne 8080) {
    $HealthUrl = "http://127.0.0.1:$Port/api/health/live"
}

function Start-OptiLensIisSite {
    try {
        Import-Module WebAdministration -ErrorAction Stop
        $site = Get-Website -Name "Default Web Site" -ErrorAction SilentlyContinue
        if (-not $site) {
            $site = Get-Website | Where-Object { $_.PhysicalPath -eq "C:\inetpub\optilens-local-proxy" } | Select-Object -First 1
        }
        if ($site -and $site.State -ne "Started") {
            Start-Website -Name $site.Name
            Write-Host "Started IIS site '$($site.Name)'."
        }
    } catch {
        Write-Host "IIS site check failed: $($_.Exception.Message)"
    }
}

$isHealthy = $false

try {
    $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    $isHealthy = [bool] $response.service
} catch {
    $isHealthy = $false
}

if (-not $isHealthy) {
    Write-Host "OptiLens Local is not responding. Restarting..."
    & (Join-Path $PSScriptRoot "stop-app.ps1") -Port $Port
    & (Join-Path $PSScriptRoot "start-app.ps1") -ProjectRoot $ProjectRoot -Port $Port
} else {
    Write-Host "OptiLens Local is responding at $HealthUrl."
}

Start-OptiLensIisSite

# Infallibility supervisor check: ensure host monitor tray process is running
$monitorProc = Get-Process -Name "OptiLensHostMonitor" -ErrorAction SilentlyContinue
if (-not $monitorProc) {
    Write-Host "OptiLensHostMonitor process is offline. Restarting monitor..."
    & (Join-Path $PSScriptRoot "start-monitor.ps1") -ProjectRoot $ProjectRoot -Port $Port
}

