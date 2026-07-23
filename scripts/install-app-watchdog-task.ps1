param(
    [string] $TaskName = "OptiLens Local Watchdog",
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [switch] $RunAsSystem
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$scriptPath = Join-Path $ProjectRoot "scripts\ensure-app-running.ps1"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ProjectRoot `"$ProjectRoot`" -Port $Port"

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $argument
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$minuteTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$registerArguments = @{
    TaskName = $TaskName
    Action = $action
    Trigger = @($startupTrigger, $minuteTrigger)
    Settings = $settings
    Description = "Keeps the OptiLens Local Node app running on port $Port."
    Force = $true
}

if ($RunAsSystem) {
    $registerArguments.Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
}

Register-ScheduledTask @registerArguments | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started scheduled task: $TaskName"
