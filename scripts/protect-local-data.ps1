param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Protect", "Unprotect")]
    [string] $Mode
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$encoded = [Console]::In.ReadToEnd().Trim()
if (-not $encoded) { throw "No protected-store input was provided." }

$bytes = [Convert]::FromBase64String($encoded)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -eq "Protect") {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
} else {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
}

[Console]::Out.Write(([Convert]::ToBase64String($result)))
