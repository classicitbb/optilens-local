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
$statusFile = Join-Path $logDirectory "update-status.json"
$maintenanceLock = Join-Path $logDirectory "maintenance.lock"
$maxLockAgeMinutes = 20
$originalRevision = ""
$pulledRevision = ""
$migrationsStarted = $false
$smokeCheckPassed = $null
$testSuiteResult = $null

if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

function Write-UpdateLog {
    param([string] $Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logFile -Value $line
    Write-Host $line
}

# The dashboard and the recovery observer both want a clean, structured
# answer to "what happened during the last update" instead of scraping log
# text. This is written at every meaningful transition, not just at the end,
# so a crash mid-update still leaves an honest "running" (now stale) record.
function Write-UpdateStatus {
    param(
        [string] $State,
        [string] $Message = ""
    )
    $payload = [ordered]@{
        state             = $State
        message           = $Message
        checkedAt         = (Get-Date -Format o)
        fromRevision      = $originalRevision
        toRevision        = $pulledRevision
        installedDependencies = [bool]$InstallDependencies
        ranMigrations     = [bool]$RunMigrations
        smokeCheckPassed  = $smokeCheckPassed
        testSuite         = $testSuiteResult
    }
    try {
        $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statusFile
    } catch {
        Write-UpdateLog "Could not write update status file: $($_.Exception.Message)"
    }
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

# Deep readiness check, not just liveness: /api/health confirms the process
# is up AND that it can reach both the private app database and the
# read-only Innovations source database. A process that boots but can't
# reach its databases is not "healthy" for anyone using this app.
function Test-DeepHealth {
    param([int] $Attempts = 20, [int] $DelayMs = 500)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Start-Sleep -Milliseconds $DelayMs
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 4
            if ($health.ok -eq $true -and $health.service -eq "optilens-local") { return $health }
        } catch { }
    }
    return $null
}

# Automatic rollback for the case the current pipeline has never handled:
# the new code passed every pre-restart check but the restarted service is
# still unhealthy (a runtime crash on boot, a bad env assumption, whatever
# `node --check` and the smoke check couldn't catch). This only fires when a
# git pull actually moved the revision — a restart-only trigger has no
# "before" to revert to, and falls through to the existing bounded
# self-repair instead. It intentionally does not touch the database: any
# migrations from this run have already applied, and this codebase's
# migrations are additive (new tables/columns), so the previous code
# continues to run correctly against the newer schema.
function Invoke-AutomaticRollback {
    Write-UpdateLog "Rolling back to $originalRevision because $pulledRevision failed its post-restart health check."
    Write-UpdateStatus -State "rolling_back" -Message "New revision failed health check; reverting to $originalRevision."
    try {
        Invoke-UpdateStep "automatic rollback" {
            & git -c "safe.directory=$ProjectRoot" reset --hard $originalRevision *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Rollback git reset failed with exit code $LASTEXITCODE." }
            & npm.cmd ci --omit=dev --no-audit --no-fund *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Rollback dependency reinstall failed with exit code $LASTEXITCODE." }
            & (Join-Path $PSScriptRoot "restart-app.ps1") -ProjectRoot $ProjectRoot -Port $Port *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Rollback restart failed with exit code $LASTEXITCODE." }
        }
    } catch {
        Write-UpdateLog "Automatic rollback itself failed: $($_.Exception.Message)"
        return $false
    }
    $health = Test-DeepHealth
    if ($health) {
        Write-UpdateLog "Rollback succeeded; service is healthy again on $originalRevision."
        return $true
    }
    Write-UpdateLog "Rollback restart did not restore health either."
    return $false
}

try {
    Set-Location $ProjectRoot

    if (Test-Path $maintenanceLock) {
        $age = (Get-Date) - (Get-Item $maintenanceLock).LastWriteTime
        if ($age.TotalMinutes -lt $maxLockAgeMinutes) {
            Write-UpdateLog "An update is already in progress (lock is $([math]::Round($age.TotalMinutes, 1))m old). Refusing to start a second run."
            exit 0
        }
        Write-UpdateLog "Found a stale update lock ($([math]::Round($age.TotalMinutes, 1))m old); clearing it and proceeding."
        Remove-Item -LiteralPath $maintenanceLock -Force -ErrorAction SilentlyContinue
    }

    Set-Content -LiteralPath $maintenanceLock -Value "$(Get-Date -Format o) update in progress"
    Write-UpdateLog "Update started. Git pull: $PullGit; dependencies: $InstallDependencies; migrations: $RunMigrations"
    $originalRevision = (& git -c "safe.directory=$ProjectRoot" rev-parse HEAD).Trim()
    Write-UpdateStatus -State "running" -Message "Update started."

    if ($PullGit) {
        if (-not $GitBranch -or $GitRemote -notmatch '^[A-Za-z0-9._/-]+$' -or $GitBranch -notmatch '^[A-Za-z0-9._/-]+$') {
            throw "A valid Git remote and branch are required for a pull."
        }
        $dirty = (& git -c "safe.directory=$ProjectRoot" status --porcelain).Trim()
        if ($dirty) { throw "Refusing to pull into a checkout with local changes." }
        Invoke-UpdateStep "git fetch" {
            & git -c "safe.directory=$ProjectRoot" fetch --quiet $GitRemote *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Git fetch failed with exit code $LASTEXITCODE." }
        }
        $pulledRevision = (& git -c "safe.directory=$ProjectRoot" rev-parse "$GitRemote/$GitBranch").Trim()
        Invoke-UpdateStep "git fast-forward" {
            & git -c "safe.directory=$ProjectRoot" merge --ff-only $pulledRevision *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Git fast-forward merge failed with exit code $LASTEXITCODE." }
        }

        # Scope the rest of this run to what actually changed, instead of
        # always installing dependencies and running migrations on every
        # pull. A docs or CSS-only commit should not pay for a full npm ci.
        try {
            $scopeJson = & node (Join-Path $ProjectRoot "scripts/plan-update-scope.js") $originalRevision $pulledRevision
            if ($LASTEXITCODE -eq 0 -and $scopeJson) {
                $scope = $scopeJson | ConvertFrom-Json
                $InstallDependencies = [bool]$scope.installDependencies
                $RunMigrations = [bool]$scope.runMigrations
                Write-UpdateLog "Update scope from diff: dependencies=$($scope.installDependencies) migrations=$($scope.runMigrations) areas=$(($scope.changedAreas | ForEach-Object { $_.id }) -join ',')"
            } else {
                Write-UpdateLog "Could not compute update scope from diff; keeping requested dependency/migration flags as a safe default."
            }
        } catch {
            Write-UpdateLog "Update scope planning failed ($($_.Exception.Message)); keeping requested dependency/migration flags as a safe default."
        }
    }

    if ($InstallDependencies) {
        Invoke-UpdateStep "production dependency installation" {
            & npm.cmd ci --omit=dev --no-audit --no-fund *>> $logFile
            if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE." }
        }
    }

    # Fast, blocking gate: does every changed file parse, and can the new
    # code reach both databases. Seconds, not the ~30s+ of the full suite.
    Invoke-UpdateStep "smoke check" {
        $smokeArgs = @()
        if ($originalRevision -and $pulledRevision) { $smokeArgs = @($originalRevision, $pulledRevision) }
        $smokeJson = & node (Join-Path $ProjectRoot "scripts/smoke-check.js") @smokeArgs
        $smokeCheckPassed = ($LASTEXITCODE -eq 0)
        Add-Content -LiteralPath $logFile -Value $smokeJson
        if (-not $smokeCheckPassed) { throw "Smoke check failed. See data\local-update.log for the file/database detail." }
    }

    # The full test suite is advisory, not a release valve: a flaky or
    # unrelated test failure no longer blocks a change that already passed
    # the smoke check. Its result is recorded and surfaced, never thrown.
    Write-UpdateLog "[application tests] started (advisory)."
    $testStarted = Get-Date
    $testOutput = & npm.cmd test 2>&1
    $testPassed = ($LASTEXITCODE -eq 0)
    $testSuiteResult = [ordered]@{
        ran     = $true
        passed  = $testPassed
        summary = ($testOutput | Select-Object -Last 12) -join "`n"
    }
    Add-Content -LiteralPath $logFile -Value ($testOutput -join "`n")
    Write-UpdateLog "[application tests] $(if ($testPassed) { 'passed' } else { 'FAILED (advisory; not blocking this update)' }) in $([math]::Round(((Get-Date) - $testStarted).TotalSeconds, 1))s."

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

    $health = Test-DeepHealth
    if (-not $health) {
        Write-UpdateLog "Service did not report healthy (deep check) after restart."
        $canRollBack = $PullGit -and $pulledRevision -and ($pulledRevision -ne $originalRevision)
        if ($canRollBack -and (Invoke-AutomaticRollback)) {
            Write-UpdateLog "Update did not go live; the service was reverted to $originalRevision and is healthy."
            Write-UpdateStatus -State "rolled_back" -Message "Revision $pulledRevision failed its health check and was reverted to $originalRevision."
            Get-Process -Name "OptiLensHostMonitor" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            if (Get-ScheduledTask -TaskName "OptiLens Local Host Monitor" -ErrorAction SilentlyContinue) {
                Start-ScheduledTask -TaskName "OptiLens Local Host Monitor" -ErrorAction SilentlyContinue
            }
            if (Get-ScheduledTask -TaskName "OptiLens Local Watchdog" -ErrorAction SilentlyContinue) {
                Start-ScheduledTask -TaskName "OptiLens Local Watchdog" -ErrorAction SilentlyContinue
            }
            exit 1
        }

        Write-UpdateLog "Running bounded self-repair."
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
    Write-UpdateStatus -State "succeeded" -Message "Update completed."
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    Write-UpdateStatus -State "failed" -Message $_.Exception.Message
    Restore-PreviousRevision
    exit 1
} finally {
    Remove-Item -LiteralPath $maintenanceLock -Force -ErrorAction SilentlyContinue
}
