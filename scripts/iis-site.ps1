param(
    [ValidateSet("Start", "Stop", "Restart", "Status")]
    [string] $Action = "Status",
    [string] $SiteName = "Optilens-Local",
    [int] $Port = 8080
)

$ErrorActionPreference = "Stop"

function Import-IisModule {
    Import-Module WebAdministration -ErrorAction Stop
}

function Get-IisSite {
    param([string] $Name)

    $site = Get-Website -Name $Name -ErrorAction SilentlyContinue
    if (-not $site) {
        throw "IIS site '$Name' was not found."
    }

    return $site
}

function Get-PortOwners {
    param([int] $TargetPort)

    return Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

function Write-SiteStatus {
    param(
        [string] $Name,
        [int] $TargetPort
    )

    $site = Get-IisSite -Name $Name
    $owners = Get-PortOwners -TargetPort $TargetPort

    Write-Host "Site: $($site.Name)"
    Write-Host "State: $($site.State)"
    Write-Host "Path: $($site.PhysicalPath)"

    if ($owners) {
        Write-Host "Port $TargetPort listener PID(s): $($owners -join ', ')"
    } else {
        Write-Host "Port $TargetPort listener PID(s): none"
    }
}

Import-IisModule

switch ($Action) {
    "Start" {
        Start-Website -Name $SiteName
        Write-Host "Started IIS site '$SiteName'."
    }
    "Stop" {
        Stop-Website -Name $SiteName
        Write-Host "Stopped IIS site '$SiteName'."
    }
    "Restart" {
        Stop-Website -Name $SiteName
        Start-Website -Name $SiteName
        Write-Host "Restarted IIS site '$SiteName'."
    }
    "Status" {
    }
}

Write-SiteStatus -Name $SiteName -TargetPort $Port
