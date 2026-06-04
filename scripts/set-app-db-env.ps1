param(
    [string] $Server = "MSSQL-SVR",
    [string] $Database = "optilens_local",
    [string] $User = "optilens_app"
)

$ErrorActionPreference = "Stop"

$securePassword = Read-Host "Enter SQL password for $User" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    [Environment]::SetEnvironmentVariable("OPTILENS_DB_SERVER", $Server, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_DB_NAME", $Database, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_DB_USER", $User, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_DB_PASSWORD", $password, "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_DB_ENCRYPT", "true", "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_DB_TRUST_CERT", "true", "User")
    [Environment]::SetEnvironmentVariable("OPTILENS_WRITEBACK_ENABLED", "false", "User")

    Write-Host "OptiLens app DB environment variables saved for the current Windows user."
    Write-Host "Close and reopen the terminal, or restart the service/app, so the new values are loaded."
}
finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
