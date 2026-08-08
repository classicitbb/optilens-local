param(
    [ValidateSet("Status", "RenewServerCertificate", "ExportRootCertificate")]
    [string] $Action = "Status",
    [string] $ProjectRoot = "",
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$hostname = "optilens.cv.net"
$rootFriendlyName = "OptiLens Local Root CA"
$leafFriendlyName = "OptiLens HTTPS - optilens.cv.net"
$certificateDirectory = Join-Path $ProjectRoot "data\certificates"
$rootExportPath = Join-Path $certificateDirectory "OptiLens-Local-Root-CA.cer"

function Get-OptiLensRoot {
    Get-ChildItem "Cert:\LocalMachine\My" | Where-Object FriendlyName -eq $rootFriendlyName | Select-Object -First 1
}

function Get-OptiLensLeaf {
    Get-ChildItem "Cert:\LocalMachine\My" | Where-Object FriendlyName -eq $leafFriendlyName | Select-Object -First 1
}

function Export-OptiLensRoot {
    $root = Get-OptiLensRoot
    if (-not $root) { throw "The OptiLens local root CA is missing." }
    New-Item -ItemType Directory -Force -Path $certificateDirectory | Out-Null
    Export-Certificate -Cert $root -FilePath $rootExportPath -Force | Out-Null
    return $root
}

function Set-IisLeafCertificate([string] $Thumbprint) {
    Import-Module WebAdministration -ErrorAction Stop
    $binding = Get-WebBinding -Name "Default Web Site" -Protocol "https" | Select-Object -First 1
    if (-not $binding) { throw "The Default Web Site HTTPS binding is missing." }
    $binding.AddSslCertificate($Thumbprint, "my")
}

function Renew-OptiLensLeaf {
    $root = Get-OptiLensRoot
    if (-not $root) { throw "The OptiLens local root CA is missing; refusing to create an untrusted replacement." }
    $existing = Get-OptiLensLeaf
    $leaf = New-SelfSignedCertificate -Type Custom `
        -Subject "CN=$hostname, O=Classic Visions" `
        -DnsName $hostname `
        -Signer $root `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -KeyUsage DigitalSignature,KeyEncipherment `
        -TextExtension @("2.5.29.19={text}CA=false", "2.5.29.37={text}1.3.6.1.5.5.7.3.1") `
        -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddYears(2) `
        -CertStoreLocation "Cert:\LocalMachine\My" `
        -FriendlyName $leafFriendlyName
    Set-IisLeafCertificate $leaf.Thumbprint
    if ($existing) { Remove-Item -LiteralPath $existing.PSPath -Force }
    return $leaf
}

if ($Action -eq "RenewServerCertificate") {
    Renew-OptiLensLeaf | Out-Null
}

$root = Export-OptiLensRoot
$leaf = Get-OptiLensLeaf

[pscustomobject]@{
    hostname = $hostname
    rootCertificate = [pscustomobject]@{
        thumbprint = $root.Thumbprint
        expires = $root.NotAfter.ToString("o")
        publicCertificate = $rootExportPath
    }
    serverCertificate = if ($leaf) {
        [pscustomobject]@{ thumbprint = $leaf.Thumbprint; expires = $leaf.NotAfter.ToString("o"); valid = $leaf.NotAfter -gt (Get-Date) }
    } else { $null }
    action = $Action
}
