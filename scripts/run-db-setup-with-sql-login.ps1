param(
    [Parameter(Mandatory = $true)]
    [string] $Server,

    [Parameter(Mandatory = $true)]
    [string] $User,

    [Parameter(Mandatory = $true)]
    [string] $Password
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$scripts = @(
    "database\001-create-database.sql",
    "database\002-core-schema.sql",
    "database\003-delivery-module-schema.sql",
    "database\004-seed-platform.sql"
)

foreach ($script in $scripts) {
    $path = Join-Path $root $script
    Write-Host "Running $script"
    sqlcmd -S $Server -U $User -P $Password -N -C -b -i $path
}

Write-Host "Database setup complete."
