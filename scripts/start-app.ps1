param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$stopMarker = Join-Path $ProjectRoot "data\service-stop.requested"
Remove-Item -LiteralPath $stopMarker -Force -ErrorAction SilentlyContinue

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

$existingOwners = Get-ListeningPortOwners -TargetPort $Port

if ($existingOwners) {
    Write-Host "OptiLens Local already has a listener on port $Port. PID(s): $($existingOwners -join ', ')"
    return
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
        "OPTILENS_WRITEBACK_ENABLED",
        "OPTILENS_SUPPLIER_MAILBOX_POLL_TIME"
    )

    foreach ($name in $names) {
        if ([Environment]::GetEnvironmentVariable($name, "Process")) {
            continue
        }

        $value = [Environment]::GetEnvironmentVariable($name, "User")
        if (-not $value) {
            $value = [Environment]::GetEnvironmentVariable($name, "Machine")
        }
        if ($value) {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Import-OptiLensEnvironment

$node = (Get-Command node -ErrorAction Stop).Source
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$stdout = Join-Path $ProjectRoot "server.out.log"
$stderr = Join-Path $ProjectRoot "server.err.log"

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$command = "cd /d `"$ProjectRoot`" && `"$node`" server.js >> `"$stdout`" 2>> `"$stderr`""
$startInfo.FileName = $env:ComSpec
$startInfo.Arguments = "/c $command"
$startInfo.WorkingDirectory = $ProjectRoot
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$previousPort = $env:OPTILENS_PORT

try {
    $env:OPTILENS_PORT = [string] $Port
    $process.Start() | Out-Null
} finally {
    if ($null -eq $previousPort) {
        Remove-Item Env:\OPTILENS_PORT -ErrorAction SilentlyContinue
    } else {
        $env:OPTILENS_PORT = $previousPort
    }
}

$started = $false
for ($attempt = 1; $attempt -le 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/live" -TimeoutSec 2
    } catch {
        $health = $null
    }
    if ($health.service -eq "optilens-local") {
        Write-Host "Started OptiLens Local and confirmed health on port $Port."
        $started = $true
        break
    }
}

if (-not $started) {
    throw "Started command, but no listener appeared on port $Port. Check $stderr."
}

# Keep a lightweight host-side supervisor alive even when the optional Windows
# Scheduled Task has not been installed. Its named mutex prevents duplicates.
$watchdog = Join-Path $PSScriptRoot "start-app-watchdog.ps1"
Start-Process -FilePath $powershell -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $watchdog,
    "-ProjectRoot", $ProjectRoot,
    "-Port", $Port
) -WorkingDirectory $ProjectRoot -WindowStyle Hidden
