<#
.SYNOPSIS
  Installs OptiLens (a licensed edition) on a blank Windows server.

.DESCRIPTION
  Run from an elevated PowerShell in the folder the vendor delivered the code to.
  The installer
    1. installs Node.js, the Claude Code CLI (with Git for Windows), and SQL Server Express
       unless an existing instance is chosen,
    2. checks the licence file, applies it and installs the app's packages,
    3. creates the database and application login, applies migrations,
    4. creates the lab's administrator and saves its site settings,
    5. makes a local certificate and has the app serve HTTPS (443, with 80 redirecting),
    6. starts the app, keeps it running, and checks that it works.

  Non-secret answers can come from -ConfigFile (see install.config.example.json);
  anything missing is asked for. Passwords are never read from a file, parameter
  or environment variable: the installer asks at a masked prompt, or generates
  them. Safe to run again: every step checks whether it is already done.

  Full instructions: docs/INSTALL_LICENSED_EDITION.md

.PARAMETER ConfigFile
  JSON file of non-secret answers.
.PARAMETER LicenceFile
  The signed licence (edition.json) the vendor sent. Overrides licenceFile in the config.
.PARAMETER DryRun
  Detects and asks, prints the plan, and changes nothing.
.PARAMETER NoHttps
  Leave the app on plain HTTP (the port in the config, open to the local network).
  By default the app serves HTTPS on 443 itself, redirects port 80 to it, and the
  installer makes a local certificate authority for the server's names.
.PARAMETER SkipWatchdog
  Do not register the scheduled task that starts and supervises the app.
.PARAMETER AllowFullEdition
  Continue even though this tree is not a licensed build (internal use only).
#>
[CmdletBinding()]
param(
    [string] $ConfigFile = '',
    [string] $LicenceFile = '',
    [switch] $DryRun,
    [switch] $NoHttps,
    [switch] $SkipWatchdog,
    [switch] $AllowFullEdition
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DataDir = Join-Path $Root 'data'
$StatePath = Join-Path $DataDir 'install-state.json'
$EnvPath = Join-Path $Root '.env'
Import-Module (Join-Path $PSScriptRoot 'OptiLens.Install.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'OptiLens.Https.psm1') -Force

$script:Results = New-Object System.Collections.Generic.List[object]
$script:Licensee = ''
$script:State = Get-InstallState -Path $StatePath

# ------------------------------------------------------------------- Output

function Write-Step {
    param([string] $Status, [string] $Name, [string] $Detail = '')
    $colour = @{ PASS = 'Green'; SKIP = 'DarkGray'; FAIL = 'Red'; PLAN = 'Cyan'; WARN = 'Yellow' }[$Status]
    $line = '{0,-5} {1}' -f $Status, $Name
    if ($Detail) { $line += " - $Detail" }
    Write-Host $line -ForegroundColor $colour
    $script:Results.Add([PSCustomObject]@{ Status = $Status; Step = $Name; Detail = $Detail })
}

function Invoke-Step {
    # Runs one step. -IsDone says whether it already holds; -Do does the work.
    param([string] $Name, [scriptblock] $IsDone, [scriptblock] $Do, [string] $Plan)
    if ($DryRun) { Write-Step 'PLAN' $Name $Plan; return }
    try {
        if ($IsDone -and (& $IsDone)) { Write-Step 'SKIP' $Name 'already done'; return }
        $detail = & $Do
        Write-Step 'PASS' $Name ([string]($detail | Select-Object -Last 1))
        $script:State.completed = @($script:State.completed | Where-Object { $_ -ne $Name }) + $Name
        Save-InstallState -Path $StatePath -State $script:State
    }
    catch {
        Write-Step 'FAIL' $Name $_.Exception.Message
        Write-Host "`nStopped at step '$Name'. Fix the cause and run the installer again; finished steps are skipped." -ForegroundColor Red
        exit 1
    }
}

# ------------------------------------------------------------------ Answers

function ConvertTo-Hashtable($Object) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        $h = @{}; foreach ($k in $Object.Keys) { $h[$k] = ConvertTo-Hashtable $Object[$k] }; return $h
    }
    if ($Object -is [PSCustomObject]) {
        $h = @{}; foreach ($p in $Object.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }; return $h
    }
    return $Object
}

function Get-Path($Table, [string] $Path) {
    $node = $Table
    foreach ($part in $Path.Split('.')) {
        if ($node -isnot [hashtable] -or -not $node.ContainsKey($part)) { return $null }
        $node = $node[$part]
    }
    return $node
}

function Set-Path($Table, [string] $Path, $Value) {
    $parts = $Path.Split('.')
    $node = $Table
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        if ($node[$parts[$i]] -isnot [hashtable]) { $node[$parts[$i]] = @{} }
        $node = $node[$parts[$i]]
    }
    $node[$parts[-1]] = $Value
}

$script:Interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

function Get-Answer {
    # Value from the config or an earlier run, else asked. Optional answers may stay blank.
    param([string] $Path, [string] $Prompt, [string] $Default = '', [switch] $Optional)
    $value = Get-Path $script:Answers $Path
    if ($null -ne $value -and "$value" -ne '') { return "$value" }
    if (-not $script:Interactive) {
        if ($Optional) { return $Default }
        throw "Missing answer '$Path'. Add it to the config file."
    }
    $label = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
    $reply = Read-Host $label
    if (-not $reply) { $reply = $Default }
    if (-not $reply -and -not $Optional) { throw "An answer is required for '$Path'." }
    Set-Path $script:Answers $Path $reply
    return $reply
}

function Read-Secret {
    param([string] $Prompt, [switch] $Confirm)
    if (-not $script:Interactive) { throw "'$Prompt' must be typed by a person at a console. Run the installer in a terminal where someone can answer." }
    while ($true) {
        $a = Read-Host $Prompt -AsSecureString
        if ($Confirm) {
            $b = Read-Host 'Type it again' -AsSecureString
            if ((ConvertFrom-Secure $a) -ne (ConvertFrom-Secure $b)) { Write-Host 'They do not match.' -ForegroundColor Yellow; continue }
        }
        return $a
    }
}

function ConvertFrom-Secure([System.Security.SecureString] $Secure) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Confirm-Yes([string] $Question, [bool] $Default = $false) {
    if (-not $script:Interactive) { return $Default }
    $hint = if ($Default) { 'Y/n' } else { 'y/N' }
    $reply = Read-Host "$Question [$hint]"
    if (-not $reply) { return $Default }
    return $reply -match '^(y|yes)$'
}

# ------------------------------------------------------------------ Preflight

Write-Host "OptiLens installer - $Root" -ForegroundColor Cyan
if (-not $DryRun) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null; Start-Transcript -Path (Join-Path $DataDir 'install.log') -Append | Out-Null }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) { Write-Step 'FAIL' 'Run as administrator' 'Open PowerShell with "Run as administrator" and start the installer again.'; exit 1 }
if (-not $isAdmin) { Write-Step 'WARN' 'Administrator' 'Not elevated. A dry run only reads; the real install needs an elevated PowerShell.' }
if (-not (Test-Path (Join-Path $Root 'server.js'))) { Write-Step 'FAIL' 'Find the application' "server.js was not found under $Root. Run this script from the delivered code folder."; exit 1 }
if (-not $script:Interactive -and -not $DryRun) { Write-Step 'FAIL' 'Console' 'The installer asks for passwords, so it needs a terminal a person can type in.'; exit 1 }
$drive = Get-PSDrive -Name ($Root.Substring(0, 1)) -ErrorAction SilentlyContinue
if ($drive -and $drive.Free -lt 3GB) { Write-Step 'FAIL' 'Disk space' "Less than 3 GB free on $($drive.Name):."; exit 1 }
Write-Step 'PASS' 'Preflight' 'administrator, application folder, console, disk'

# -------------------------------------------------------------------- Answers

$script:Answers = @{}
if ($ConfigFile) {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { Write-Step 'FAIL' 'Read config' "$ConfigFile was not found."; exit 1 }
    $script:Answers = ConvertTo-Hashtable (Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json)
}
# Answers given on an earlier run fill gaps, so a resumed run does not ask again.
$earlier = ConvertTo-Hashtable $script:State.answers
foreach ($key in @($earlier.Keys)) { if (-not $script:Answers.ContainsKey($key)) { $script:Answers[$key] = $earlier[$key] } }
if ($LicenceFile) { $script:Answers['licenceFile'] = $LicenceFile }

try {
    Write-Host "`nA few questions. Press Enter to accept a value in [brackets].`n"
    $licenceSource = Get-Answer 'licenceFile' 'Path to the licence file (edition.json) from the vendor' (Join-Path $DataDir 'edition.json')
    $port = [int](Get-Answer 'port' 'Port for the web app' '8080')
    $incoming = Get-Answer 'folders.incoming' 'Innovations incoming folder (full path)'
    $staging = Get-Answer 'folders.staging' 'Staging folder' (Join-Path $Root 'output\rx\staging') -Optional
    $archive = Get-Answer 'folders.archive' 'Archive folder' (Join-Path $Root 'output\rx\archive') -Optional
    $null = Get-Answer 'site.labNum' 'Lab number'
    $null = Get-Answer 'site.custSeqNum' 'Customer sequence' '1' -Optional
    $null = Get-Answer 'site.remoteOperator' 'Remote operator ID'
    $null = Get-Answer 'site.agentName' 'Agent name (blank for the default)' '' -Optional
    $null = Get-Answer 'admin.username' 'Username for the lab administrator'
    $null = Get-Answer 'admin.displayName' 'Administrator display name' 'Lab Administrator' -Optional
    $null = Get-Answer 'admin.email' 'Administrator email (optional)' '' -Optional
    Set-Path $script:Answers 'folders.staging' $staging
    Set-Path $script:Answers 'folders.archive' $archive
}
catch { Write-Step 'FAIL' 'Collect answers' $_.Exception.Message; exit 1 }

$problems = Test-InstallAnswers -Answers ($script:Answers | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
$httpsProblems = Test-HttpsAnswers -Answers ($script:Answers | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
$problems = @($problems) + $httpsProblems
if ($problems.Count) { $problems | ForEach-Object { Write-Step 'FAIL' 'Check answers' $_ }; exit 1 }

# ---------------------------------------------------------------------- HTTPS plan
# The app serves HTTPS itself. Names are read now so the plan can show them.

$httpsEnabled = -not $NoHttps
$httpsAnswer = Get-Path $script:Answers 'https.enabled'
if ($null -ne $httpsAnswer -and "$httpsAnswer" -match '^(false|0|no|off)$') { $httpsEnabled = $false }
$httpsPort = 443; $httpPort = 80; $tlsNames = $null; $publicUrl = "http://$($env:COMPUTERNAME):$port/"; $certUrl = ''
if ($httpsEnabled) {
    $v = Get-Path $script:Answers 'https.httpsPort'; if ($v) { $httpsPort = [int]$v }
    $v = Get-Path $script:Answers 'https.httpPort'; if ($v) { $httpPort = [int]$v }
    if ($httpsPort -eq $port -or $httpPort -eq $port) { Write-Step 'FAIL' 'Check answers' "The web app's own port ($port) is loopback only and cannot also be the HTTPS or HTTP port."; exit 1 }
    try {
        $tlsNames = Get-TlsNameSet -ComputerName $env:COMPUTERNAME -Fqdn (Get-MachineFqdn) -IpAddresses (Get-LanIPv4Addresses) `
            -ExtraNames @(Get-Path $script:Answers 'https.extraNames' | Where-Object { $_ }) -PublicHost ([string](Get-Path $script:Answers 'https.publicHost'))
    }
    catch { Write-Step 'FAIL' 'HTTPS names' $_.Exception.Message; exit 1 }
    $suffix = if ($httpsPort -eq 443) { '' } else { ":$httpsPort" }
    $publicUrl = "https://$($tlsNames.PublicHost)$suffix/"
    $certUrl = "http://$($tlsNames.PublicHost)$(if ($httpPort -eq 80) { '' } else { ":$httpPort" })/cert"
}

# ------------------------------------------------------------------- SQL choice
# Decided up front, read-only: look at what is installed, then ask.

$sqlPlan = [PSCustomObject]@{ Mode = 'new'; Name = ''; InstanceId = ''; Port = 0; Server = ''; AllowRestart = $false }
$installed = @(Get-SqlInstanceNames)
$requested = [string](Get-Path $script:Answers 'sql.mode'); if (-not $requested) { $requested = 'auto' }
$sqlcmdReady = [bool](Get-SqlcmdPath)

if ($installed.Count -gt 0 -and -not $sqlcmdReady -and $requested -ne 'new') {
    Write-Step 'WARN' 'Inspect SQL Server' 'sqlcmd is not installed, so existing instances cannot be checked; a new instance will be planned.'
}
if ($installed.Count -gt 0 -and $requested -ne 'new' -and $sqlcmdReady) {
    $candidates = @()
    foreach ($instance in $installed) {
        $facts = Get-SqlInstanceFacts -Instance $instance
        $verdict = Test-SqlCapacity -Facts $facts
        $candidates += [PSCustomObject]@{ Instance = $instance; Facts = $facts; Verdict = $verdict }
    }
    Write-Host "`nSQL Server instances already on this machine:" -ForegroundColor Cyan
    foreach ($c in $candidates) {
        $verdictText = if ($c.Verdict.Eligible) { 'has room' } else { 'not suitable: ' + ($c.Verdict.Reasons -join ' ') }
        Write-Host ("  {0,-14} {1}  {2}" -f $c.Instance.Name, $c.Facts.Edition, $verdictText)
        foreach ($w in $c.Verdict.Warnings) { Write-Host "                 note: $w" -ForegroundColor Yellow }
    }
    $wanted = [string](Get-Path $script:Answers 'sql.instance')
    $choice = $null
    if ($requested -eq 'existing') {
        $choice = $candidates | Where-Object { $_.Instance.Name -ieq $wanted } | Select-Object -First 1
        if (-not $choice) { Write-Step 'FAIL' 'Choose SQL Server' "Instance '$wanted' was not found."; exit 1 }
        if (-not $choice.Verdict.Eligible) { Write-Step 'FAIL' 'Choose SQL Server' ($choice.Verdict.Reasons -join ' '); exit 1 }
    } else {
        $suitable = @($candidates | Where-Object { $_.Verdict.Eligible })
        if ($suitable.Count -gt 0 -and $script:Interactive) {
            $first = $suitable[0]
            if (Confirm-Yes "Use the existing instance '$($first.Instance.Name)' instead of installing a new one?" $false) { $choice = $first }
        }
    }
    if ($choice) {
        $sqlPlan.Mode = 'existing'; $sqlPlan.Name = $choice.Instance.Name; $sqlPlan.InstanceId = $choice.Instance.InstanceId
        $needsRestart = ($choice.Facts.LoginMode -eq 1) -or (-not $choice.Facts.StaticTcpPort) -or (-not $choice.Facts.TcpEnabled)
        if ($needsRestart) {
            $allowed = [bool](Get-Path $script:Answers 'sql.allowRestart')
            if (-not $allowed) { $allowed = Confirm-Yes "'$($sqlPlan.Name)' must be restarted to enable mixed sign-in and TCP/IP. Restart it now during install?" $false }
            if (-not $allowed) { Write-Step 'FAIL' 'Choose SQL Server' 'The instance needs a restart and that was not allowed. Set sql.allowRestart or choose a new instance.'; exit 1 }
            $sqlPlan.AllowRestart = $true
        }
        $sqlPlan.Port = if ($choice.Facts.StaticTcpPort) { [int]$choice.Facts.StaticTcpPort } else { Get-FreeTcpPort -InUse @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object LocalPort) }
    }
}
if ($sqlPlan.Mode -eq 'new') {
    $takenNames = @($installed | ForEach-Object { $_.Name })
    $sqlPlan.Name = Get-FreeInstanceName -Taken $takenNames
    $sqlPlan.Port = Get-FreeTcpPort -InUse @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object LocalPort)
}
$sqlPlan.Server = ConvertTo-SqlServerName -Port $sqlPlan.Port

# --------------------------------------------------------------- Secrets (asked now)

$adminPassword = $null
if (-not $DryRun) { $adminPassword = Read-Secret "Password for administrator '$(Get-Path $script:Answers 'admin.username')'" -Confirm }

# Persist the non-secret answers so a resumed run does not ask again.
$script:State.answers = $script:Answers
if (-not $DryRun) { Save-InstallState -Path $StatePath -State $script:State }

$adminName = Get-Path $script:Answers 'admin.username'
Write-Host "`nPlan" -ForegroundColor Cyan
Write-Host ("  SQL Server : {0} instance '{1}' at {2}" -f $sqlPlan.Mode, $sqlPlan.Name, $sqlPlan.Server)
Write-Host "  Web app    : $publicUrl"
if ($httpsEnabled) {
    Write-Host "  Also at    : $(($tlsNames.IpAddresses | Where-Object { $_ -ne '127.0.0.1' } | ForEach-Object { "https://$_$(if ($httpsPort -ne 443) { ":$httpsPort" })/" }) -join ', ')"
    Write-Host "  HTTPS      : app serves $httpsPort, port $httpPort redirects to it; the app's own port $port is loopback only"
} else {
    Write-Host "  HTTPS      : off (-NoHttps): plain HTTP on port $port"
}
Write-Host "  Licence    : $licenceSource"
Write-Host "  Folders    : incoming $incoming; staging $staging; archive $archive"
Write-Host "  Admin      : $adminName`n"
if (-not $DryRun -and $script:Interactive -and -not (Confirm-Yes 'Start the installation?' $true)) { Write-Host 'Nothing was changed.'; exit 0 }

# ---------------------------------------------------------------------- Steps

Invoke-Step 'Install Node.js' { (Get-Command node -ErrorAction SilentlyContinue) -and (Test-NodeVersion ((& node --version) | Select-Object -First 1)) } {
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was installed but is not on PATH. Open a new elevated PowerShell and run the installer again.' }
    "Node $(& node --version)"
} -Plan 'winget install OpenJS.NodeJS.LTS (skipped when Node 20 or later is present)'

Invoke-Step 'Install Claude Code CLI' { (Get-ClaudeCliPath) -and (Get-GitPath) } {
    # Claude Code on Windows uses Git for Windows for its shell tools.
    if (-not (Get-GitPath)) {
        Install-WingetPackage -Id 'Git.Git'
        if (-not (Get-GitPath)) { throw 'Git for Windows was installed but is not on PATH. Open a new elevated PowerShell and run the installer again.' }
    }
    if (-not (Get-ClaudeCliPath)) {
        Install-WingetPackage -Id 'Anthropic.ClaudeCode'
        if (-not (Get-ClaudeCliPath)) { throw 'Claude Code was installed but `claude` was not found. Open a new elevated PowerShell and run the installer again.' }
    }
    $claude = Get-ClaudeCliPath
    $version = (& $claude --version 2>&1 | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $version) { throw "Claude Code is installed at $claude but 'claude --version' failed." }
    "$version (run 'claude' once and sign in to finish setup)"
} -Plan 'winget install Git.Git and Anthropic.ClaudeCode (skipped when claude and git are present), then check claude --version'

Invoke-Step 'Install packages' { (Test-Path (Join-Path $Root 'node_modules\mssql')) -and (Test-Path (Join-Path $Root 'node_modules\.package-lock.json')) } {
    Push-Location $Root
    try { & npm ci --omit=dev --no-audit --no-fund 2>&1 | Out-Host; if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE). Check the network can reach registry.npmjs.org." } }
    finally { Pop-Location }
    'npm ci --omit=dev'
} -Plan 'npm ci --omit=dev'

Invoke-Step 'Check and apply the licence' $null {
    if (-not (Test-Path (Join-Path $Root 'lib\edition-build.json'))) {
        if (-not $AllowFullEdition) { throw 'This is not a licensed build (lib\edition-build.json is missing). A copy of the full source would run every module. Get the licensed build from the vendor, or pass -AllowFullEdition for internal use.' }
    }
    $reply = Invoke-FirstRun -Root $Root -Request @{ action = 'licence'; file = $licenceSource }
    if (-not $reply.ok) { throw "Licence rejected: $($reply.error)" }
    $target = Join-Path $DataDir 'edition.json'
    if ((Resolve-Path -LiteralPath $licenceSource).Path -ne (Resolve-Path -LiteralPath $target -ErrorAction SilentlyContinue).Path) { Copy-Item -LiteralPath $licenceSource -Destination $target -Force }
    $script:Licensee = [string]$reply.licensee
    $until = if ($reply.expiresAt) { "until $($reply.expiresAt)" } else { 'no end date' }
    "$($reply.licensee): $($reply.modules -join ', '), $until$(if ($reply.trial) { ' (trial)' })"
} -Plan 'verify the signature and copy the file to data\edition.json'

Invoke-Step 'Install SQL Server' {
    $p = $sqlPlan
    if ($p.Mode -eq 'existing') { return $true }
    $found = Get-SqlInstanceNames | Where-Object { $_.Name -ieq $p.Name }
    return [bool]$found
} {
    $custom = ''
    if ($sqlPlan.Name -ne 'SQLEXPRESS') { $custom = "/IACCEPTSQLSERVERLICENSETERMS /ACTION=Install /QUIET /INSTANCENAME=$($sqlPlan.Name)" }
    Install-WingetPackage -Id 'Microsoft.SQLServer.2022.Express' -CustomArguments $custom
    $found = Get-SqlInstanceNames | Where-Object { $_.Name -ieq $sqlPlan.Name }
    if (-not $found) { throw "SQL Server Express finished but instance '$($sqlPlan.Name)' was not found." }
    "instance $($sqlPlan.Name)"
} -Plan "winget install Microsoft.SQLServer.2022.Express (instance $($sqlPlan.Name))"

Invoke-Step 'Configure SQL Server' {
    if (-not $sqlPlan.InstanceId) { $sqlPlan.InstanceId = (Get-SqlInstanceNames | Where-Object { $_.Name -ieq $sqlPlan.Name }).InstanceId }
    $n = Get-SqlNetworkState $sqlPlan.InstanceId
    $n.LoginMode -eq 2 -and $n.TcpEnabled -and $n.StaticPort -eq $sqlPlan.Port
} {
    Set-SqlNetwork -Name $sqlPlan.Name -InstanceId $sqlPlan.InstanceId -Port $sqlPlan.Port
    "mixed sign-in, TCP/IP on port $($sqlPlan.Port)"
} -Plan "enable mixed sign-in and TCP/IP on port $($sqlPlan.Port), restart the instance"

Invoke-Step 'Install sqlcmd' { [bool](Get-SqlcmdPath) } {
    Install-WingetPackage -Id 'Microsoft.Sqlcmd'
    if (-not (Get-SqlcmdPath)) { throw 'sqlcmd is still not on PATH. Open a new elevated PowerShell and run the installer again.' }
    'sqlcmd'
} -Plan 'winget install Microsoft.Sqlcmd (skipped when sqlcmd is present)'

# The application's own database password: kept if .env already has one, so a
# repeated run never breaks a working login.
$envText = if (Test-Path -LiteralPath $EnvPath) { Get-Content -LiteralPath $EnvPath -Raw } else { '' }
$appPassword = Get-EnvValue -Text $envText -Key 'OPTILENS_DB_PASSWORD'
if (-not $appPassword -or $appPassword -eq 'replace_with_secret') { $appPassword = New-StrongPassword }
$tlsPassphrase = Get-EnvValue -Text $envText -Key 'OPTILENS_TLS_PFX_PASSPHRASE'
if (-not $tlsPassphrase) { $tlsPassphrase = New-StrongPassword }
$pfxPath = Join-Path $DataDir 'certificates\optilens-server.pfx'
$rootCerPath = Join-Path $DataDir 'certificates\OptiLens-Local-Root-CA.cer'

Invoke-Step 'Create database and login' $null {
    $server = $sqlPlan.Server
    Invoke-SqlAdmin -Server $server -File (Join-Path $Root 'database\001-create-database.sql') | Out-Null
    Invoke-SqlAdmin -Server $server -File (Join-Path $PSScriptRoot 'sql\create-app-login.sql') -Variables @{ OPTILENS_APP_PASSWORD = $appPassword } | Out-Null
    'optilens_local, login optilens_app'
} -Plan 'run database\001-create-database.sql, then create the optilens_app login'

if ($httpsEnabled) {
    Invoke-Step 'Create HTTPS certificate' { -not (Get-TlsMaterialProblem -PfxPath $pfxPath -Passphrase $tlsPassphrase -Names $tlsNames) } {
        $made = New-OptiLensTlsCertificate -Names $tlsNames -PfxPath $pfxPath -Passphrase $tlsPassphrase -RootCerPath $rootCerPath -TrustRootHere
        "covers $($tlsNames.DnsNames -join ', ') and $(($tlsNames.IpAddresses | Where-Object { $_ -ne '127.0.0.1' }) -join ', '); ends $($made.Expires.ToString('yyyy-MM-dd'))"
    } -Plan "make a local root CA and a server certificate for $($tlsNames.DnsNames -join ', ') and $(($tlsNames.IpAddresses | Where-Object { $_ -ne '127.0.0.1' }) -join ', ')"
}

Invoke-Step 'Write .env' $null {
    $values = [ordered]@{
        OPTILENS_HOST              = $(if ($httpsEnabled) { '127.0.0.1' } else { '0.0.0.0' })
        OPTILENS_PORT              = "$port"
        OPTILENS_DB_SERVER         = $sqlPlan.Server
        OPTILENS_DB_NAME           = 'optilens_local'
        OPTILENS_DB_USER           = 'optilens_app'
        OPTILENS_DB_PASSWORD       = $appPassword
        OPTILENS_DB_ENCRYPT        = 'true'
        OPTILENS_DB_TRUST_CERT     = 'true'
        OPTILENS_WRITEBACK_ENABLED = 'false'
    }
    if ($httpsEnabled) {
        $values['OPTILENS_TLS_PFX'] = $pfxPath
        $values['OPTILENS_TLS_PFX_PASSPHRASE'] = $tlsPassphrase
        $values['OPTILENS_HTTPS_PORT'] = "$httpsPort"
        $values['OPTILENS_HTTP_REDIRECT_PORT'] = "$httpPort"
        $values['OPTILENS_PUBLIC_HOST'] = $tlsNames.PublicHost
        if ($script:Licensee) { $values['OPTILENS_NETWORK_NAME'] = $script:Licensee }
    }
    # Without a Git checkout there is nothing to pull; the vendor delivers updates.
    if (-not (Test-Path (Join-Path $Root '.git'))) { $values['OPTILENS_AUTO_APPLY_UPDATES'] = 'false' }
    Set-Content -LiteralPath $EnvPath -Value (Merge-EnvText -Text $envText -Values $values) -Encoding ASCII
    Set-RestrictedAcl -Path $EnvPath
    ".env (access limited to Administrators and $([Environment]::UserName))"
} -Plan 'write .env with the connection settings and restrict access to it'

Invoke-Step 'Create folders' $null {
    foreach ($folder in @($staging, $archive)) { if ($folder) { New-Item -ItemType Directory -Path $folder -Force | Out-Null } }
    if (-not (Test-Path -LiteralPath $incoming)) {
        if ($incoming -like '\\*') { throw "The incoming folder $incoming is not reachable from this server. Check the share name and permissions, then run again." }
        New-Item -ItemType Directory -Path $incoming -Force | Out-Null
    }
    'staging, archive and incoming exist'
} -Plan 'create the staging and archive folders and confirm the incoming folder exists'

Invoke-Step 'Apply migrations' $null {
    $reply = Invoke-FirstRun -Root $Root -Request @{ action = 'migrate' }
    if (-not $reply.ok) { throw $reply.error }
    "$(@($reply.applied).Count) applied"
} -Plan 'apply the migrations for the licensed modules'

Invoke-Step 'Create administrator and site settings' $null {
    $site = @{}
    foreach ($key in 'labNum', 'custSeqNum', 'remoteOperator', 'agentName') { $v = Get-Path $script:Answers "site.$key"; if ($v) { $site[$key] = $v } }
    $site.incomingFolder = $incoming; $site.stagingFolder = $staging; $site.archiveFolder = $archive
    $request = @{
        action = 'setup'
        admin = @{ username = $adminName; displayName = (Get-Path $script:Answers 'admin.displayName'); email = (Get-Path $script:Answers 'admin.email'); password = (ConvertFrom-Secure $adminPassword) }
        site = $site
    }
    $reply = Invoke-FirstRun -Root $Root -Request $request
    if (-not $reply.ok) { throw $reply.error }
    $parts = @()
    if ($reply.adminCreated) { $parts += "administrator '$adminName' created" } elseif ($reply.adminExisted) { $parts += "administrator '$adminName' already existed (password unchanged)" }
    if ($reply.defaultAdminDisabled) { $parts += "built-in 'optilens' account turned off" }
    if ($reply.siteSettingsSaved) { $parts += 'site settings saved' }
    $parts -join '; '
} -Plan 'create the administrator, turn off the built-in account, save site settings'

if ($httpsEnabled) {
    $wantedPorts = @("$httpPort", "$httpsPort")
    Invoke-Step 'Open the firewall' {
        $rule = Get-NetFirewallRule -DisplayName 'OptiLens Local HTTPS' -ErrorAction SilentlyContinue
        $have = if ($rule) { @(($rule | Get-NetFirewallPortFilter).LocalPort) } else { @() }
        $rule -and -not (Get-NetFirewallRule -DisplayName 'OptiLens Local' -ErrorAction SilentlyContinue) -and (@($wantedPorts | Where-Object { $have -notcontains $_ }).Count -eq 0)
    } {
        Get-NetFirewallRule -DisplayName 'OptiLens Local', 'OptiLens Local HTTPS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName 'OptiLens Local HTTPS' -Direction Inbound -Protocol TCP -LocalPort $wantedPorts -RemoteAddress LocalSubnet -Action Allow | Out-Null
        "TCP $($wantedPorts -join ', '), local subnet only; port $port is not opened"
    } -Plan "allow inbound TCP $httpPort and $httpsPort from the local subnet (the app's own port $port stays closed)"
} else {
    Invoke-Step 'Open the firewall' { [bool](Get-NetFirewallRule -DisplayName 'OptiLens Local' -ErrorAction SilentlyContinue) } {
        New-NetFirewallRule -DisplayName 'OptiLens Local' -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress LocalSubnet -Action Allow | Out-Null
        "TCP $port, local subnet only"
    } -Plan "allow inbound TCP $port from the local subnet"
}

if ($httpsEnabled) {
    Invoke-Step 'Check web ports' $null {
        $taken = @()
        foreach ($p in @($httpPort, $httpsPort)) {
            $owner = Get-PortOwner -Port $p
            if ($owner -and $owner -ne 'node') { $taken += "port $p is used by $owner" }
        }
        if ($taken) { throw "$($taken -join '; '). If that is IIS or another web server, stop it (for example 'net stop w3svc'), or set https.httpPort and https.httpsPort in the config to free ports." }
        "ports $httpPort and $httpsPort are free"
    } -Plan "check that ports $httpPort and $httpsPort are free"
}

function Test-AppHealthy {
    try { return ((Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health/live" -TimeoutSec 3).service -eq 'optilens-local') } catch { return $false }
}

function Test-HttpsHealthy {
    if (-not $httpsEnabled) { return $true }
    try {
        $uri = "https://$($tlsNames.PublicHost)$(if ($httpsPort -ne 443) { ":$httpsPort" })/api/health/live"
        return ((Get-HttpStatus -Uri $uri -TimeoutSec 3).Status -eq 200)
    } catch { return $false }
}

Invoke-Step 'Start the application' { (Test-AppHealthy) -and (Test-HttpsHealthy) } {
    # An app that is already running has not read the new .env, so restart it.
    if (Test-AppHealthy) { & (Join-Path $Root 'scripts\stop-app.ps1') -ProjectRoot $Root -Port $port | Out-Host }
    & (Join-Path $Root 'scripts\start-app.ps1') -ProjectRoot $Root -Port $port | Out-Host
    for ($i = 0; $i -lt 40 -and -not ((Test-AppHealthy) -and (Test-HttpsHealthy)); $i++) { Start-Sleep -Seconds 1 }
    if (-not (Test-AppHealthy)) { throw "The app did not answer on port $port. See server.err.log in the install folder." }
    if (-not (Test-HttpsHealthy)) { throw "The app is running but HTTPS did not answer on port $httpsPort. See server.out.log and server.err.log in the install folder." }
    if ($httpsEnabled) { "answering on $publicUrl" } else { "answering on port $port" }
} -Plan "start the app and wait for /api/health/live$(if ($httpsEnabled) { " over HTTPS on port $httpsPort" } else { " on port $port" })"

if (-not $SkipWatchdog) {
    Invoke-Step 'Keep it running' { [bool](Get-ScheduledTask -TaskName 'OptiLens Local Watchdog' -ErrorAction SilentlyContinue) } {
        $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $credential = Get-Credential -UserName $account -Message 'Windows password for the account that will run OptiLens, including before anyone signs in.'
        & (Join-Path $Root 'scripts\install-app-watchdog-task.ps1') -ProjectRoot $Root -Port $port -Credential $credential | Out-Host
        "scheduled task runs as $account"
    } -Plan 'register the OptiLens Local Watchdog task as the signed-in Windows user'
} else {
    Write-Step 'SKIP' 'Keep it running' '-SkipWatchdog: the app will not restart after a reboot'
}

if ($httpsEnabled) {
    Invoke-Step 'Verify HTTPS' $null {
        $checks = @()
        $redirect = Get-HttpStatus -Uri "http://127.0.0.1:$httpPort/"
        if ($redirect.Status -notin 301, 308 -or "$($redirect.Location)" -notlike 'https://*') { throw "Port $httpPort did not redirect to HTTPS (status $($redirect.Status))." }
        $checks += "port $httpPort redirects to HTTPS"
        $crt = Get-HttpStatus -Uri "http://127.0.0.1:$httpPort/cert/optilens-root-ca.crt"
        if ($crt.Status -ne 200) { throw "The certificate download on port $httpPort answered $($crt.Status). Devices could not install the certificate." }
        $checks += 'certificate download works over HTTP'
        foreach ($ip in @($tlsNames.IpAddresses | Where-Object { $_ -ne '127.0.0.1' } | Select-Object -First 1)) {
            $client = New-Object System.Net.Sockets.TcpClient
            try {
                $open = $client.ConnectAsync($ip, $port).Wait(1500) -and $client.Connected
                if ($open) { throw "Port $port answers on $ip, so the app is reachable without HTTPS. Check OPTILENS_HOST in .env." }
            } catch [System.AggregateException] { } finally { $client.Dispose() }
            $checks += "port $port is not reachable on $ip"
        }
        $checks -join '; '
    } -Plan 'check the HTTP redirect, the certificate download and that the app port is closed to the network'
}

Invoke-Step 'Verify' $null {
    $reply = Invoke-FirstRun -Root $Root -Request @{ action = 'verify'; admin = @{ username = $adminName; password = (ConvertFrom-Secure $adminPassword) } }
    foreach ($c in $reply.checks) { Write-Host ("        {0} {1} {2}" -f $(if ($c.pass) { '[ok]' } else { '[!!]' }), $c.name, $c.detail) }
    if (-not $reply.ok) { throw 'One or more checks failed (above).' }
    'licence, database, migrations, sign-in and site settings'
} -Plan 'check the licence, database, migrations, administrator sign-in and site settings'

# -------------------------------------------------------------------- Summary

if ($DryRun) { Write-Host "`nDry run only. Nothing was changed." -ForegroundColor Cyan; exit 0 }
Write-Host "`nOptiLens is installed." -ForegroundColor Green
Write-Host "  Open        : $publicUrl   (sign in as $adminName)"
if ($httpsEnabled) {
    Write-Host "  Other PCs   : first open $certUrl on each device and install the certificate (the page explains how),"
    Write-Host "                then browse to $publicUrl. The file is also at $rootCerPath."
    Write-Host "  Certificate : valid for $($tlsNames.DnsNames -join ', ') and $(($tlsNames.IpAddresses | Where-Object { $_ -ne '127.0.0.1' }) -join ', ')."
    Write-Host "                If the server's name or IP address changes, run the installer again to reissue it."
}
Write-Host "  First check : RX Capture > gear > Check folders"
Write-Host "  Log         : $(Join-Path $DataDir 'install.log')"
Write-Host "  The database password is in .env. Back up the database and .env."
Stop-Transcript | Out-Null
