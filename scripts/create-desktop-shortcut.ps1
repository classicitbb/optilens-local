param(
    [string]$Url = "http://192.168.254.9:8080/",
    [string]$Name = "OptiLens Local",
    [int]$Port = 8080,
    [string]$ProjectRoot = "",
    [switch]$PublicDesktop
)

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$desktopPath = if ($PublicDesktop) {
    [Environment]::GetFolderPath("CommonDesktopDirectory")
} else {
    [Environment]::GetFolderPath("DesktopDirectory")
}

$shortcutPath = Join-Path $desktopPath "$Name.lnk"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$launcherScript = Join-Path $PSScriptRoot "launch-app.ps1"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShell
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherScript`" -ProjectRoot `"$ProjectRoot`" -Port $Port -Url `"$Url`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 7
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
$shortcut.Description = "Start OptiLens Local services and open the app."
$shortcut.Save()

Write-Host "Created $shortcutPath"
