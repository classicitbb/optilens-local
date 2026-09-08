param(
    [string] $TaskName = "OptiLens Stock Submissions",
    [string] $ProjectRoot = "",
    [int] $IntervalMinutes = 5,
    [int] $Max = 3
)

# Registers a scheduled task that claims released stock web orders from the CV
# outbox and drops them into Innova's watched Incoming folder, every few
# minutes. The exact counterpart of install-rx-submissions-task.ps1, which had
# no stock equivalent — stock-submissions/process existed only as an on-demand
# HTTP endpoint nothing ever called, so an 'approved' stock_order_submissions
# row was never claimed by anything. That stranded BOTH sources of those rows:
# the staff Stock Order Builder's "Submit order" and a customer's store
# checkout.
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
$cli = Join-Path $ProjectRoot "scripts\stock-submissions-cli.js"
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
    -Description "Submits released stock web orders (staff builder and store checkout) to Innova's Incoming file-drop every $IntervalMinutes minute(s)." `
    -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes min, max $Max per run)."
Write-Host "Reminder: set OPTILENS_SYNC_PASSPHRASE (Machine scope) so the task can unlock the vault."
Write-Host "The task must run with network access to reach the Incoming share; if it was"
Write-Host "registered with an interactive-token principal, match it to 'OptiLens Rx Submissions'."
