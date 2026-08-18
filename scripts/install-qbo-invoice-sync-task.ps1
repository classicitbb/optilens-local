param(
    [string] $TaskName = "OptiLens QuickBooks Invoice Sync",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 30,
    [switch] $Apply
)

$ErrorActionPreference = "Stop"
if ($IntervalMinutes -lt 5) { throw "IntervalMinutes must be at least 5." }
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $ProjectRoot "scripts\sync-qbo-invoices.js"
if (-not (Test-Path -LiteralPath $cli)) { throw "QBO invoice sync script not found at $cli" }
$mode = if ($Apply) { " --apply" } else { "" }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`"$mode" -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Reads Innovations invoices and synchronizes them to QuickBooks ($($(if ($Apply) { 'apply' } else { 'dry-run' })) mode) every $IntervalMinutes minute(s)." -Force | Out-Null
$marker = Join-Path $ProjectRoot "data\logs\qbo-invoice-sync-task.json"
New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
@{ name = "Innovations → QuickBooks invoices"; taskName = $TaskName; state = "registered"; intervalMinutes = $IntervalMinutes; mode = if ($Apply) { "apply" } else { "dry-run" }; installedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes minute(s), mode=$($(if ($Apply) { 'apply' } else { 'dry-run' })))."
