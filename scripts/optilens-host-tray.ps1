param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $HealthUrl = "http://127.0.0.1:8080/api/health",
    [int] $RefreshSeconds = 10
)

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

if ($HealthUrl -eq "http://127.0.0.1:8080/api/health" -and $Port -ne 8080) {
    $HealthUrl = "http://127.0.0.1:$Port/api/health"
}

$mutex = New-Object System.Threading.Mutex($false, "Global\OptiLensLocalHostTray")
if (-not $mutex.WaitOne(0, $false)) {
    return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "OptiLens Local Host Monitor"
$form.Size = New-Object System.Drawing.Size(610, 360)
$form.MinimumSize = New-Object System.Drawing.Size(610, 360)
$form.StartPosition = "CenterScreen"
$form.ShowInTaskbar = $false

$heading = New-Object System.Windows.Forms.Label
$heading.Text = "OptiLens Local Host Monitor"
$heading.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$heading.AutoSize = $true
$heading.Location = New-Object System.Drawing.Point(18, 16)
$form.Controls.Add($heading)

$summary = New-Object System.Windows.Forms.Label
$summary.Text = "Checking local service…"
$summary.AutoSize = $true
$summary.Location = New-Object System.Drawing.Point(20, 48)
$form.Controls.Add($summary)

$list = New-Object System.Windows.Forms.ListView
$list.View = [System.Windows.Forms.View]::Details
$list.FullRowSelect = $true
$list.GridLines = $true
$list.Location = New-Object System.Drawing.Point(20, 78)
$list.Size = New-Object System.Drawing.Size(552, 210)
[void]$list.Columns.Add("Connection", 190)
[void]$list.Columns.Add("Status", 92)
[void]$list.Columns.Add("Detail", 260)
$form.Controls.Add($list)

$updated = New-Object System.Windows.Forms.Label
$updated.AutoSize = $true
$updated.Location = New-Object System.Drawing.Point(20, 302)
$form.Controls.Add($updated)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openStatus = $menu.Items.Add("Open status")
$checkNow = $menu.Items.Add("Check now")
[void]$menu.Items.Add("-")
$openApp = $menu.Items.Add("Open OptiLens Local")
$restartApp = $menu.Items.Add("Restart OptiLens Local")
$stopApp = $menu.Items.Add("Stop OptiLens Local")
[void]$menu.Items.Add("-")
$exit = $menu.Items.Add("Exit monitor")

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Information
$tray.Text = "OptiLens Local Host Monitor"
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

$script:lastOverall = $null
$script:exitRequested = $false

function Get-HealthColour([string] $State) {
    if ($State -in @("online", "enabled", "ready-for-import")) { return [System.Drawing.Color]::ForestGreen }
    if ($State -in @("warning", "credentials-needed", "setup-needed", "discovered")) { return [System.Drawing.Color]::DarkGoldenrod }
    return [System.Drawing.Color]::Firebrick
}

function Invoke-HiddenHostScript {
    param(
        [string] $ScriptName,
        [string[]] $Arguments = @()
    )

    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $scriptPath = Join-Path $PSScriptRoot $ScriptName
    $argumentList = @(
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-File", $scriptPath
    ) + $Arguments
    Start-Process -FilePath $powerShell -ArgumentList $argumentList -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}

function Update-HealthView {
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
        $items = @(
            $health.appDatabase,
            $health.sourceDatabase,
            $health.psqlDatabase,
            $health.mirrorDatabase
        ) | Where-Object { $_ }

        $list.Items.Clear()
        $hasFailure = $false
        $hasWarning = $false
        foreach ($item in $items) {
            $state = [string]$item.state
            if ($state -in @("error", "offline", "failed")) { $hasFailure = $true }
            elseif ($state -notin @("online", "enabled", "ready-for-import")) { $hasWarning = $true }

            $row = New-Object System.Windows.Forms.ListViewItem($item.name)
            [void]$row.SubItems.Add($state.ToUpperInvariant())
            [void]$row.SubItems.Add([string]$item.detail)
            $row.ForeColor = Get-HealthColour $state
            [void]$list.Items.Add($row)
        }

        $overall = if ($hasFailure) { "Needs attention" } elseif ($hasWarning) { "Working with warnings" } else { "All connections healthy" }
        $summary.Text = "$overall — hosted service is responding."
        $summary.ForeColor = if ($hasFailure) { [System.Drawing.Color]::Firebrick } elseif ($hasWarning) { [System.Drawing.Color]::DarkGoldenrod } else { [System.Drawing.Color]::ForestGreen }
        $tray.Icon = if ($hasFailure) { [System.Drawing.SystemIcons]::Error } elseif ($hasWarning) { [System.Drawing.SystemIcons]::Warning } else { [System.Drawing.SystemIcons]::Information }
        $tray.Text = "OptiLens Local: $overall"
        $updated.Text = "Last checked: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

        if ($null -ne $script:lastOverall -and $script:lastOverall -ne $overall) {
            $tray.BalloonTipTitle = "OptiLens Local Host Monitor"
            $tray.BalloonTipText = $overall
            $tray.ShowBalloonTip(5000)
        }
        $script:lastOverall = $overall
    } catch {
        $list.Items.Clear()
        $row = New-Object System.Windows.Forms.ListViewItem("Hosted OptiLens Local service")
        [void]$row.SubItems.Add("OFFLINE")
        [void]$row.SubItems.Add($_.Exception.Message)
        $row.ForeColor = [System.Drawing.Color]::Firebrick
        [void]$list.Items.Add($row)
        $summary.Text = "Service is not responding — watchdog will retry automatically."
        $summary.ForeColor = [System.Drawing.Color]::Firebrick
        $tray.Icon = [System.Drawing.SystemIcons]::Error
        $tray.Text = "OptiLens Local: service offline"
        $updated.Text = "Last checked: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        if ($script:lastOverall -ne "Service offline") {
            $tray.BalloonTipTitle = "OptiLens Local Host Monitor"
            $tray.BalloonTipText = "Service offline. The host watchdog is attempting recovery."
            $tray.ShowBalloonTip(5000)
        }
        $script:lastOverall = "Service offline"
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(5, $RefreshSeconds) * 1000
$timer.Add_Tick({ Update-HealthView })
$timer.Start()

$openStatus.Add_Click({ $form.Show(); $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal; $form.Activate() })
$checkNow.Add_Click({ Update-HealthView })
$openApp.Add_Click({ Start-Process "http://127.0.0.1:$Port/" })
$restartApp.Add_Click({
    $summary.Text = "Restarting OptiLens Local..."
    Invoke-HiddenHostScript -ScriptName "restart-app.ps1" -Arguments @("-ProjectRoot", $ProjectRoot, "-Port", [string]$Port)
    Start-Sleep -Milliseconds 500
    Update-HealthView
})
$stopApp.Add_Click({
    $summary.Text = "Stopping OptiLens Local..."
    Invoke-HiddenHostScript -ScriptName "stop-app.ps1" -Arguments @("-Port", [string]$Port)
    Start-Sleep -Milliseconds 500
    Update-HealthView
})
$context = New-Object System.Windows.Forms.ApplicationContext
$exit.Add_Click({ $script:exitRequested = $true; $timer.Stop(); $tray.Visible = $false; $form.Close(); $context.ExitThread() })
$tray.Add_DoubleClick({ $form.Show(); $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal; $form.Activate() })
$form.Add_FormClosing({ param($sender, $event) if (-not $script:exitRequested -and $event.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) { $event.Cancel = $true; $form.Hide() } })

try {
    Update-HealthView
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $tray.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
