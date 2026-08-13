param(
    [int] $Port = 8080,
    [switch] $Intentional,
    [string] $ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$stopMarker = Join-Path $ProjectRoot "data\service-stop.requested"
if ($Intentional) {
    $markerDirectory = Split-Path -Parent $stopMarker
    if (-not (Test-Path $markerDirectory)) { New-Item -ItemType Directory -Path $markerDirectory -Force | Out-Null }
    Set-Content -LiteralPath $stopMarker -Value "$(Get-Date -Format o) intentional operator shutdown"
}

$service = Get-Service -Name "OptiLensLocal" -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne "Stopped") {
        Stop-Service -Name "OptiLensLocal" -Force
        Write-Host "Stopped OptiLensLocal Windows service."
    } else {
        Write-Host "OptiLensLocal Windows service is already stopped."
    }
}

function Get-ListeningPortOwners {
    param([int] $TargetPort)

    $owners = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    if ($owners) {
        return $owners
    }

    $pattern = ":$TargetPort\s+.*LISTENING\s+(\d+)"
    return netstat -ano |
        Select-String -Pattern $pattern |
        ForEach-Object { [regex]::Match($_.Line, $pattern).Groups[1].Value } |
        Sort-Object -Unique
}

$owners = Get-ListeningPortOwners -TargetPort $Port

foreach ($owner in $owners) {
    if ($owner -and $owner -ne 0) {
        Stop-Process -Id $owner -Force
        Write-Host "Stopped process $owner on port $Port."
    }
}

if (-not $owners) {
    Write-Host "No process is using port $Port."
    return
}

for ($attempt = 1; $attempt -le 40; $attempt++) {
    $remainingOwners = Get-ListeningPortOwners -TargetPort $Port
    if (-not $remainingOwners) {
        Write-Host "Port $Port is free."
        return
    }
    Start-Sleep -Milliseconds 250
}

throw "Port $Port is still in use after stopping PID(s): $($owners -join ', ')."
