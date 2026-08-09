<#
.SYNOPSIS
  Force-installs the OptiLens BeSwift CO (Beta) extension in Microsoft Edge via
  machine policy. Run it from anywhere - it elevates itself.

.DESCRIPTION
  Writes HKLM policy so Edge installs the extension from our self-hosted update
  manifest and keeps it updated automatically. A force-installed extension
  cannot be disabled or removed by the user, which is the point: the Delivery
  and Export workflow depends on it being present and current.

  Also allows our own host as an off-store installation source, which Edge
  requires before it will accept a non-Store CRX.

  Intended to be run straight off the share, on a workstation with no checkout:
    powershell -ExecutionPolicy Bypass -File "\\INO-3FRC3Q3\GitHub\optilens-local\scripts\install-beswift-extension-policy.ps1"

  Undo with -Remove.
#>
param(
    [string] $BaseUrl = "http://ino-3frc3q3",
    [string] $ExtensionId = "jdnkiokjepfphfjhedkdilniagobhkoe",
    [switch] $Remove,
    [switch] $Elevated
)

$ErrorActionPreference = "Stop"

function Test-Elevated {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate rather than making the operator hunt for an admin prompt. The
# -Elevated guard stops an infinite relaunch loop if UAC hands back a token
# that still is not administrative.
if (-not (Test-Elevated)) {
    if ($Elevated) { throw "Elevation was requested but this process is still not running as Administrator." }
    Write-Host "Not elevated - relaunching with an administrator prompt..."
    $argList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-BaseUrl", "`"$BaseUrl`"",
        "-ExtensionId", "`"$ExtensionId`"",
        "-Elevated"
    )
    if ($Remove) { $argList += "-Remove" }
    try {
        $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList -Wait -PassThru
        if ($proc.ExitCode -ne 0) { throw "The elevated run exited with code $($proc.ExitCode)." }
    } catch {
        throw "Could not elevate: $($_.Exception.Message). Right-click PowerShell, choose 'Run as administrator', and run this script again."
    }
    return
}

$edgePolicy = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
$forcelist  = Join-Path $edgePolicy "ExtensionInstallForcelist"
$sources    = Join-Path $edgePolicy "ExtensionInstallSources"
$updateXml  = "$BaseUrl/extensions/beswift-co-beta-updates.xml"
$entry      = "$ExtensionId;$updateXml"

# Read values with Get-ItemProperty, NOT Get-Item: the PowerShell registry
# provider opens a key for read/write when you Get-Item it, which throws
# "Requested registry access is not allowed" on protected policy keys even when
# you only intend to read. Get-ItemProperty asks for read access only.
function Get-MatchingValueNames {
    param([string] $KeyPath, [string] $Match)
    if (-not (Test-Path $KeyPath)) { return @() }
    $props = Get-ItemProperty -Path $KeyPath -ErrorAction SilentlyContinue
    if (-not $props) { return @() }
    return @(
        $props.PSObject.Properties |
            Where-Object { $_.Name -notlike "PS*" -and $_.Value -like $Match } |
            ForEach-Object { $_.Name }
    )
}

function Get-NextSlot {
    param([string] $KeyPath)
    $props = Get-ItemProperty -Path $KeyPath -ErrorAction SilentlyContinue
    $used = @()
    if ($props) {
        $used = @(
            $props.PSObject.Properties |
                Where-Object { $_.Name -notlike "PS*" -and $_.Name -match '^\d+$' } |
                ForEach-Object { [int]$_.Name } | Sort-Object
        )
    }
    if ($used.Count) { return "$($used[-1] + 1)" }
    return "1"
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

# Reuse the slot already holding our entry so re-running is idempotent rather
# than stacking duplicates.
$existing = Get-MatchingValueNames -KeyPath $forcelist -Match "$ExtensionId*"
$slot = if ($existing.Count -gt 0) { $existing[0] } else { Get-NextSlot -KeyPath $forcelist }
Set-ItemProperty -Path $forcelist -Name $slot -Value $entry -Type String
Write-Host "Forcelist[$slot] = $entry"

$sourcePattern = "$BaseUrl/*"
if ((Get-MatchingValueNames -KeyPath $sources -Match $sourcePattern).Count -eq 0) {
    $sourceSlot = Get-NextSlot -KeyPath $sources
    Set-ItemProperty -Path $sources -Name $sourceSlot -Value $sourcePattern -Type String
    Write-Host "InstallSources[$sourceSlot] = $sourcePattern"
}

Write-Host ""
Write-Host "Policy written. Restart Edge (or open edge://policy and choose Reload policies)."
Write-Host "Edge will install $ExtensionId from $updateXml and keep it updated."
Write-Host ""
Write-Host "If the extension is ALSO loaded unpacked in this browser, remove it first -"
Write-Host "it shares the same extension id and will block the policy install."
