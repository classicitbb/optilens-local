param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [int] $IntervalSeconds = 60
)

$ErrorActionPreference = "Continue"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$mutex = New-Object System.Threading.Mutex($false, "Global\OptiLensLocalWatchdog")
if (-not $mutex.WaitOne(0, $false)) {
    # Another watchdog is already supervising this Windows session.
    return
}

try {
    while ($true) {
        & (Join-Path $PSScriptRoot "ensure-app-running.ps1") -ProjectRoot $ProjectRoot -Port $Port *>> (Join-Path $ProjectRoot "data\watchdog.log")
        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
