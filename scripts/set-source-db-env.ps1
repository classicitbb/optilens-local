param(
    [string] $Server = "MSSQL-SVR",
    [string] $Database = "Innovations",
    [string] $User = "sql_reporting"
)

$ErrorActionPreference = "Stop"

$securePassword = Read-Host "Enter source SQL password for $User" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_SERVER", $Server, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_DATABASE", $Database, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_USER", $User, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_PASSWORD", $password, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_ENCRYPT", "true", "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_TRUST_CERT", "true", "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_SOURCE_MSSQL_MODE", "read-only", "User")

    Write-Host "OptiLens source MSSQL environment variables saved for the current Windows user."
    Write-Host "Restart the app so the new values are loaded."
}
finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
