$ErrorActionPreference = "Stop"

$response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/admin/migrate"
$response | ConvertTo-Json -Depth 5
