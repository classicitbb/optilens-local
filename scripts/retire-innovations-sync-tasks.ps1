# Removes the two scheduled tasks replaced by the always-on sync worker
# (lib/innovations-sync-worker.js). Run on the OptiLens host as Administrator
# AFTER OPTILENS_SYNC_WORKER=on is set and the service has restarted.
#   powershell -ExecutionPolicy Bypass -File scripts\retire-innovations-sync-tasks.ps1

$ErrorActionPreference = "Stop"
foreach ($name in @("OptiLens Innovations Sync", "OptiLens Innovations Sync Requests")) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Removed scheduled task: $name"
    } else {
        Write-Host "Not installed: $name"
    }
}
Write-Host "The OptiLens Local service now runs the Innovations sync (GET /api/connectors/innovations-sync/worker shows its status)."
