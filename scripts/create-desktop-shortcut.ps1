param(
    [string]$Url = "http://192.168.254.9:8080/",
    [string]$Name = "OptiLens Local",
    [switch]$PublicDesktop
)

$desktopPath = if ($PublicDesktop) {
    [Environment]::GetFolderPath("CommonDesktopDirectory")
} else {
    [Environment]::GetFolderPath("DesktopDirectory")
}

$shortcutPath = Join-Path $desktopPath "$Name.url"

$content = @(
    "[InternetShortcut]",
    "URL=$Url",
    "IconFile=$Url/icons/optilens.svg",
    "IconIndex=0"
)

Set-Content -LiteralPath $shortcutPath -Value $content -Encoding ASCII
Write-Host "Created $shortcutPath"
