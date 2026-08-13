param(
    [string] $ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$logDirectory = Join-Path $ProjectRoot "data\logs"
if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $ProjectRoot "scripts\sync-rx-catalog.js"
$stdout = Join-Path $logDirectory "rx-catalog-sync-task.out.log"
$stderr = Join-Path $logDirectory "rx-catalog-sync-task.err.log"

if (-not (Test-Path $script)) {
    throw "RX catalog sync script not found at $script"
}

& $node $script 1>> $stdout 2>> $stderr
exit $LASTEXITCODE
