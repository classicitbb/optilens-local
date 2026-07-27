param(
    [string] $ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $compiler)) { $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $compiler)) { throw "Microsoft .NET Framework C# compiler was not found." }

$source = Join-Path $PSScriptRoot "OptiLensHostMonitorLauncher.cs"
$output = Join-Path $ProjectRoot "OptiLensHostMonitor.exe"
& $compiler /nologo /target:winexe /optimize+ /out:$output $source
if ($LASTEXITCODE -ne 0) { throw "Monitor EXE compilation failed with exit code $LASTEXITCODE." }
Write-Host "Built $output"
