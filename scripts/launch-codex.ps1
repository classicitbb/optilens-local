param(
    [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw "Codex is not installed or is not available on PATH. Install the Codex desktop app, then try again."
}

# cmd.exe keeps the terminal open after Codex exits, which makes any launch
# error visible to the operator.
$command = 'cd /d "{0}" && codex' -f $ProjectRoot.Replace('"', '""')
Start-Process -FilePath $env:ComSpec -ArgumentList @("/k", $command) -WorkingDirectory $ProjectRoot
