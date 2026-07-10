param(
    [string] $TaskName = "",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 60,
    [switch] $DryRun,
    [switch] $ServeRequests   # process the cloud "Sync now" queue instead of a full sync
)

# Registers a scheduled task that pushes selected Innovations data to the
# Classic Visions cloud on an interval. Mirrors install-app-watchdog-task.ps1.
#
# IMPORTANT: the task runs unattended, so it needs the vault PASSPHRASE to
# unlock and decrypt the stored CV API key. Set it once at machine scope (admin):
#   [Environment]::SetEnvironmentVariable("OPTILENS_SYNC_PASSPHRASE","<passphrase>","Machine")
# Keep it protected — it unlocks the CV API credential.

$ErrorActionPreference = "Stop"

# The full sync and the cloud-request poller are separate schedules. Giving
# them distinct defaults prevents the second install from replacing the first.
if (-not $TaskName) {
    $TaskName = if ($ServeRequests) { "OptiLens Innovations Sync Requests" } else { "OptiLens Innovations Sync" }
}

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $ProjectRoot "scripts\innovations-sync-cli.js"
$dry = if ($DryRun) { " --dry-run" } else { "" }
$serve = if ($ServeRequests) { " --serve-requests" } else { "" }
$argument = "`"$cli`"$dry$serve"

$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $(if ($ServeRequests) { "Processes Classic Visions Sync now requests every $IntervalMinutes minute(s)." } else { "Pushes selected Innovations data to the Classic Visions cloud every $IntervalMinutes minute(s)." }) `
    -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes min, DryRun=$($DryRun.IsPresent), ServeRequests=$($ServeRequests.IsPresent))."
Write-Host "Reminder: set OPTILENS_SYNC_PASSPHRASE (Machine scope) so the task can unlock the vault."
