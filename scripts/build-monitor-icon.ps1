param(
    [string] $Output = ""
)

$ErrorActionPreference = "Stop"
if (-not $Output) { $Output = Join-Path (Split-Path -Parent $PSScriptRoot) "OptiLensHostMonitor.ico" }
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 32, 32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(11, 104, 119))
$graphics.FillEllipse([System.Drawing.Brushes]::White, 4, 4, 24, 24)
$font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(11, 104, 119))
$graphics.DrawString("O", $font, $ink, 8, 5)
$ink.Dispose()
$font.Dispose(); $graphics.Dispose()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$png = $stream.ToArray(); $stream.Dispose()
$bytes = New-Object System.Collections.Generic.List[byte]
$bytes.AddRange([byte[]](0, 0, 1, 0, 1, 0))
$bytes.AddRange([byte[]](0, 0, 0, 0, 1, 0, 32, 0))
$bytes.AddRange([BitConverter]::GetBytes([int]$png.Length))
$bytes.AddRange([BitConverter]::GetBytes([int]22))
$bytes.AddRange($png)
[System.IO.File]::WriteAllBytes($Output, $bytes.ToArray())
Write-Host "Built $Output"
