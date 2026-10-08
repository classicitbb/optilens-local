param(
    [string]$ProjectRoot = "",
    [switch]$Current,
    [string]$CodexVersion = "0.156.1"
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not $Current -and $CodexVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "CodexVersion must be a numeric version such as 0.156.1."
}

# Clear TERM because management shells can set it to "dumb", which disables
# terminal capabilities used by interactive TUIs. Run in a native cmd console.
$codexCommand = if ($Current) {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
        throw "Codex is not available on PATH."
    }
    "codex"
} else {
    if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
        throw "npx is not available on PATH. Install Node.js 20 or later to run the pinned legacy Codex CLI."
    }
    "npx.cmd --yes @openai/codex@$CodexVersion"
}

# cmd.exe keeps the terminal open after Codex exits, so launch errors remain visible.
$command = 'set "TERM=" && cd /d "{0}" && {1}' -f $ProjectRoot.Replace('"', '""'), $codexCommand
Start-Process -FilePath $env:ComSpec -ArgumentList @("/k", $command) -WorkingDirectory $ProjectRoot
