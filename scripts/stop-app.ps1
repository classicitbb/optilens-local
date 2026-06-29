param(
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

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
}
