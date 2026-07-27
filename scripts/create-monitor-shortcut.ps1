param(
    [string] $ProjectRoot = "",
    [string] $Name = "OptiLens Local Host Monitor",
    [switch] $PublicDesktop
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$exe = Join-Path $ProjectRoot "OptiLensHostMonitor.exe"
if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot "build-monitor-exe.ps1") -ProjectRoot $ProjectRoot }
$desktop = if ($PublicDesktop) { [Environment]::GetFolderPath("CommonDesktopDirectory") } else { [Environment]::GetFolderPath("DesktopDirectory") }
$shortcutPath = Join-Path $desktop "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
$shortcut.Description = "Start the OptiLens Local Host Monitor."
$shortcut.Save()
Write-Host "Created $shortcutPath"
