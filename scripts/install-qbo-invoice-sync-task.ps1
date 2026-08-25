param(
    [string] $TaskName = "OptiLens QuickBooks Invoice Sync",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 30,
    [switch] $Apply
)

$ErrorActionPreference = "Stop"
if ($IntervalMinutes -lt 5) { throw "IntervalMinutes must be at least 5." }
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$runner = Join-Path $ProjectRoot "scripts\run-qbo-invoice-sync-hidden.ps1"
if (-not (Test-Path -LiteralPath $runner)) { throw "QBO invoice sync runner not found at $runner" }
$node = (Get-Command node -ErrorAction Stop).Source
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$mode = if ($Apply) { " -Apply" } else { "" }
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -ProjectRoot `"$ProjectRoot`" -NodePath `"$node`"$mode" -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Reads Innovations invoices and synchronizes them to QuickBooks ($($(if ($Apply) { 'apply' } else { 'dry-run' })) mode) every $IntervalMinutes minute(s)." -Force | Out-Null
$marker = Join-Path $ProjectRoot "data\logs\qbo-invoice-sync-task.json"
New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
@{ name = "Innovations → QuickBooks invoices"; taskName = $TaskName; state = "registered"; intervalMinutes = $IntervalMinutes; mode = if ($Apply) { "apply" } else { "dry-run" }; installedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes minute(s), mode=$($(if ($Apply) { 'apply' } else { 'dry-run' })))."
