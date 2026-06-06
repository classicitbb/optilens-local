param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Get-ListeningPortOwners {
    param([int] $TargetPort)

    $owners = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    if ($owners) {
        return $owners
    }

    $pattern = ":$TargetPort\s+.*LISTENING\s+(\d+)"
    return netstat -ano |
        Select-String -Pattern $pattern |
        ForEach-Object { [regex]::Match($_.Line, $pattern).Groups[1].Value } |
        Sort-Object -Unique
}

$existingOwners = Get-ListeningPortOwners -TargetPort $Port

if ($existingOwners) {
    Write-Host "OptiLens Local already has a listener on port $Port. PID(s): $($existingOwners -join ', ')"
    return
}

$node = (Get-Command node -ErrorAction Stop).Source
$stdout = Join-Path $ProjectRoot "server.out.log"
$stderr = Join-Path $ProjectRoot "server.err.log"

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$command = "cd /d `"$ProjectRoot`" && `"$node`" server.js >> `"$stdout`" 2>> `"$stderr`""
$startInfo.FileName = $env:ComSpec
$startInfo.Arguments = "/c $command"
$startInfo.WorkingDirectory = $ProjectRoot
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.UseShellExecute = $false
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$previousPort = $env:OPTILENS_PORT

try {
    $env:OPTILENS_PORT = [string] $Port
    $process.Start() | Out-Null
} finally {
    if ($null -eq $previousPort) {
        Remove-Item Env:\OPTILENS_PORT -ErrorAction SilentlyContinue
    } else {
        $env:OPTILENS_PORT = $previousPort
    }
}

$started = $false
for ($attempt = 1; $attempt -le 10; $attempt++) {
    Start-Sleep -Milliseconds 500
    $owners = Get-ListeningPortOwners -TargetPort $Port
    if ($owners) {
        Write-Host "Started OptiLens Local on port $Port. PID(s): $($owners -join ', ')"
        $started = $true
        break
    }
}

if (-not $started) {
    throw "Started command, but no listener appeared on port $Port. Check $stderr."
}
