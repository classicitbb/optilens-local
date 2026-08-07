<#
.SYNOPSIS
  Packs the BeSwift CO (Beta) extension into a signed .crx and refreshes the
  self-hosted update manifest that Edge polls.

.DESCRIPTION
  Shipping an update is: bump "version" in extensions/beswift-co-beta/manifest.json,
  run this script, done. Edge's force-installed copies pick it up on their next
  update check (the site bridge also requests one on every OptiLens page load).

  The signing key at data/ext/beswift-co-beta.pem is what keeps the extension ID
  stable at jdnkiokjepfphfjhedkdilniagobhkoe. It is gitignored and must be backed
  up  -  losing it means a new ID and re-pushing the Edge policy to every machine.
#>
param(
    [string] $ProjectRoot = "",
    [string] $BaseUrl = "http://ino-3frc3q3"
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }

$extensionDir = Join-Path $ProjectRoot "extensions\beswift-co-beta"
$keyFile      = Join-Path $ProjectRoot "data\ext\beswift-co-beta.pem"
$publicDir    = Join-Path $ProjectRoot "public\extensions"
$edge         = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if (-not (Test-Path $keyFile)) { throw "Signing key missing: $keyFile. Restore it from backup  -  regenerating changes the extension ID." }
if (-not (Test-Path $edge))    { throw "Edge not found at $edge" }
if (-not (Test-Path $publicDir)) { New-Item -ItemType Directory -Path $publicDir -Force | Out-Null }

$version = (Get-Content (Join-Path $extensionDir "manifest.json") -Raw | ConvertFrom-Json).version
Write-Host "Packing BeSwift CO (Beta) v$version"

# Pack from a scratch copy so nothing stray in the working tree ends up signed.
$staging = Join-Path $env:TEMP "olx-pack"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
$stagedExt = Join-Path $staging "beswift-co-beta"
robocopy $extensionDir $stagedExt /MIR /NFL /NDL /NJH /NJS | Out-Null

& $edge --pack-extension="$stagedExt" --pack-extension-key="$keyFile" --no-message-box | Out-Null
Start-Sleep -Seconds 8

$builtCrx = Join-Path $staging "beswift-co-beta.crx"
if (-not (Test-Path $builtCrx)) { throw "Pack failed  -  no .crx produced in $staging" }

$targetCrx = Join-Path $publicDir "beswift-co-beta.crx"
Copy-Item $builtCrx $targetCrx -Force

# Omaha-format update manifest. appid must match the extension ID derived from
# the signing key; codebase must be an absolute URL Edge can reach.
$appId = "jdnkiokjepfphfjhedkdilniagobhkoe"
$updateXml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$appId'>
    <updatecheck codebase='$BaseUrl/extensions/beswift-co-beta.crx' version='$version' />
  </app>
</gupdate>
"@
# Written BOM-less on purpose: Edge's update-manifest parser rejects a leading
# UTF-8 BOM, and PowerShell 5's -Encoding UTF8 always emits one.
$noBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $publicDir "beswift-co-beta-updates.xml"), $updateXml, $noBom)

$size = [math]::Round((Get-Item $targetCrx).Length / 1KB, 1)
Write-Host "Packed  -> $targetCrx ($size KB)"
Write-Host "Updated -> $(Join-Path $publicDir 'beswift-co-beta-updates.xml') (version $version)"
Remove-Item $staging -Recurse -Force
