param(
    [string] $TaskName = "OptiLens Actian Lens Status Sync",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 60
)

$ErrorActionPreference = "Stop"
if ($IntervalMinutes -lt 5) { throw "IntervalMinutes must be at least 5." }
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $ProjectRoot "scripts\sync-actian-lens-status.js"
if (-not (Test-Path -LiteralPath $cli)) { throw "Actian lens status sync script not found at $cli" }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`"" -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Mirrors active/inactive lens status from Actian Zen to Innovations SQL Server every $IntervalMinutes minute(s)." -Force | Out-Null
$marker = Join-Path $ProjectRoot "data\logs\actian-lens-status-sync-task.json"
New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
@{ name = "Actian lens status sync"; taskName = $TaskName; state = "registered"; intervalMinutes = $IntervalMinutes; installedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes minute(s))."
