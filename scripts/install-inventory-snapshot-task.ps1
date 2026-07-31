param(
    [string] $TaskName = "OptiLens Inventory Snapshot",
    [string] $ProjectRoot = "",
    [ValidateSet("Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday")]
    [string] $DayOfWeek = "Monday",
    [string] $AtTime = "06:15"
)

# Registers the weekly point-in-time inventory snapshot. Mirrors
# install-innovations-sync-task.ps1.
#
# Why this task matters more than a typical report job: LensItem.OnHand_* and
# MiscItems.OnHand are CURRENT values with no history in Innovations, and
# rebuilding them from StockTransactions is only ~89% accurate with no way to
# identify the wrong 11%. Cover-over-time and every forecast built on it are
# only trustworthy from the first captured snapshot onward, so a run that is
# missed is a permanent gap — it cannot be backfilled later.
#
# Reads live Innovations MSSQL and writes only to optilens_local. It needs no
# vault passphrase: both connections use configured SQL credentials.

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $ProjectRoot "scripts\run-inventory-snapshot.js"

if (-not (Test-Path $cli)) {
    throw "Snapshot script not found at $cli"
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`"" -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $AtTime
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Captures a weekly point-in-time inventory snapshot (on-hand, cost, speed class, cover) into optilens_local. On-hand has no history in Innovations, so a missed run is a permanent gap." `
    -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName ($DayOfWeek at $AtTime)."
Write-Host "StartWhenAvailable is set, so a run missed while the machine was off is caught up rather than skipped."
Write-Host "Run once now with: node `"$cli`""
