param(
    [string] $ProjectRoot = "",
    [string] $NodePath = "",
    [switch] $Apply
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$node = if ($NodePath) { $NodePath } else { (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $node)) {
    throw "Node executable not found at $node"
}
$cli = Join-Path $ProjectRoot "scripts\sync-qbo-invoices.js"
if (-not (Test-Path -LiteralPath $cli)) {
    throw "QBO invoice sync script not found at $cli"
}

$arguments = @($cli)
if ($Apply) { $arguments += "--apply" }
& $node @arguments
exit $LASTEXITCODE
