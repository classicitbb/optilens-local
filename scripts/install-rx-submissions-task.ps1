param(
    [string] $TaskName = "OptiLens Rx Submissions",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 5,
    [int] $Max = 3
)

# Registers a scheduled task that claims staff-released Rx web orders from the
# CV outbox and submits them to Innovations (InnovaAPI or file-drop), every
# few minutes. Mirrors install-innovations-sync-task.ps1 -ServeRequests, which
# this previously had no equivalent of — rx-submissions/process existed only
# as an on-demand HTTP endpoint nothing ever called.
#
# IMPORTANT: the task runs unattended, so it needs the vault PASSPHRASE to
# unlock and decrypt the stored CV API key. Set it once at machine scope (admin):
#   [Environment]::SetEnvironmentVariable("OPTILENS_SYNC_PASSPHRASE","<passphrase>","Machine")
# Keep it protected — it unlocks the CV API credential.

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $ProjectRoot "scripts\rx-submissions-cli.js"
$argument = "`"$cli`" --max $Max"

$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Submits staff-released Rx web orders to Innovations (InnovaAPI or file-drop) every $IntervalMinutes minute(s)." `
    -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes min, max $Max per run)."
Write-Host "Reminder: set OPTILENS_SYNC_PASSPHRASE (Machine scope) so the task can unlock the vault."
