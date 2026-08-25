param(
    [string] $ProjectRoot = "",
    [int] $Port = 8080,
    [string] $HealthUrl = "http://127.0.0.1:8080/api/health",
    [int] $RefreshSeconds = 10
)

if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if ($HealthUrl -eq "http://127.0.0.1:8080/api/health" -and $Port -ne 8080) { $HealthUrl = "http://127.0.0.1:$Port/api/health" }

$mutex = New-Object System.Threading.Mutex($false, "Global\OptiLensLocalHostTray")
if (-not $mutex.WaitOne(0, $false)) { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "OptiLens Local Host Monitor"
$form.ClientSize = New-Object System.Drawing.Size(760, 500)
$form.MinimumSize = New-Object System.Drawing.Size(620, 380)
$form.StartPosition = "CenterScreen"
$form.ShowInTaskbar = $true

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

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Location = New-Object System.Drawing.Point(18, 78)
$tabs.Size = New-Object System.Drawing.Size(724, 390)
$tabs.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
$form.Controls.Add($tabs)

$connectionsPage = New-Object System.Windows.Forms.TabPage
$connectionsPage.Text = "Connections"
$tabs.TabPages.Add($connectionsPage)

$connectionsLayout = New-Object System.Windows.Forms.TableLayoutPanel
$connectionsLayout.Dock = [System.Windows.Forms.DockStyle]::Fill
$connectionsLayout.ColumnCount = 1
$connectionsLayout.RowCount = 2
$connectionsLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 65)))
$connectionsLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 35)))
$connectionsPage.Controls.Add($connectionsLayout)

$list = New-Object System.Windows.Forms.ListView
$list.View = [System.Windows.Forms.View]::Details
$list.FullRowSelect = $true
$list.GridLines = $true
$list.Dock = [System.Windows.Forms.DockStyle]::Fill
[void]$list.Columns.Add("Connection", 230)
[void]$list.Columns.Add("Status", 100)
[void]$list.Columns.Add("Detail", 340)
$connectionsLayout.Controls.Add($list, 0, 0)

$sourcePanel = New-Object System.Windows.Forms.FlowLayoutPanel
$sourcePanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$sourcePanel.Padding = New-Object System.Windows.Forms.Padding(8)
$sourcePanel.WrapContents = $true
$sourcePanel.AutoScroll = $true
$connectionsLayout.Controls.Add($sourcePanel, 0, 1)
$sourceTitle = New-Object System.Windows.Forms.Label
$sourceTitle.Text = "Innovations source"
$sourceTitle.AutoSize = $true
$sourceTitle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$sourcePanel.Controls.Add($sourceTitle)
$sourceActive = New-Object System.Windows.Forms.Label
$sourceActive.Text = "Direct MSSQL: checking…"
$sourceActive.AutoSize = $true
$sourcePanel.Controls.Add($sourceActive)
$sourceParity = New-Object System.Windows.Forms.Label
$sourceParity.Text = ""
$sourceParity.AutoSize = $true
$sourcePanel.Controls.Add($sourceParity)
$sourceLiveButton = New-Object System.Windows.Forms.Button
$sourceLiveButton.Text = "MSSQL only"
$sourceLiveButton.Width = 120
$sourcePanel.Controls.Add($sourceLiveButton)
$sourceMirrorButton = New-Object System.Windows.Forms.Button
$sourceMirrorButton.Visible = $false
$sourceMirrorButton.Width = 100
$sourcePanel.Controls.Add($sourceMirrorButton)
$sourceSyncButton = New-Object System.Windows.Forms.Button
$sourceSyncButton.Visible = $false
$sourceSyncButton.Width = 120
$sourcePanel.Controls.Add($sourceSyncButton)
$sourceMessage = New-Object System.Windows.Forms.Label
$sourceMessage.AutoSize = $true
$sourceMessage.Text = ""
$sourcePanel.Controls.Add($sourceMessage)
$script:sourceLatest = $null
$script:sourceForceTarget = ""

$syncPage = New-Object System.Windows.Forms.TabPage
$syncPage.Text = "Innovations Sync"
$syncPage.AutoScroll = $true
$tabs.TabPages.Add($syncPage)

$syncLayout = New-Object System.Windows.Forms.TableLayoutPanel
$syncLayout.Dock = [System.Windows.Forms.DockStyle]::Fill
$syncLayout.ColumnCount = 1
$syncLayout.RowCount = 3
$syncLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 112)))
$syncLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 38)))
$syncLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 62)))
$syncPage.Controls.Add($syncLayout)

$syncActions = New-Object System.Windows.Forms.FlowLayoutPanel
$syncActions.Dock = [System.Windows.Forms.DockStyle]::Fill
$syncActions.Padding = New-Object System.Windows.Forms.Padding(8)
$syncActions.WrapContents = $true
$syncActions.AutoScroll = $true
$syncLayout.Controls.Add($syncActions, 0, 0)

$syncStatus = New-Object System.Windows.Forms.Label
$syncStatus.AutoSize = $true
$syncStatus.Text = "Sync status: checking…"
$syncActions.Controls.Add($syncStatus)
$syncCredentials = New-Object System.Windows.Forms.Label
$syncCredentials.AutoSize = $true
$syncCredentials.Text = "Credentials: checking…"
$syncActions.Controls.Add($syncCredentials)
$accountBox = New-Object System.Windows.Forms.TextBox
$accountBox.Width = 150
$syncActions.Controls.Add($accountBox)
$selfTestButton = New-Object System.Windows.Forms.Button
$selfTestButton.Text = "Run self-test"
$syncActions.Controls.Add($selfTestButton)
$dryRunButton = New-Object System.Windows.Forms.Button
$dryRunButton.Text = "Dry run"
$syncActions.Controls.Add($dryRunButton)
$syncButton = New-Object System.Windows.Forms.Button
$syncButton.Text = "Sync now"
$syncActions.Controls.Add($syncButton)
$refreshLogsButton = New-Object System.Windows.Forms.Button
$refreshLogsButton.Text = "Refresh logs"
$syncActions.Controls.Add($refreshLogsButton)

$entityPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$entityPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$entityPanel.Padding = New-Object System.Windows.Forms.Padding(8)
$entityPanel.AutoScroll = $true
$syncLayout.Controls.Add($entityPanel, 0, 1)
$entityNames = @("customers", "contacts", "balances", "order_activity", "statements", "statement_lines")
$entityChecks = @{}
foreach ($entity in $entityNames) {
    $check = New-Object System.Windows.Forms.CheckBox
    $check.Text = $entity.Replace("_", " ")
    $check.Tag = $entity
    $check.AutoSize = $true
    $check.Checked = $entity -in @("customers", "contacts")
    $entityChecks[$entity] = $check
    $entityPanel.Controls.Add($check)
}
$suppressEmails = New-Object System.Windows.Forms.CheckBox
$suppressEmails.Text = "Suppress statement emails (backfill)"
$suppressEmails.AutoSize = $true
$entityPanel.Controls.Add($suppressEmails)

$outputSplit = New-Object System.Windows.Forms.SplitContainer
$outputSplit.Dock = [System.Windows.Forms.DockStyle]::Fill
$outputSplit.Orientation = [System.Windows.Forms.Orientation]::Horizontal
$outputSplit.SplitterDistance = 105
$syncLayout.Controls.Add($outputSplit, 0, 2)
$resultBox = New-Object System.Windows.Forms.TextBox
$resultBox.Multiline = $true
$resultBox.ReadOnly = $true
$resultBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$resultBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$resultBox.Text = "Self-test and sync results will appear here."
$outputSplit.Panel1.Controls.Add($resultBox)
$logsBox = New-Object System.Windows.Forms.TextBox
$logsBox.Multiline = $true
$logsBox.ReadOnly = $true
$logsBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$logsBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$logsBox.Text = "Loading sync logs…"
$outputSplit.Panel2.Controls.Add($logsBox)

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

function Invoke-MonitorApi([string] $Path, [string] $Method = "GET", [hashtable] $Body = $null) {
    $params = @{ Uri = "http://127.0.0.1:$Port$Path"; Method = $Method; TimeoutSec = 30 }
    if ($null -ne $Body) { $params.ContentType = "application/json"; $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress) }
    return Invoke-RestMethod @params
}

function Update-HealthView {
    try {
        $health = Invoke-MonitorApi "/api/health"
        $items = @($health.appDatabase, $health.sourceDatabase, $health.innovationsSync) | Where-Object { $_ }
        $list.Items.Clear()
        $hasFailure = $false; $hasWarning = $false
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
        if ($null -ne $script:lastOverall -and $script:lastOverall -ne $overall) { $tray.ShowBalloonTip(4000, "OptiLens Local Host Monitor", $overall, [System.Windows.Forms.ToolTipIcon]::Info) }
        $script:lastOverall = $overall
        Update-SyncStatus
        Update-SourceBackend
    } catch {
        $list.Items.Clear()
        $row = New-Object System.Windows.Forms.ListViewItem("OptiLens Local service")
        [void]$row.SubItems.Add("OFFLINE")
        [void]$row.SubItems.Add($_.Exception.Message)
        $row.ForeColor = [System.Drawing.Color]::Firebrick
        [void]$list.Items.Add($row)
        $summary.Text = "Service is not responding — watchdog will retry automatically."
        $summary.ForeColor = [System.Drawing.Color]::Firebrick
    }
}

function Update-SourceBackend {
    try {
        $health = Invoke-MonitorApi "/api/health"
        $sourceActive.Text = "Direct MSSQL: $($health.sourceDatabase.state)"
        $sourceActive.ForeColor = Get-HealthColour $health.sourceDatabase.state
        $sourceParity.Text = "Mirror, PSQL, ODBC, and Access connections are retired."
        $sourceParity.ForeColor = [System.Drawing.Color]::ForestGreen
        $sourceLiveButton.Enabled = $false
        $sourceMessage.Text = $health.sourceDatabase.detail
    } catch { $sourceActive.Text = "MSSQL source unavailable: $($_.Exception.Message)"; $sourceActive.ForeColor = [System.Drawing.Color]::Firebrick }
}

function Switch-SourceBackend([string] $Target) {
    $sourceMessage.Text = "The Innovations source is direct MSSQL only."
    Update-SourceBackend
}

function Start-SourceMirrorSync {
    $sourceMessage.Text = "Mirror synchronization is retired."
}

function Update-SyncStatus {
    try {
        $status = Invoke-MonitorApi "/api/monitor/innovations-sync/status"
        $syncStatus.Text = "Sync: $($status.state) — $($status.detail)"
        $syncCredentials.Text = if ($status.credentialsConfigured) { "Credentials: persisted" } else { "Credentials: missing" }
        $syncStatus.ForeColor = Get-HealthColour $status.state
        $syncCredentials.ForeColor = if ($status.credentialsConfigured) { [System.Drawing.Color]::ForestGreen } else { [System.Drawing.Color]::Firebrick }
    } catch { $syncStatus.Text = "Sync status unavailable: $($_.Exception.Message)"; $syncStatus.ForeColor = [System.Drawing.Color]::Firebrick }
}

function Selected-Entities {
    return @($entityChecks.Values | Where-Object Checked | ForEach-Object { [string]$_.Tag })
}

function Render-Response($response) { $resultBox.Text = ($response | ConvertTo-Json -Depth 10) }

function Run-SelfTest {
    $selfTestButton.Enabled = $false
    try { $response = Invoke-MonitorApi "/api/monitor/innovations-sync/selftest" "POST" @{ account = $accountBox.Text }; Render-Response $response }
    catch { $resultBox.Text = "Self-test failed: $($_.Exception.Message)" }
    finally { $selfTestButton.Enabled = $true; Update-SyncStatus }
}

function Run-Sync([bool] $Commit) {
    $entities = Selected-Entities
    if ($entities.Count -eq 0) { $resultBox.Text = "Select at least one entity."; return }
    if ($Commit -and ([System.Windows.Forms.MessageBox]::Show("Write the selected Innovations data to Classic Visions now?", "Confirm sync", "YesNo", "Warning") -ne "Yes")) { return }
    $dryRunButton.Enabled = $false; $syncButton.Enabled = $false
    try {
        $response = Invoke-MonitorApi "/api/monitor/innovations-sync/run" "POST" @{ commit = $Commit; entities = $entities; suppressStatementEmails = $suppressEmails.Checked }
        Render-Response $response
    } catch { $resultBox.Text = "Sync failed: $($_.Exception.Message)" }
    finally { $dryRunButton.Enabled = $true; $syncButton.Enabled = $true; Update-SyncStatus; Refresh-Logs }
}

function Refresh-Logs {
    try { $logsBox.Text = ((Invoke-MonitorApi "/api/monitor/innovations-sync/logs?limit=80").events | ForEach-Object { "$(($_.at))  $(($_.event))  $($_ | ConvertTo-Json -Compress -Depth 8)" }) -join [Environment]::NewLine }
    catch { $logsBox.Text = "Logs unavailable: $($_.Exception.Message)" }
}

$selfTestButton.Add_Click({ Run-SelfTest })
$dryRunButton.Add_Click({ Run-Sync $false })
$syncButton.Add_Click({ Run-Sync $true })
$refreshLogsButton.Add_Click({ Refresh-Logs })
$sourceLiveButton.Add_Click({ Switch-SourceBackend "live" })
$sourceMirrorButton.Add_Click({ Switch-SourceBackend "mirror" })
$sourceSyncButton.Add_Click({ Start-SourceMirrorSync })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(5, $RefreshSeconds) * 1000
$timer.Add_Tick({ Update-HealthView })
$timer.Start()

function Invoke-HiddenHostScript { param([string] $ScriptName, [string[]] $Arguments = @()); $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"; Start-Process -FilePath $ps -ArgumentList (@("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot $ScriptName)) + $Arguments) -WorkingDirectory $ProjectRoot -WindowStyle Hidden }
$openStatus.Add_Click({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
$checkNow.Add_Click({ Update-HealthView })
$openApp.Add_Click({ Start-Process "http://127.0.0.1:$Port/" })
$restartApp.Add_Click({ Invoke-HiddenHostScript "restart-app.ps1" @("-ProjectRoot", $ProjectRoot, "-Port", [string]$Port); Start-Sleep -Milliseconds 500; Update-HealthView })
$stopApp.Add_Click({ Invoke-HiddenHostScript "stop-app.ps1" @("-ProjectRoot", $ProjectRoot, "-Port", [string]$Port, "-Intentional"); Start-Sleep -Milliseconds 500; Update-HealthView })
$exit.Add_Click({ $script:exitRequested = $true; $timer.Stop(); $tray.Visible = $false; $form.Close() })
$tray.Add_DoubleClick({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
$form.Add_FormClosing({ param($sender, $event); if (-not $script:exitRequested -and $event.CloseReason -eq "UserClosing") { $event.Cancel = $true; $form.Hide() } })

try { Update-HealthView; Refresh-Logs; [System.Windows.Forms.Application]::Run($form) } finally { $tray.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }
