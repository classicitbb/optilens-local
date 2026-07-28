param(
    [string] $TaskName = "OptiLens Local Watchdog",
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [switch] $RunAsSystem,
    [string] $RunAsUser = "",
    [System.Management.Automation.PSCredential] $Credential = $null
)

$ErrorActionPreference = "Stop"

if ($RunAsSystem -and ($RunAsUser -or $Credential)) {
    throw "Choose either -RunAsSystem or -RunAsUser/-Credential, not both."
}

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$userAccount = ""
$password = ""
if (-not $RunAsSystem) {
    if (-not $RunAsUser) {
        $RunAsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    }

    if (-not $Credential) {
        $Credential = Get-Credential `
            -UserName $RunAsUser `
            -Message "Enter the Windows password for the account that should run OptiLens Local before desktop sign-in."
    }

    $userAccount = $Credential.UserName
    $password = $Credential.GetNetworkCredential().Password

    if (-not $password) {
        throw "A Windows account password is required for a task that runs whether the user is logged on or not."
    }
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
} else {
    $registerArguments.User = $userAccount
    $registerArguments.Password = $password
    $registerArguments.RunLevel = "Highest"
}

Register-ScheduledTask @registerArguments | Out-Null

Start-ScheduledTask -TaskName $TaskName
if ($RunAsSystem) {
    Write-Host "Installed and started scheduled task as SYSTEM: $TaskName"
} else {
    Write-Host "Installed and started scheduled task as ${userAccount}: $TaskName"
    Write-Host "The task is configured to run whether that user is logged on or not."
}
