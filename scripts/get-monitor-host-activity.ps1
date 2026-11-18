param(
    [Parameter(Mandatory = $true)]
    [string] $ProjectRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$tasks = @(Get-ScheduledTask -TaskName 'OptiLens*' -ErrorAction SilentlyContinue | ForEach-Object {
    $task = $_
    $info = $null
    try { $info = $task | Get-ScheduledTaskInfo -ErrorAction Stop } catch {}
    [pscustomobject]@{
        name = $task.TaskPath + $task.TaskName
        state = [string]$task.State
        lastRun = $(if ($info -and $null -ne $info.LastRunTime) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') })
        lastResult = $(if ($info) { $info.LastTaskResult })
        nextRun = $(if ($info -and $null -ne $info.NextRunTime) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') })
    }
})

$processes = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and ($_.Name -like '*OptiLens*' -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0))
} | ForEach-Object {
    $process = $_
    [pscustomobject]@{
        name = $process.Name
        pid = $process.ProcessId
        started = $(if ($process.CreationDate) { $process.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') })
        memory = $(if ($null -ne $process.WorkingSetSize) { '{0:N1} MB' -f ($process.WorkingSetSize / 1MB) })
    }
})

[pscustomobject]@{ tasks = $tasks; processes = $processes } | ConvertTo-Json -Depth 4 -Compress
