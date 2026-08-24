param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [switch] $InstallDependencies,
    [switch] $PullGit,
    [string] $GitRemote = "origin",
    [string] $GitBranch = "",
    [switch] $RunMigrations
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$logDirectory = Join-Path $ProjectRoot "data"
$logFile = Join-Path $logDirectory "local-update.log"
$maintenanceLock = Join-Path $logDirectory "maintenance.lock"
$originalRevision = ""
$pulledRevision = ""
$migrationsStarted = $false

if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

function Write-UpdateLog {
    param([string] $Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logFile -Value $line
    Write-Host $line
}

function Invoke-UpdateStep {
    param([string] $Name, [scriptblock] $Action)
    $started = Get-Date
    Write-UpdateLog "[$Name] started."
    try {
        & $Action
        Write-UpdateLog "[$Name] completed in $([math]::Round(((Get-Date) - $started).TotalSeconds, 1))s."
    } catch {
        Write-UpdateLog "[$Name] failed after $([math]::Round(((Get-Date) - $started).TotalSeconds, 1))s: $($_.Exception.Message)"
        throw
    }
}

function Import-OptiLensEnvironment {
    $names = @(
        "OPTILENS_SYNC_PASSPHRASE",
        "OPTILENS_AUTO_APPLY_UPDATES",
        "OPTILENS_HOST",
        "OPTILENS_DB_SERVER",
        "OPTILENS_DB_NAME",
        "OPTILENS_DB_USER",
        "OPTILENS_DB_PASSWORD",
        "OPTILENS_SOURCE_MSSQL_SERVER",
        "OPTILENS_SOURCE_MSSQL_DATABASE",
        "OPTILENS_SOURCE_MSSQL_USER",
        "OPTILENS_SOURCE_MSSQL_PASSWORD",
        "OPTILENS_SOURCE_MSSQL_ENCRYPT",
        "OPTILENS_SOURCE_MSSQL_TRUST_CERT",
        "OPTILENS_SOURCE_MSSQL_MODE",
        "OPTILENS_SOURCE_PSQL_DSN",
        "OPTILENS_SOURCE_PSQL_DRIVER",
        "OPTILENS_SOURCE_PSQL_HOST",
        "OPTILENS_SOURCE_PSQL_PORT",
        "OPTILENS_SOURCE_PSQL_DATABASE",
        "OPTILENS_SOURCE_PSQL_USER",
        "OPTILENS_SOURCE_PSQL_PASSWORD",
        "OPTILENS_SOURCE_PSQL_MODE",
        "OPTILENS_WRITEBACK_ENABLED"
    )

    foreach ($name in $names) {
        if ([Environment]::GetEnvironmentVariable($name, "Process")) { continue }
        $value = [Environment]::GetEnvironmentVariable($name, "User")
        if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, "Machine") }
        if ($value) { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
    }
}

function Restore-PreviousRevision {
    if (-not $originalRevision -or $migrationsStarted) { return }
    Write-UpdateLog "Restoring source revision $originalRevision after failed pre-restart update."
    & git -c "safe.directory=$ProjectRoot" reset --hard $originalRevision *>> $logFile
    if ($LASTEXITCODE -ne 0) {
        Write-UpdateLog "Could not restore source revision. Manual intervention is required."
        return
    }
    & npm.cmd ci --omit=dev --no-audit --no-fund *>> $logFile
    if ($LASTEXITCODE -ne 0) { Write-UpdateLog "Could not restore dependencies. Manual intervention is required." }
}

try {
    Set-Location $ProjectRoot
    Set-Content -LiteralPath $maintenanceLock -Value "$(Get-Date -Format o) update in progress"
    Write-UpdateLog "Update started. Git pull: $PullGit; dependencies: $InstallDependencies; migrations: $RunMigrations"

    if ($PullGit) {
        if (-not $GitBranch -or $GitRemote -notmatch '^[A-Za-z0-9._/-]+$' -or $GitBranch -notmatch '^[A-Za-z0-9._/-]+$') {
            throw "A valid Git remote and branch are required for a pull."
        }
        $dirty = (& git -c "safe.directory=$ProjectRoot" status --porcelain).Trim()
        if ($dirty) { throw "Refusing to pull into a checkout with local changes." }
        $originalRevision = (& git -c "safe.directory=$ProjectRoot" rev-parse HEAD).Trim()
        Invoke-UpdateStep "git fetch" {
            & git -c "safe.directory=$ProjectRoot" fetch --quiet $GitRemote *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Git fetch failed with exit code $LASTEXITCODE." }
        }
        $pulledRevision = (& git -c "safe.directory=$ProjectRoot" rev-parse "$GitRemote/$GitBranch").Trim()
        Invoke-UpdateStep "git fast-forward" {
            & git -c "safe.directory=$ProjectRoot" merge --ff-only $pulledRevision *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Git fast-forward merge failed with exit code $LASTEXITCODE." }
        }
        $InstallDependencies = $true
        $RunMigrations = $true
    }

    if ($InstallDependencies) {
        Invoke-UpdateStep "production dependency installation" {
            & npm.cmd ci --omit=dev --no-audit --no-fund *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE." }
        }
    }

    Invoke-UpdateStep "server syntax check" {
        & node --check server.js *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Server syntax check failed with exit code $LASTEXITCODE." }
    }

    Invoke-UpdateStep "application tests" {
        & npm.cmd test *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Application tests failed with exit code $LASTEXITCODE." }
    }

    if ($RunMigrations) {
        Import-OptiLensEnvironment
        $migrationsStarted = $true
        Invoke-UpdateStep "application migrations" {
            & node scripts/run-app-migrations.js *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Application migration failed with exit code $LASTEXITCODE." }
        }
    }

    Invoke-UpdateStep "application restart" {
        & (Join-Path $PSScriptRoot "restart-app.ps1") -ProjectRoot $ProjectRoot -Port $Port *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Application restart failed with exit code $LASTEXITCODE." }
    }

    $healthy = $false
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/live" -TimeoutSec 3
            if ($health.service -eq "optilens-local") { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) {
        Write-UpdateLog "Service did not report healthy after restart; running self-repair."
        Invoke-UpdateStep "bounded self-repair" {
            & (Join-Path $PSScriptRoot "repair-host.ps1") -ProjectRoot $ProjectRoot -Port $Port -Reason "Update did not come up healthy" *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Self-repair after update failed with exit code $LASTEXITCODE. See data\host-repair.log." }
        }
        Write-UpdateLog "Self-repair after update succeeded."
    }

    Write-UpdateLog "Relaunching host monitor and watchdog task."
    Get-Process -Name "OptiLensHostMonitor" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Get-ScheduledTask -TaskName "OptiLens Local Host Monitor" -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName "OptiLens Local Host Monitor" -ErrorAction SilentlyContinue
    }
    if (Get-ScheduledTask -TaskName "OptiLens Local Watchdog" -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName "OptiLens Local Watchdog" -ErrorAction SilentlyContinue
    }

    Write-UpdateLog "Update completed."
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    Restore-PreviousRevision
    exit 1
} finally {
    Remove-Item -LiteralPath $maintenanceLock -Force -ErrorAction SilentlyContinue
}
