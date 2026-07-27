param(
    [string]$Name = "OptiLens Local Host Monitor",
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
$monitorExe = Join-Path $ProjectRoot "OptiLensHostMonitor.exe"
if (-not (Test-Path $monitorExe)) {
    & (Join-Path $PSScriptRoot "build-monitor-exe.ps1") -ProjectRoot $ProjectRoot
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $monitorExe
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
$shortcut.Description = "Start the OptiLens Local Host Monitor."
$shortcut.Save()

Write-Host "Created $shortcutPath"
