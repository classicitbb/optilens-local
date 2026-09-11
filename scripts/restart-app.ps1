param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [int] $HealthTimeoutSeconds = 60,
    [int] $LockWaitSeconds = 5
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
Set-Location $ProjectRoot

$dataDirectory = Join-Path $ProjectRoot "data"
$logDirectory = Join-Path $dataDirectory "logs"
$stateFile = Join-Path $dataDirectory "service-restart-state.json"
$restartLog = Join-Path $logDirectory "service-restart.log"
$runId = [guid]::NewGuid().ToString("n")
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
$mutex = $null
$hasLock = $false

function Write-RestartLog {
    param([string] $Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $restartLog -Value $line
    Write-Host $line
}

function Write-RestartState {
    param(
        [string] $State,
        [string] $Phase,
        [int] $Percentage,
        [string] $Message,
        [string] $Error = $null
    )
    $now = (Get-Date).ToUniversalTime().ToString("o")
    $record = [ordered]@{
        runId = $runId
        state = $State
        phase = $Phase
        percentage = $Percentage
        message = $Message
        startedAt = $startedAt
        updatedAt = $now
        completedAt = $(if ($State -eq "completed" -or $State -eq "failed") { $now } else { $null })
        error = $Error
    }
    $temporary = "$stateFile.$runId.tmp"
    [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $stateFile) {
        $backup = "$stateFile.previous"
        [System.IO.File]::Replace($temporary, $stateFile, $backup, $true)
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } else {
        [System.IO.File]::Move($temporary, $stateFile)
    }
}

function Test-OptiLensHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/live" -TimeoutSec 3
        return $health.service -eq "optilens-local"
    } catch {
        return $false
    }
}

function Invoke-LoggedScript {
    param([string] $Name, [string[]] $Arguments = @())
    $script = Join-Path $PSScriptRoot $Name
    Write-RestartLog "[$Name] starting"
    & $script @Arguments 2>&1 | ForEach-Object { Write-RestartLog "[$Name] $_" }
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE." }
    Write-RestartLog "[$Name] completed"
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

try {
    try {
        $mutex = [System.Threading.Mutex]::new($false, "Global\OptiLensLocalRestart")
    } catch {
        $mutex = [System.Threading.Mutex]::new($false, "OptiLensLocalRestart")
    }
    $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds([Math]::Max(0, $LockWaitSeconds)))
    if (-not $hasLock) {
        Write-RestartLog "Restart request skipped: an active restart is already in progress."
        Write-Host "OptiLens Local restart is already in progress."
        exit 0
    }

    Write-RestartState "running" "queued" 0 "Restart queued."
    Write-RestartLog "Restart run $runId queued."

    Write-RestartState "running" "validating" 10 "Checking server syntax."
    Write-RestartLog "[syntax-check] node --check server.js"
    & node --check server.js 2>&1 | ForEach-Object { Write-RestartLog "[syntax-check] $_" }
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed with exit code $LASTEXITCODE." }
    Write-RestartLog "[syntax-check] passed"

    Remove-Item -LiteralPath (Join-Path $ProjectRoot "data\service-stop.requested") -Force -ErrorAction SilentlyContinue
    Write-RestartState "running" "stopping" 35 "Stopping OptiLens Local."
    Invoke-LoggedScript "stop-app.ps1" @("-ProjectRoot", $ProjectRoot, "-Port", [string] $Port)

    Write-RestartState "running" "starting" 60 "Starting OptiLens Local."
    Invoke-LoggedScript "start-app.ps1" @("-ProjectRoot", $ProjectRoot, "-Port", [string] $Port)

    Write-RestartState "running" "waiting_for_health" 80 "Waiting for OptiLens Local health check."
    $healthy = $false
    for ($attempt = 1; $attempt -le [Math]::Max(1, $HealthTimeoutSeconds); $attempt++) {
        if (Test-OptiLensHealth) { $healthy = $true; break }
        Write-RestartLog "[health-check] waiting ($attempt/$HealthTimeoutSeconds)"
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw "OptiLens Local did not pass /api/health/live within $HealthTimeoutSeconds seconds." }

    Write-RestartLog "[health-check] OptiLens Local responded successfully."
    Write-RestartState "completed" "completed" 100 "Restart completed; OptiLens Local is healthy."
    Write-RestartLog "Restart run $runId completed successfully."
} catch {
    $message = $_.Exception.Message
    try { Write-RestartLog "Restart run $runId failed: $message" } catch { Write-Host "Restart failed: $message" }
    try { Write-RestartState "failed" "failed" 100 "Restart failed." $message } catch { }
    exit 1
} finally {
    if ($hasLock -and $mutex) { try { $mutex.ReleaseMutex() } catch { } }
    if ($mutex) { $mutex.Dispose() }
}
