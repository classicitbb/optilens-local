# Helpers for Install-OptiLens.ps1.
#
# The functions at the top are pure (no machine changes) so they can be tested
# on any machine. The ones under "Machine" read or change the server and are only
# called by the installer. Written for Windows PowerShell 5.1 and PowerShell 7.

Set-StrictMode -Version 2.0

# ---------------------------------------------------------------- Pure helpers

function New-StrongPassword {
    # Letters and digits plus '-' and '_'. No '$', quotes or '=' so the value is safe
    # in .env, in sqlcmd scripting variables and in T-SQL string literals.
    param([int] $Length = 24)
    if ($Length -lt 12) { throw "Passwords shorter than 12 characters are not allowed." }
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.ToCharArray()
    $lower = 'abcdefghijkmnopqrstuvwxyz'.ToCharArray()
    $digit = '23456789'.ToCharArray()
    $all = ($upper + $lower + $digit + '-_'.ToCharArray())
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    function Pick([char[]] $set) {
        $b = New-Object byte[] 4
        do { $rng.GetBytes($b); $n = [BitConverter]::ToUInt32($b, 0) } while ($n -ge ([uint32]::MaxValue - ([uint32]::MaxValue % $set.Length)))
        return $set[$n % $set.Length]
    }
    $chars = New-Object System.Collections.Generic.List[char]
    $chars.Add((Pick $upper)); $chars.Add((Pick $lower)); $chars.Add((Pick $digit))
    while ($chars.Count -lt $Length) { $chars.Add((Pick $all)) }
    # Shuffle so the guaranteed characters are not always first.
    $array = $chars.ToArray()
    for ($i = $array.Length - 1; $i -gt 0; $i--) {
        $b = New-Object byte[] 4; $rng.GetBytes($b)
        $j = [BitConverter]::ToUInt32($b, 0) % ($i + 1)
        $t = $array[$i]; $array[$i] = $array[$j]; $array[$j] = $t
    }
    $rng.Dispose()
    return (-join $array)
}

function Merge-EnvText {
    # Sets KEY=value lines in .env text, keeping every other line and comment.
    param([string] $Text, [System.Collections.IDictionary] $Values)
    $lines = New-Object System.Collections.Generic.List[string]
    if ($Text) { foreach ($l in ($Text -split "\r?\n")) { $lines.Add($l) } }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    foreach ($key in $Values.Keys) {
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) {
                $lines[$i] = "$key=$($Values[$key])"; $found = $true; break
            }
        }
        if (-not $found) { $lines.Add("$key=$($Values[$key])") }
    }
    return (($lines -join "`r`n") + "`r`n")
}

function Get-EnvValue {
    param([string] $Text, [string] $Key)
    if (-not $Text) { return $null }
    foreach ($l in ($Text -split "\r?\n")) {
        if ($l -match ('^\s*' + [regex]::Escape($Key) + '\s*=\s*(.*)$')) { return $Matches[1].Trim().Trim('"') }
    }
    return $null
}

function Test-InstallAnswers {
    # Returns a list of problems with the non-secret answers. Empty means usable.
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
    foreach ($key in 'admin.username', 'site.labNum', 'site.remoteOperator', 'folders.incoming') {
        if (-not (& $get $key)) { $problems.Add("Missing answer: $key") }
    }
    $user = & $get 'admin.username'
    if ($user -and $user -notmatch '^[A-Za-z0-9._-]{3,60}$') { $problems.Add('admin.username must be 3-60 letters, digits, dots, hyphens or underscores.') }
    if ($user -and $user -ieq 'optilens') { $problems.Add("admin.username cannot be 'optilens'; that is the built-in account the installer turns off.") }
    $lab = & $get 'site.labNum'
    if ($lab -and $lab -notmatch '^[A-Za-z0-9_-]+$') { $problems.Add('site.labNum can only contain letters, digits, hyphens and underscores.') }
    $seq = & $get 'site.custSeqNum'
    if ($seq -and $seq -notmatch '^[0-9]+$') { $problems.Add('site.custSeqNum must be a number.') }
    foreach ($key in 'folders.incoming', 'folders.staging', 'folders.archive') {
        $value = & $get $key
        if ($value -and $value -notmatch '^([A-Za-z]:[\\/]|\\\\)') { $problems.Add("$key must be a full path such as D:\Innovations\Incoming or \\server\share\Incoming.") }
        if ($value -and $value -match '[<>"|?*]') { $problems.Add("$key contains characters a folder name cannot have.") }
    }
    $port = & $get 'port'
    if ($port -and (($port -isnot [int] -and $port -notmatch '^\d+$') -or [int]$port -lt 1 -or [int]$port -gt 65535)) { $problems.Add('port must be between 1 and 65535.') }
    $mode = & $get 'sql.mode'
    if ($mode -and $mode -notin 'auto', 'new', 'existing') { $problems.Add("sql.mode must be 'auto', 'new' or 'existing'.") }
    if ($mode -eq 'existing' -and -not (& $get 'sql.instance')) { $problems.Add("sql.instance is required when sql.mode is 'existing'.") }
    return , $problems.ToArray()
}

function Test-SqlCapacity {
    # Decides whether an instance that is already installed can host the app.
    # Express limits: 10 GB per database and about 1.4 GB of buffer memory shared
    # by every database on the instance, so a busy one has no room for another.
    param([Parameter(Mandatory)] $Facts)
    $reasons = New-Object System.Collections.Generic.List[string]
    $warnings = New-Object System.Collections.Generic.List[string]
    if (-not $Facts.Running) { $reasons.Add('The SQL Server service is not running.') }
    if (-not $Facts.Connected) {
        $reasons.Add('Could not connect with the signed-in Windows account.')
    } else {
        if (-not $Facts.IsSysadmin) { $reasons.Add('The signed-in account is not a SQL Server sysadmin; an administrator login is needed.') }
        if ($Facts.MajorVersion -lt 13) { $reasons.Add("SQL Server version $($Facts.MajorVersion) is older than 2016.") }
        if ($Facts.FreeMB -lt 5120) { $reasons.Add("Only $([math]::Round($Facts.FreeMB / 1024, 1)) GB is free on the instance's disk; at least 5 GB is needed.") }
        if ($Facts.Edition -match 'Express' -and $Facts.UserDataMB -gt 6144) { $reasons.Add("Its databases already hold $([math]::Round($Facts.UserDataMB / 1024, 1)) GB, too much to share Express's 1.4 GB of memory with.") }
        if ($Facts.UserDbCount -gt 10) { $warnings.Add("The instance already hosts $($Facts.UserDbCount) databases.") }
        if ($Facts.HasOptilensDb) { $warnings.Add('A database named optilens_local already exists here; the install would migrate it in place.') }
        if ($Facts.LoginMode -eq 1) { $warnings.Add('The instance accepts Windows sign-in only. Using it means switching to mixed mode and restarting it.') }
        if (-not $Facts.StaticTcpPort) { $warnings.Add('TCP/IP has no fixed port. Using it means setting one and restarting it.') }
    }
    return [PSCustomObject]@{ Eligible = ($reasons.Count -eq 0); Reasons = $reasons.ToArray(); Warnings = $warnings.ToArray() }
}

function Get-FreeInstanceName {
    # SQLEXPRESS if nobody has it, otherwise OPTILENS, OPTILENS2 and so on.
    param([string[]] $Taken = @())
    $names = @($Taken | ForEach-Object { $_.ToUpperInvariant() })
    foreach ($candidate in 'SQLEXPRESS', 'OPTILENS', 'OPTILENS2', 'OPTILENS3') {
        if ($names -notcontains $candidate) { return $candidate }
    }
    throw 'No free SQL Server instance name was found.'
}

function Get-FreeTcpPort {
    param([int[]] $InUse = @(), [int[]] $Preferred = @(1433, 14330, 14331, 14332))
    foreach ($port in $Preferred) { if ($InUse -notcontains $port) { return $port } }
    throw 'No free TCP port was found for SQL Server.'
}

function Get-WingetFailure {
    # winget exits with 0x8A15002B (-1978335189) when the package is already
    # installed and nothing newer exists. That is success for an installer.
    param([int] $ExitCode)
    if ($ExitCode -eq 0 -or $ExitCode -eq -1978335189 -or $ExitCode -eq -1978335188) { return $null }
    return "winget exited with code $ExitCode."
}

function Test-NodeVersion {
    param([string] $VersionText, [int] $Minimum = 20)
    if ($VersionText -match '^v?(\d+)\.') { return ([int]$Matches[1] -ge $Minimum) }
    return $false
}

function ConvertTo-SqlServerName {
    param([string] $Host_ = '127.0.0.1', [int] $Port)
    return "$Host_,$Port"
}

# --------------------------------------------------------------------- State

function Get-InstallState {
    param([string] $Path)
    if (Test-Path -LiteralPath $Path) {
        try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { }
    }
    return [PSCustomObject]@{ completed = @(); answers = [PSCustomObject]@{} }
}

function Save-InstallState {
    param([string] $Path, $State)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding UTF8
}

# -------------------------------------------------------------------- Machine

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Install-WingetPackage {
    param([Parameter(Mandatory)] [string] $Id, [string] $CustomArguments = '')
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw "winget was not found. On Windows 10/11 update 'App Installer' from the Microsoft Store. On Windows Server install it from https://aka.ms/getwinget, or install Node.js 20 LTS and SQL Server Express yourself. The installer skips whatever is already present, so run it again afterwards." }
    $args = @('install', '--id', $Id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    if ($CustomArguments) { $args += @('--custom', $CustomArguments) }
    & winget @args | Out-Host
    $failure = Get-WingetFailure -ExitCode $LASTEXITCODE
    if ($failure) { throw "$failure ($Id)" }
    Update-SessionPath
}

function Get-SqlInstanceNames {
    $key = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
    if (-not (Test-Path $key)) { return @() }
    $props = Get-ItemProperty $key
    return @($props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
        [PSCustomObject]@{ Name = $_.Name; InstanceId = [string]$_.Value }
    })
}

function Get-SqlServiceName {
    param([string] $Name)
    if ($Name -eq 'MSSQLSERVER') { return 'MSSQLSERVER' }
    return "MSSQL`$$Name"
}

function Get-SqlRegistryRoot {
    param([string] $InstanceId)
    return "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$InstanceId\MSSQLServer"
}

function Get-SqlNetworkState {
    param([string] $InstanceId)
    $root = Get-SqlRegistryRoot $InstanceId
    $tcp = "$root\SuperSocketNetLib\Tcp"
    $state = [PSCustomObject]@{ TcpEnabled = $false; StaticPort = $null; LoginMode = 1 }
    if (Test-Path $root) { $state.LoginMode = [int](Get-ItemProperty $root -Name LoginMode -ErrorAction SilentlyContinue).LoginMode }
    if (Test-Path $tcp) {
        $state.TcpEnabled = ([int](Get-ItemProperty $tcp -Name Enabled -ErrorAction SilentlyContinue).Enabled -eq 1)
        $ipAll = Get-ItemProperty "$tcp\IPAll" -ErrorAction SilentlyContinue
        if ($ipAll -and $ipAll.TcpPort -match '^\d+$') { $state.StaticPort = [int]$ipAll.TcpPort }
    }
    return $state
}

function Set-SqlNetwork {
    # Turns on TCP/IP with one fixed port and mixed-mode sign-in, then restarts the
    # service. No SQL Browser and no firewall rule: the app runs on this server.
    param([Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [string] $InstanceId, [Parameter(Mandatory)] [int] $Port)
    $root = Get-SqlRegistryRoot $InstanceId
    $tcp = "$root\SuperSocketNetLib\Tcp"
    Set-ItemProperty -Path $root -Name LoginMode -Value 2
    Set-ItemProperty -Path $tcp -Name Enabled -Value 1
    foreach ($sub in Get-ChildItem $tcp -ErrorAction SilentlyContinue) { Set-ItemProperty -Path $sub.PSPath -Name Active -Value 1 -ErrorAction SilentlyContinue }
    Set-ItemProperty -Path "$tcp\IPAll" -Name TcpPort -Value ([string]$Port)
    Set-ItemProperty -Path "$tcp\IPAll" -Name TcpDynamicPorts -Value ''
    Restart-Service -Name (Get-SqlServiceName $Name) -Force
    Start-Sleep -Seconds 3
}

function Get-SqlcmdPath {
    $cmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Invoke-SqlAdmin {
    # Runs sqlcmd as an administrator. The SQL password, when used, goes through the
    # SQLCMDPASSWORD variable of this process only, never the command line.
    param(
        [Parameter(Mandatory)] [string] $Server,
        [string] $Query,
        [string] $File,
        [string] $User,
        [System.Security.SecureString] $Password,
        [hashtable] $Variables = @{}
    )
    $sqlcmd = Get-SqlcmdPath
    if (-not $sqlcmd) { throw 'sqlcmd was not found.' }
    $args = @('-S', $Server, '-N', '-C', '-b', '-h', '-1', '-W', '-s', '|')
    if ($User) { $args += @('-U', $User) } else { $args += '-E' }
    if ($Query) { $args += @('-Q', $Query) }
    if ($File) { $args += @('-i', $File) }
    $previous = @{}
    $names = @($Variables.Keys) + @('SQLCMDPASSWORD')
    foreach ($n in $names) { $previous[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
    try {
        foreach ($k in $Variables.Keys) { [Environment]::SetEnvironmentVariable($k, [string]$Variables[$k], 'Process') }
        if ($User -and $Password) {
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
            try { [Environment]::SetEnvironmentVariable('SQLCMDPASSWORD', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr), 'Process') }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        }
        $output = & $sqlcmd @args 2>&1
        if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $(($output | Out-String).Trim())" }
        return @($output | ForEach-Object { "$_" })
    }
    finally {
        foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $previous[$n], 'Process') }
    }
}

function Get-SqlInstanceFacts {
    # Reads what Test-SqlCapacity needs from an installed instance.
    param([Parameter(Mandatory)] $Instance, [string] $User, [System.Security.SecureString] $Password)
    $service = Get-Service -Name (Get-SqlServiceName $Instance.Name) -ErrorAction SilentlyContinue
    $network = Get-SqlNetworkState $Instance.InstanceId
    $facts = [PSCustomObject]@{
        Name = $Instance.Name; InstanceId = $Instance.InstanceId
        Running = ($service -and $service.Status -eq 'Running')
        Connected = $false; IsSysadmin = $false; Edition = ''; MajorVersion = 0
        UserDataMB = 0; UserDbCount = 0; FreeMB = 0; HasOptilensDb = $false
        LoginMode = $network.LoginMode; StaticTcpPort = $network.StaticPort; TcpEnabled = $network.TcpEnabled
    }
    if (-not $facts.Running) { return $facts }
    $server = if ($Instance.Name -eq 'MSSQLSERVER') { '.' } else { ".\$($Instance.Name)" }
    if ($network.StaticPort -and $network.TcpEnabled) { $server = "127.0.0.1,$($network.StaticPort)" }
    $query = @"
SET NOCOUNT ON;
SELECT CAST(SERVERPROPERTY('Edition') AS nvarchar(100)) + '|' + CAST(SERVERPROPERTY('ProductMajorVersion') AS varchar(10)) + '|' + CAST(IS_SRVROLEMEMBER('sysadmin') AS varchar(2)) + '|'
 + CAST(ISNULL((SELECT SUM(CAST(size AS bigint)) * 8 / 1024 FROM sys.master_files WHERE database_id > 4 AND type = 0), 0) AS varchar(20)) + '|'
 + CAST((SELECT COUNT(*) FROM sys.databases WHERE database_id > 4) AS varchar(10)) + '|'
 + CAST(ISNULL((SELECT MIN(v.available_bytes) / 1048576 FROM sys.master_files f CROSS APPLY sys.dm_os_volume_stats(f.database_id, f.file_id) v WHERE f.database_id = 1), 0) AS varchar(20)) + '|'
 + CASE WHEN DB_ID('optilens_local') IS NULL THEN '0' ELSE '1' END;
"@
    try {
        $row = (Invoke-SqlAdmin -Server $server -Query $query -User $User -Password $Password | Where-Object { $_ -match '\|' } | Select-Object -First 1)
        $p = $row.Split('|')
        $facts.Connected = $true
        $facts.Edition = $p[0]; $facts.MajorVersion = [int]$p[1]; $facts.IsSysadmin = ($p[2] -eq '1')
        $facts.UserDataMB = [double]$p[3]; $facts.UserDbCount = [int]$p[4]; $facts.FreeMB = [double]$p[5]; $facts.HasOptilensDb = ($p[6] -eq '1')
    } catch { }
    return $facts
}

function Set-RestrictedAcl {
    # Only Administrators, SYSTEM and the service account may read the file.
    param([Parameter(Mandatory)] [string] $Path)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-32-544:(F)' '*S-1-5-18:(F)' "${user}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to $Path." }
}

function Invoke-FirstRun {
    # Calls scripts/install/first-run.js. The request goes in on stdin, so secrets
    # never reach a command line.
    param([Parameter(Mandatory)] [string] $Root, [Parameter(Mandatory)] $Request)
    $node = (Get-Command node -ErrorAction Stop).Source
    $json = $Request | ConvertTo-Json -Depth 6 -Compress
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '"' + (Join-Path $Root 'scripts\install\first-run.js') + '"'
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
    $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    # UTF-8 without a byte-order mark, whatever the console code page is.
    $writer = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding $false))
    $writer.Write($json)
    $writer.Flush()
    $writer.Close()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    $stderr = $stderrTask.Result
    try { return ($stdout | ConvertFrom-Json) }
    catch { return [PSCustomObject]@{ ok = $false; error = "first-run.js gave no usable reply. $stderr".Trim() } }
}

Export-ModuleMember -Function *
