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
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $Message"
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
        & git -c "safe.directory=$ProjectRoot" fetch --quiet $GitRemote *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Git fetch failed with exit code $LASTEXITCODE." }
        $pulledRevision = (& git -c "safe.directory=$ProjectRoot" rev-parse "$GitRemote/$GitBranch").Trim()
        & git -c "safe.directory=$ProjectRoot" merge --ff-only $pulledRevision *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Git fast-forward merge failed with exit code $LASTEXITCODE." }
        $InstallDependencies = $true
        $RunMigrations = $true
    }

    if ($InstallDependencies) {
        & npm.cmd ci --omit=dev --no-audit --no-fund *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE." }
    }

    & node --check server.js *>> $logFile
    if ($LASTEXITCODE -ne 0) { throw "Server syntax check failed with exit code $LASTEXITCODE." }

    & npm.cmd test *>> $logFile
    if ($LASTEXITCODE -ne 0) { throw "Application tests failed with exit code $LASTEXITCODE." }

    if ($RunMigrations) {
        Import-OptiLensEnvironment
        $migrationsStarted = $true
        & node scripts/run-app-migrations.js *>> $logFile
        if ($LASTEXITCODE -ne 0) { throw "Application migration failed with exit code $LASTEXITCODE." }
    }

    & (Join-Path $PSScriptRoot "restart-app.ps1") -ProjectRoot $ProjectRoot -Port $Port *>> $logFile
    if ($LASTEXITCODE -ne 0) { throw "Application restart failed with exit code $LASTEXITCODE." }

    Write-UpdateLog "Update completed."
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    Restore-PreviousRevision
    exit 1
} finally {
    Remove-Item -LiteralPath $maintenanceLock -Force -ErrorAction SilentlyContinue
}
