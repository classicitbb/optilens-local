<#
Creates the three random QuickBooks gateway secrets, saves the handoff token (and turns the QBO worker on)
in this host's .env, and puts the Vercel variable block on the clipboard. Values are never printed.

Run on the OptiLens host, as the account that runs the app:
  powershell -ExecutionPolicy Bypass -File C:\OptiLens\app\scripts\new-qbo-gateway-secrets.ps1
#>
[CmdletBinding()]
param([string]$ProjectRoot = 'C:\OptiLens\app', [switch]$Force)
$ErrorActionPreference = 'Stop'

function New-Secret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b); $rng.Dispose()
  [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Set-EnvLine([string[]]$Source, [string]$Name, [string]$Value) {
  $out = New-Object System.Collections.Generic.List[string]
  $done = $false
  foreach ($l in $Source) {
    if ($l -match "^\s*$Name\s*=") { if (-not $done) { $out.Add("$Name=$Value"); $done = $true } }
    else { $out.Add($l) }
  }
  if (-not $done) { $out.Add("$Name=$Value") }
  ,$out.ToArray()
}

$envFile = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }
$lines = [IO.File]::ReadAllLines($envFile)
$existing = $lines | Where-Object { $_ -match '^\s*OPTILENS_QBO_HANDOFF_TOKEN\s*=' }
if ($existing -and -not $Force) {
  throw 'OPTILENS_QBO_HANDOFF_TOKEN is already set in .env. Re-run with -Force to replace it (the Vercel project must then be updated with the new value too).'
}

$encKey     = New-Secret 32
$rateSecret = New-Secret 32
$token      = New-Secret 48

# Production client ID from the protected store (readable only by the account that created it).
$clientId = ''
try {
  Push-Location $ProjectRoot
  $js = 'const s=require("./lib/qbo-secret-store");const v=s.load("production");if(v&&v.clientId)process.stdout.write(v.clientId)'
  $clientId = (& 'C:\Program Files\nodejs\node.exe' -e $js 2>$null | Out-String).Trim()
} catch { $clientId = '' } finally { Pop-Location }

$backup = "$envFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $envFile $backup
$lines = Set-EnvLine $lines 'OPTILENS_QBO_HANDOFF_TOKEN' $token
$lines = Set-EnvLine $lines 'OPTILENS_QBO_WORKER' 'on'
[IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

$block = @("QBO_CODE_HANDOFF_ENCRYPTION_KEY=$encKey", "QBO_GATEWAY_RATE_LIMIT_SECRET=$rateSecret", "QBO_LOCAL_HANDOFF_TOKEN=$token")
if ($clientId) { $block += "QBO_CLIENT_ID=$clientId" }
Set-Clipboard -Value ($block -join "`r`n")

Write-Host ''
Write-Host 'Done. Nothing secret was printed.'
Write-Host ('  .env updated : OPTILENS_QBO_HANDOFF_TOKEN, OPTILENS_QBO_WORKER=on  (backup: ' + $backup + ')')
Write-Host ('  Clipboard    : ' + (($block | ForEach-Object { $_.Split('=')[0] }) -join ', '))
if (-not $clientId) { Write-Host '  QBO_CLIENT_ID was not found in the protected store: add it in Vercel yourself.' }
Write-Host ''
Write-Host 'Next: Vercel > cv-qbo-production-gateway > Settings > Environment Variables > Add.'
Write-Host '  Keep type = Secret and environment = Production, paste into the Key box, Save.'
Write-Host '  Then add QBO_LOVABLE_API_KEY yourself (a CV Web API key with the gateway:agent scope).'
Write-Host 'After saving, clear the clipboard:  Set-Clipboard -Value $null'
Write-Host 'The app is NOT restarted. Tell Claude when the Vercel variables are saved.'
Remove-Variable encKey, rateSecret, token, block, lines -ErrorAction SilentlyContinue
