param(
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

$owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

foreach ($owner in $owners) {
    if ($owner -and $owner -ne 0) {
        Stop-Process -Id $owner -Force
        Write-Host "Stopped process $owner on port $Port."
    }
}

if (-not $owners) {
    Write-Host "No process is using port $Port."
}
