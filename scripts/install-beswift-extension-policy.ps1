<#
.SYNOPSIS
  Force-installs the OptiLens BeSwift CO (Beta) extension in Microsoft Edge via
  machine policy. Run once per workstation, elevated.

.DESCRIPTION
  Writes HKLM policy so Edge installs the extension from our self-hosted update
  manifest and keeps it updated automatically. A force-installed extension
  cannot be disabled or removed by the user, which is the point: the Delivery
  and Export workflow depends on it being present and current.

  Also allows our own host as an off-store installation source, which Edge
  requires before it will accept a non-Store CRX.

  Undo with -Remove.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-beswift-extension-policy.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-beswift-extension-policy.ps1 -Remove
#>
param(
    [string] $BaseUrl = "http://ino-3frc3q3",
    [string] $ExtensionId = "jdnkiokjepfphfjhedkdilniagobhkoe",
    [switch] $Remove
)

$ErrorActionPreference = "Stop"

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script writes HKLM policy and must be run as Administrator."
}

$edgePolicy = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
$forcelist  = Join-Path $edgePolicy "ExtensionInstallForcelist"
$sources    = Join-Path $edgePolicy "ExtensionInstallSources"
$updateXml  = "$BaseUrl/extensions/beswift-co-beta-updates.xml"
$entry      = "$ExtensionId;$updateXml"

function Get-MatchingValueNames {
    param([string] $KeyPath, [string] $Match)
    if (-not (Test-Path $KeyPath)) { return @() }
    $key = Get-Item $KeyPath
    return @($key.GetValueNames() | Where-Object { $key.GetValue($_) -like $Match })
}

if ($Remove) {
    foreach ($name in Get-MatchingValueNames -KeyPath $forcelist -Match "$ExtensionId*") {
        Remove-ItemProperty -Path $forcelist -Name $name -Force
        Write-Host "Removed forcelist entry $name"
    }
    foreach ($name in Get-MatchingValueNames -KeyPath $sources -Match "*$($BaseUrl.Replace('http://',''))*") {
        Remove-ItemProperty -Path $sources -Name $name -Force
        Write-Host "Removed install source $name"
    }
    Write-Host "Policy removed. Restart Edge; the extension will be uninstalled."
    return
}

foreach ($path in @($forcelist, $sources)) {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
}

# Forcelist and sources are numbered string values ("1", "2", ...). Reuse the
# slot already holding our entry so re-running is idempotent rather than
# stacking duplicates.
$existing = Get-MatchingValueNames -KeyPath $forcelist -Match "$ExtensionId*"
if ($existing.Count -gt 0) {
    $slot = $existing[0]
} else {
    $used = @((Get-Item $forcelist).GetValueNames() | ForEach-Object { [int]$_ } | Sort-Object)
    $slot = "$(if ($used.Count) { $used[-1] + 1 } else { 1 })"
}
Set-ItemProperty -Path $forcelist -Name $slot -Value $entry -Type String
Write-Host "Forcelist[$slot] = $entry"

$sourcePattern = "$BaseUrl/*"
$existingSource = Get-MatchingValueNames -KeyPath $sources -Match $sourcePattern
if ($existingSource.Count -eq 0) {
    $used = @((Get-Item $sources).GetValueNames() | ForEach-Object { [int]$_ } | Sort-Object)
    $slot = "$(if ($used.Count) { $used[-1] + 1 } else { 1 })"
    Set-ItemProperty -Path $sources -Name $slot -Value $sourcePattern -Type String
    Write-Host "InstallSources[$slot] = $sourcePattern"
}

Write-Host ""
Write-Host "Policy written. Restart Edge (or browse to edge://policy and Reload policies)."
Write-Host "Edge will install $ExtensionId from $updateXml and keep it updated."
