param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $Reason = "Host monitor requested repair",
    [string] $FailedConnections = ""
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$dataDirectory = Join-Path $ProjectRoot "data"
$repairLock = Join-Path $dataDirectory "host-repair.lock"
$repairLog = Join-Path $dataDirectory "host-repair.log"
if (-not (Test-Path $dataDirectory)) { New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null }
if (Test-Path $repairLock) {
    $age = (Get-Date) - (Get-Item $repairLock).LastWriteTime
    if ($age.TotalMinutes -lt 15) { Add-Content $repairLog "$(Get-Date -Format o) Repair already running."; exit 0 }
    Remove-Item -LiteralPath $repairLock -Force -ErrorAction SilentlyContinue
}

Set-Content -LiteralPath $repairLock -Value "$(Get-Date -Format o) $Reason"
try {
    Add-Content $repairLog "$(Get-Date -Format o) Repair started. Reason: $Reason; connections: $FailedConnections"
    $healthUrl = "http://127.0.0.1:$Port/api/health/live"
    $healthy = $false
    try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5 } catch { }

    # A single controlled restart lets Node recreate failed database pools and workers.
    # It does not write to Innovations, PSQL, or Access.
    & (Join-Path $PSScriptRoot "restart-app.ps1") -ProjectRoot $ProjectRoot -Port $Port *>> $repairLog
    if ($LASTEXITCODE -ne 0) { throw "Controlled service restart failed with exit code $LASTEXITCODE." }

    for ($attempt = 1; $attempt -le 24; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
            if ($health.service -eq "optilens-local") { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) { throw "Service did not become healthy after repair." }
    Add-Content $repairLog "$(Get-Date -Format o) Repair completed; service is responding."
} catch {
    Add-Content $repairLog "$(Get-Date -Format o) Repair failed: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item -LiteralPath $repairLock -Force -ErrorAction SilentlyContinue
}
