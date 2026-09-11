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
$script = Join-Path $ProjectRoot "scripts\sync-chemistry-catalog.js"
$stdout = Join-Path $logDirectory "chemistry-catalog-sync-task.out.log"
$stderr = Join-Path $logDirectory "chemistry-catalog-sync-task.err.log"

if (-not (Test-Path $script)) {
    throw "Chemistry catalog sync script not found at $script"
}

& $node $script 1>> $stdout 2>> $stderr
exit $LASTEXITCODE
