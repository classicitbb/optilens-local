# HTTPS helpers for Install-OptiLens.ps1: the app serves HTTPS itself (lib/tls-front.js),
# so the installer needs a certificate, open ports and a check, not IIS.
#
# The functions at the top are pure so they can be tested on any machine. The ones
# under "Machine" read or change the server. Written for Windows PowerShell 5.1 and 7.
# Uses Set-RestrictedAcl from OptiLens.Install.psm1, which the installer imports first.

Set-StrictMode -Version 2.0

# ---------------------------------------------------------------- Pure helpers

function Get-TlsNameSet {
    # The names and addresses the server certificate must cover. Pure: the caller
    # supplies what it found on the machine.
    param(
        [Parameter(Mandatory)] [string] $ComputerName,
        [string] $Fqdn = '',
        [string[]] $IpAddresses = @(),
        [string[]] $ExtraNames = @(),
        [string] $PublicHost = ''
    )
    $valid = '^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$'
    $short = $ComputerName.ToLowerInvariant()
    if (-not $PublicHost) { $PublicHost = $short }
    $dns = New-Object System.Collections.Generic.List[string]
    foreach ($name in @($PublicHost, $short, $Fqdn) + @($ExtraNames) + @('localhost')) {
        if (-not $name) { continue }
        $name = $name.Trim().ToLowerInvariant()
        if ($name -notmatch $valid) { throw "'$name' is not a valid host name for the certificate." }
        if (-not $dns.Contains($name)) { $dns.Add($name) }
    }
    $ips = New-Object System.Collections.Generic.List[string]
    foreach ($ip in @($IpAddresses)) {
        $parsed = $null
        if (-not $ip -or -not [System.Net.IPAddress]::TryParse($ip, [ref] $parsed)) { continue }
        if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
        $text = $parsed.ToString()
        if ($text -like '127.*' -or $text -like '169.254.*' -or $text -eq '0.0.0.0') { continue }
        if (-not $ips.Contains($text)) { $ips.Add($text) }
    }
    $ips.Add('127.0.0.1')
    return [PSCustomObject]@{ PublicHost = $PublicHost.Trim().ToLowerInvariant(); DnsNames = $dns.ToArray(); IpAddresses = $ips.ToArray() }
}

function ConvertTo-SanExtension {
    # Subject Alternative Name in the text form New-SelfSignedCertificate accepts.
    param([Parameter(Mandatory)] $Names)
    $parts = @($Names.DnsNames | ForEach-Object { "DNS=$_" }) + @($Names.IpAddresses | ForEach-Object { "IPAddress=$_" })
    return '2.5.29.17={text}' + ($parts -join '&')
}

function Test-HttpsAnswers {
    # Problems with the optional "https" answers. Empty means usable.
    param([Parameter(Mandatory)] $Answers)
    $problems = New-Object System.Collections.Generic.List[string]
    $get = {
        param($path)
        $node = $Answers
        foreach ($part in $path.Split('.')) {
            if ($null -eq $node) { return $null }
            $prop = $node.PSObject.Properties[$part]
            if ($null -eq $prop) { return $null }
            $node = $prop.Value
        }
        return $node
    }
    foreach ($key in 'https.httpsPort', 'https.httpPort') {
        $value = & $get $key
        if ($null -ne $value -and "$value" -ne '' -and ("$value" -notmatch '^\d+$' -or [int]"$value" -lt 1 -or [int]"$value" -gt 65535)) { $problems.Add("$key must be between 1 and 65535.") }
    }
    $names = @(& $get 'https.extraNames') + @(& $get 'https.publicHost')
    foreach ($name in $names) {
        if ($name -and "$name" -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { $problems.Add("https name '$name' is not a valid host name.") }
    }
    return , $problems.ToArray()
}

function Get-TlsMaterialProblem {
    # Says why the existing certificate bundle cannot be kept, or $null when it can.
    # Names are looked for as text so the check does not depend on the Windows language.
    param([Parameter(Mandatory)] [string] $PfxPath, [Parameter(Mandatory)] [string] $Passphrase, [Parameter(Mandatory)] $Names, [int] $MinDays = 60)
    if (-not (Test-Path -LiteralPath $PfxPath)) { return 'no certificate yet' }
    try { $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $Passphrase) }
    catch { return 'the certificate file cannot be opened with the saved passphrase' }
    try {
        if ($cert.NotAfter -lt (Get-Date).AddDays($MinDays)) { return "the certificate ends $($cert.NotAfter.ToString('yyyy-MM-dd'))" }
        $san = ($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ' '
        foreach ($name in @($Names.DnsNames) + @($Names.IpAddresses)) {
            if ($san -notmatch ('(?<![\w.-])' + [regex]::Escape($name) + '(?![\w.-])')) { return "the certificate does not cover $name" }
        }
        return $null
    }
    finally { $cert.Dispose() }
}

# -------------------------------------------------------------------- Machine

function Get-LanIPv4Addresses {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        ForEach-Object { $_.IPAddress })
}

function Get-MachineFqdn {
    try { return [System.Net.Dns]::GetHostEntry([Environment]::MachineName).HostName } catch { return '' }
}

function Get-PortOwner {
    # Name of the process listening on a TCP port, or $null when it is free.
    param([Parameter(Mandatory)] [int] $Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) { return $proc.ProcessName }
    return "process $($conn.OwningProcess)"
}

function New-OptiLensTlsCertificate {
    # Makes (or reuses) a local root CA, signs a server certificate for the names, and
    # writes the server certificate and key as a password-protected .pfx. The root's
    # private key stays in the certificate store, not exportable. Only its public
    # certificate (.cer) is written out, for devices to trust.
    param(
        [Parameter(Mandatory)] $Names,
        [Parameter(Mandatory)] [string] $PfxPath,
        [Parameter(Mandatory)] [string] $Passphrase,
        [Parameter(Mandatory)] [string] $RootCerPath,
        [string] $StorePath = 'Cert:\LocalMachine\My',
        [switch] $TrustRootHere
    )
    $rootName = 'OptiLens Local Root CA'
    $leafName = 'OptiLens HTTPS server'
    $root = Get-ChildItem $StorePath | Where-Object { $_.FriendlyName -eq $rootName -and $_.NotAfter -gt (Get-Date).AddDays(365) } | Sort-Object NotAfter -Descending | Select-Object -First 1
    if (-not $root) {
        $root = New-SelfSignedCertificate -Type Custom -Subject "CN=OptiLens Local Root CA ($($env:COMPUTERNAME)), O=OptiLens" `
            -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign, CRLSign `
            -TextExtension @('2.5.29.19={critical}{text}CA=true') -KeyExportPolicy NonExportable `
            -NotAfter (Get-Date).AddYears(10) -CertStoreLocation $StorePath -FriendlyName $rootName
    }
    # Under 825 days, the longest iOS accepts for a certificate from a CA the user added.
    $leaf = New-SelfSignedCertificate -Type Custom -Subject "CN=$($Names.PublicHost), O=OptiLens" -Signer $root `
        -KeyAlgorithm RSA -KeyLength 2048 -KeySpec KeyExchange -HashAlgorithm SHA256 `
        -Provider 'Microsoft RSA SChannel Cryptographic Provider' -KeyUsage DigitalSignature, KeyEncipherment `
        -TextExtension @((ConvertTo-SanExtension $Names), '2.5.29.19={text}CA=false', '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
        -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(800) -CertStoreLocation $StorePath -FriendlyName $leafName
    try {
        New-Item -ItemType Directory -Path (Split-Path -Parent $PfxPath) -Force | Out-Null
        $secure = ConvertTo-SecureString -String $Passphrase -AsPlainText -Force
        Export-PfxCertificate -Cert $leaf -FilePath $PfxPath -Password $secure | Out-Null
        Export-Certificate -Cert $root -FilePath $RootCerPath -Force | Out-Null
    }
    finally { Remove-Item -LiteralPath $leaf.PSPath -Force -ErrorAction SilentlyContinue }
    Set-RestrictedAcl -Path $PfxPath
    # Without this the server's own browser and the installer's check would not trust it.
    if ($TrustRootHere -and -not (Get-ChildItem 'Cert:\LocalMachine\Root' | Where-Object { $_.Thumbprint -eq $root.Thumbprint })) {
        Import-Certificate -FilePath $RootCerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
    }
    return [PSCustomObject]@{ RootThumbprint = $root.Thumbprint; Expires = $leaf.NotAfter }
}

function Get-HttpStatus {
    # Status code of a GET without following redirects, and the Location header.
    # Sets TLS 1.2 first because Windows PowerShell 5.1 does not use it by default.
    param([Parameter(Mandatory)] [string] $Uri, [int] $TimeoutSec = 5)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutSec * 1000
    try { $response = $request.GetResponse() }
    catch [System.Net.WebException] {
        if (-not $_.Exception.Response) { throw }
        $response = $_.Exception.Response
    }
    try { return [PSCustomObject]@{ Status = [int]$response.StatusCode; Location = $response.Headers['Location'] } }
    finally { $response.Close() }
}

Export-ModuleMember -Function *
