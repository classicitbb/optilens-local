param(
    [string]$Name = "Edit OptiLens with Codex",
    [string]$ProjectRoot = "",
    [switch]$PublicDesktop
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$desktopPath = if ($PublicDesktop) {
    [Environment]::GetFolderPath("CommonDesktopDirectory")
} else {
    [Environment]::GetFolderPath("DesktopDirectory")
}

$shortcutPath = Join-Path $desktopPath "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$powershell = Get-Command powershell.exe -ErrorAction Stop
$shortcut.TargetPath = $powershell.Source
$launcherPath = Join-Path $PSScriptRoot "launch-codex.ps1"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -ProjectRoot `"$ProjectRoot`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,71"
$shortcut.Description = "Open Codex in the OptiLens Local repository."
$shortcut.Save()

Write-Host "Created $shortcutPath"
