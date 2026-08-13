param(
    [string] $TaskName = "OptiLens RX Alias Catalog Sync",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 1440
)
$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$cli = Join-Path $ProjectRoot "scripts\sync-rx-catalog.js"
if (-not (Test-Path $cli)) { throw "RX catalog sync script not found at $cli" }
$runner = Join-Path $ProjectRoot "scripts\run-rx-catalog-sync-hidden.ps1"
if (-not (Test-Path $runner)) { throw "RX catalog sync hidden runner not found at $runner" }
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -ProjectRoot `"$ProjectRoot`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Refreshes the read-only Zen RX alias catalog used by OptiLens Local." -Force | Out-Null
$marker = Join-Path $ProjectRoot "data\logs\rx-catalog-sync-task.json"
New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
@{ name = "RX alias catalog sync"; taskName = $TaskName; state = "registered"; intervalMinutes = $IntervalMinutes; installedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes minute(s))."
