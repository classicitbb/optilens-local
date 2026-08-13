param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $ServiceName = "OptiLensLocal",
    [string] $WatchdogTaskName = "OptiLens Local Watchdog"
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Invoke-Sc {
    param([string[]] $Arguments)

    $output = & sc.exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe $($Arguments -join ' ') failed: $output"
    }
    return $output
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Invoke-Sc @("config", $ServiceName, "start=", "delayed-auto") | Out-Null
    Invoke-Sc @("failure", $ServiceName, "reset=", "86400", "actions=", "restart/10000/restart/30000/restart/60000") | Out-Null
    Invoke-Sc @("failureflag", $ServiceName, "1") | Out-Null
    if ($service.Status -ne "Running") {
        Start-Service -Name $ServiceName
    }
    Write-Host "Hardened Windows service recovery for $ServiceName."
} else {
    Write-Host "Windows service $ServiceName was not found; watchdog process fallback remains available."
}

$task = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
if ($task) {
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Set-ScheduledTask -TaskName $WatchdogTaskName -Settings $settings | Out-Null
    Enable-ScheduledTask -TaskName $WatchdogTaskName | Out-Null
    Start-ScheduledTask -TaskName $WatchdogTaskName
    Write-Host "Hardened scheduled watchdog task $WatchdogTaskName."
} else {
    Write-Host "Scheduled watchdog task $WatchdogTaskName was not found. Install it with npm run app:watchdog:install:system or npm run app:watchdog:install."
}

try {
    Import-Module WebAdministration -ErrorAction Stop
    $site = Get-Website -Name "Default Web Site" -ErrorAction SilentlyContinue
    if (-not $site) {
        $site = Get-Website | Where-Object { $_.PhysicalPath -eq "C:\inetpub\optilens-local-proxy" } | Select-Object -First 1
    }
    if ($site) {
        Set-ItemProperty "IIS:\Sites\$($site.Name)" -Name serverAutoStart -Value $true
        if ($site.State -ne "Started") {
            Start-Website -Name $site.Name
        }
        Write-Host "Hardened IIS site startup for '$($site.Name)'."
    } else {
        Write-Host "No OptiLens IIS proxy site found."
    }
} catch {
    Write-Host "IIS hardening skipped: $($_.Exception.Message)"
}

$healthUrl = "http://127.0.0.1:$Port/api/health/live"
for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
        if ($health.service -eq "optilens-local") {
            Write-Host "OptiLens Local is healthy at $healthUrl."
            exit 0
        }
    } catch {
    }
    Start-Sleep -Milliseconds 500
}

throw "OptiLens Local did not report healthy at $healthUrl."
