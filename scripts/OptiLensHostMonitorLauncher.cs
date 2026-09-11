using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class OptiLensHostMonitor : Form
{
    private static readonly string monitorLog = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "logs", "host-monitor.log");
    private readonly string projectRoot;
    private readonly int port;
    private readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly NotifyIcon tray;
    private readonly Label summary = new Label();
    private readonly Label updateStatus = new Label();
    private readonly Button checkUpdatesButton = new Button { Text = "Check for updates", Width = 125 };
    private readonly Button applyUpdatesButton = new Button { Text = "Apply pushed updates", Width = 145, Enabled = false };
    private readonly Button fixErrorsButton = new Button { Text = "Super-user Fix errors", Width = 150, Enabled = false };
    private readonly Button startServiceButton = new Button { Text = "Start service", Width = 100 };
    private readonly Button restartServiceButton = new Button { Text = "Restart service", Width = 110 };
    private readonly Button stopServiceButton = new Button { Text = "Shut down service", Width = 120 };
    private readonly ListView connections = new ListView();
    private readonly Label sourceStatus = new Label();
    private readonly Label sourceParity = new Label();
    private readonly Label sourceMessage = new Label();
    private readonly Button rxAliasSyncButton = new Button { Text = "Sync RX aliases now", Width = 135 };
    private readonly Label rxAliasSyncMessage = new Label();
    private readonly Label httpsStatus = new Label();
    private readonly Label localCaStatus = new Label();
    private readonly Label syncStatus = new Label();
    private readonly Label syncCredentials = new Label();
    private readonly TextBox resultBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill };
    private readonly TextBox logsBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill };
    private readonly TextBox accountBox = new TextBox { Width = 150 };
    private readonly Dictionary<string, CheckBox> entityChecks = new Dictionary<string, CheckBox>();
    private readonly CheckBox suppressEmails = new CheckBox { Text = "Suppress statement emails (backfill)", AutoSize = true };
    private readonly Timer timer = new Timer { Interval = 10000 };
    private readonly Timer activationTimer = new Timer { Interval = 250 };
    private readonly System.Threading.EventWaitHandle showSignal;
    private bool serviceOnline;
    private bool exitRequested;
    private bool firstRefresh = true;
    private string lastIncidentFingerprint = "";
    private bool repairInProgress;
    private readonly bool startVisible;
    private bool updateInProgress;
    private Form updateProgressWindow;
    private TextBox updateProgressBox;
    private Label updateProgressSummary;
    private bool restartInProgress;
    private DateTime restartProgressStartedAt;
    private string restartProgressRunId = "";
    private Form restartProgressWindow;
    private ProgressBar restartProgressBar;
    private TextBox restartProgressBox;
    private Label restartProgressSummary;
    private readonly Timer restartProgressTimer = new Timer { Interval = 1000 };
    private ToolStripMenuItem trayStartService;
    private ToolStripMenuItem trayRestartService;
    private ToolStripMenuItem trayStopService;

    public OptiLensHostMonitor(string root, int requestedPort, System.Threading.EventWaitHandle signal, bool visibleOnStartup)
    {
        projectRoot = root;
        port = requestedPort;
        showSignal = signal;
        startVisible = visibleOnStartup;
        Text = "OptiLens Local Host Monitor";
        ClientSize = new Size(760, 500);
        MinimumSize = new Size(620, 380);
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
        Icon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName) ?? SystemIcons.Application;

        summary.Text = "Checking local service…";
        summary.AutoSize = true;
        summary.Location = new Point(20, 48);
        Controls.Add(summary);

        var heading = new Label { Text = "OptiLens Local Host Monitor", AutoSize = true, Font = new Font("Segoe UI", 14, FontStyle.Bold), Location = new Point(18, 16) };
        Controls.Add(heading);

        var tabs = new TabControl { Location = new Point(18, 78), Size = new Size(724, 390), Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right };
        Controls.Add(tabs);
        tabs.TabPages.Add(BuildConnectionsPage());
        tabs.TabPages.Add(BuildSyncPage());
        tabs.TabPages.Add(BuildHttpsPage());

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open monitor", null, delegate { ShowMonitorWindow(); });
        menu.Items.Add("Open OptiLens Local", null, delegate { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/") { UseShellExecute = true }); });
        menu.Items.Add("Open OptiLens HTTPS", null, delegate { Process.Start(new ProcessStartInfo("https://optilens.cv.net/") { UseShellExecute = true }); });
        menu.Items.Add("Open local DNS console", null, delegate { Process.Start(new ProcessStartInfo("http://127.0.0.1:5380/") { UseShellExecute = true }); });
        trayStartService = new ToolStripMenuItem("Start OptiLens Local");
        trayStartService.Click += delegate { if (!restartInProgress) RunHostScript("start-app.ps1"); };
        menu.Items.Add(trayStartService);
        trayRestartService = new ToolStripMenuItem("Restart OptiLens Local");
        trayRestartService.Click += delegate { BeginRestartProgressWorkflow(true, "Restart requested from the tray."); };
        menu.Items.Add(trayRestartService);
        trayStopService = new ToolStripMenuItem("Shut down OptiLens Local");
        trayStopService.Click += delegate { if (!restartInProgress) RunHostScript("stop-app.ps1", true); };
        menu.Items.Add(trayStopService);
        menu.Items.Add("Check for pushed updates", null, async delegate { await CheckUpdates(); });
        menu.Items.Add("Exit monitor", null, delegate { exitRequested = true; Close(); });
        tray = new NotifyIcon { Icon = Icon, Text = "OptiLens Local Host Monitor", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { ShowMonitorWindow(); };

        timer.Tick += async delegate { await RefreshAll(); };
        activationTimer.Tick += delegate { try { if (showSignal.WaitOne(0)) ShowMonitorWindow(); } catch { } };
        restartProgressTimer.Tick += async delegate { await RefreshRestartProgress(); };
        Shown += async delegate { await RefreshAll(); await RefreshLogs(); };
        FormClosing += OnFormClosing;
        FormClosed += delegate { Log("closed"); timer.Stop(); restartProgressTimer.Stop(); tray.Visible = false; tray.Dispose(); http.Dispose(); };
        timer.Start();
        activationTimer.Start();
        Log("started port " + port);
    }

    private TabPage BuildConnectionsPage()
    {
        var page = new TabPage("Connections");
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        page.Controls.Add(layout);

        var service = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), WrapContents = false };
        updateStatus.Text = "Updates: not checked"; updateStatus.AutoSize = true; service.Controls.Add(updateStatus);
        service.Controls.Add(checkUpdatesButton); service.Controls.Add(applyUpdatesButton); service.Controls.Add(fixErrorsButton);
        service.Controls.Add(startServiceButton); service.Controls.Add(restartServiceButton); service.Controls.Add(stopServiceButton);
        layout.Controls.Add(service, 0, 0);
        connections.View = View.Details;
        connections.FullRowSelect = true;
        connections.GridLines = true;
        connections.Dock = DockStyle.Fill;
        connections.Columns.Add("Connection", 230);
        connections.Columns.Add("Status", 100);
        connections.Columns.Add("Detail", 340);
        layout.Controls.Add(connections, 0, 1);

        var source = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), AutoScroll = true, WrapContents = true };
        layout.Controls.Add(source, 0, 2);
        source.Controls.Add(new Label { Text = "Innovations source backend", AutoSize = true, Font = new Font("Segoe UI", 9, FontStyle.Bold) });
        sourceStatus.Text = "Active: checking…"; sourceStatus.AutoSize = true; source.Controls.Add(sourceStatus);
        sourceParity.AutoSize = true; source.Controls.Add(sourceParity);
        source.Controls.Add(rxAliasSyncButton);
        rxAliasSyncMessage.AutoSize = true; source.Controls.Add(rxAliasSyncMessage);
        sourceMessage.AutoSize = true; source.Controls.Add(sourceMessage);
        rxAliasSyncButton.Click += async delegate { await StartRxAliasSync(); };
        checkUpdatesButton.Click += async delegate { await CheckUpdates(); };
        applyUpdatesButton.Click += async delegate { await ApplyUpdates(); };
        fixErrorsButton.Click += async delegate { await FixErrors(); };
        startServiceButton.Click += delegate { if (!restartInProgress) RunHostScript("start-app.ps1"); };
        restartServiceButton.Click += delegate { BeginRestartProgressWorkflow(true, "Restart requested from Connections."); };
        stopServiceButton.Click += delegate { if (!restartInProgress) RunHostScript("stop-app.ps1", true); };
        return page;
    }

    private TabPage BuildSyncPage()
    {
        var page = new TabPage("Innovations Sync");
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        page.Controls.Add(layout);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), AutoScroll = true, WrapContents = true };
        layout.Controls.Add(actions, 0, 0);
        syncStatus.Text = "Sync: checking…"; syncStatus.AutoSize = true; actions.Controls.Add(syncStatus);
        syncCredentials.Text = "Credentials: checking…"; syncCredentials.AutoSize = true; actions.Controls.Add(syncCredentials);
        actions.Controls.Add(accountBox);
        var selfTest = new Button { Text = "Run self-test" }; selfTest.Click += async delegate { await RunSelfTest(); }; actions.Controls.Add(selfTest);
        var dryRun = new Button { Text = "Dry run" }; dryRun.Click += async delegate { await RunSync(false); }; actions.Controls.Add(dryRun);
        var sync = new Button { Text = "Sync now" }; sync.Click += async delegate { await RunSync(true); }; actions.Controls.Add(sync);
        var refresh = new Button { Text = "Refresh logs" }; refresh.Click += async delegate { await RefreshLogs(); }; actions.Controls.Add(refresh);

        var entities = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), AutoScroll = true, WrapContents = true };
        layout.Controls.Add(entities, 0, 1);
        foreach (var name in new[] { "customers", "contacts", "balances", "order_activity", "statements", "statement_lines" })
        {
            var check = new CheckBox { Text = name.Replace("_", " "), Tag = name, AutoSize = true, Checked = name == "customers" || name == "contacts" };
            entityChecks[name] = check; entities.Controls.Add(check);
        }
        entities.Controls.Add(suppressEmails);

        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, SplitterDistance = 105 };
        resultBox.Text = "Self-test and sync results will appear here.";
        logsBox.Text = "Loading sync logs…";
        split.Panel1.Controls.Add(resultBox); split.Panel2.Controls.Add(logsBox);
        layout.Controls.Add(split, 0, 2);
        return page;
    }

    private TabPage BuildHttpsPage()
    {
        var page = new TabPage("HTTPS & DNS");
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12), AutoScroll = true, WrapContents = true };
        page.Controls.Add(layout);
        layout.Controls.Add(new Label { Text = "OptiLens LAN HTTPS", AutoSize = true, Font = new Font("Segoe UI", 10, FontStyle.Bold) });
        httpsStatus.AutoSize = true; localCaStatus.AutoSize = true;
        layout.Controls.Add(httpsStatus); layout.Controls.Add(localCaStatus);
        var openHttps = new Button { Text = "Open HTTPS site", Width = 120 };
        var openDns = new Button { Text = "Open DNS console", Width = 120 };
        var exportRoot = new Button { Text = "Open root certificate", Width = 145 };
        var renewLeaf = new Button { Text = "Renew server certificate", Width = 165 };
        layout.Controls.Add(openHttps); layout.Controls.Add(openDns); layout.Controls.Add(exportRoot); layout.Controls.Add(renewLeaf);
        layout.Controls.Add(new Label { Text = "The CA private key stays on this host. Install the exported public root certificate and use this host as DNS on each LAN device before browsing optilens.cv.net.", AutoSize = true, MaximumSize = new Size(650, 0) });
        openHttps.Click += delegate { Process.Start(new ProcessStartInfo("https://optilens.cv.net/") { UseShellExecute = true }); };
        openDns.Click += delegate { Process.Start(new ProcessStartInfo("http://127.0.0.1:5380/") { UseShellExecute = true }); };
        exportRoot.Click += delegate { Process.Start(new ProcessStartInfo(Path.Combine(projectRoot, "data", "certificates")) { UseShellExecute = true }); };
        renewLeaf.Click += delegate { if (MessageBox.Show("Issue and bind a fresh OptiLens server certificate now?", "Confirm certificate renewal", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes) RunHostScript("manage-local-https.ps1", false, "-Action RenewServerCertificate"); };
        return page;
    }

    private async Task<string> Api(string path, string method = "GET", object body = null)
    {
        var request = new HttpRequestMessage(new HttpMethod(method), "http://127.0.0.1:" + port + path);
        if (body != null) request.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json");
        var response = await http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(text);
        return text;
    }

    private static object Value(IDictionary<string, object> map, string key) { object value; return map != null && map.TryGetValue(key, out value) ? value : null; }
    private static string S(object value) { return value == null ? "" : Convert.ToString(value); }
    private static IDictionary<string, object> Map(object value) { return value as IDictionary<string, object>; }

    private async Task RefreshAll()
    {
        try
        {
            var health = Map(json.DeserializeObject(await Api("/api/health")));
            serviceOnline = health != null;
            SetServiceControls();
            connections.Items.Clear();
            var hasFailure = false;
            var hasWarning = false;
            var failedConnections = new List<string>();
            foreach (var key in new[] { "appDatabase", "sourceDatabase", "innovationsSync", "rxAliasSync" })
            {
                var item = Map(Value(health, key)); if (item == null) continue;
                var state = S(Value(item, "state"));
                if (state == "error" || state == "offline" || state == "failed") hasFailure = true;
                if (state == "error" || state == "offline" || state == "failed") failedConnections.Add(S(Value(item, "name")));
                else if (state != "online" && state != "enabled" && state != "ready-for-import") hasWarning = true;
                var row = new ListViewItem(S(Value(item, "name"))); row.SubItems.Add(state.ToUpperInvariant()); row.SubItems.Add(S(Value(item, "detail")));
                row.ForeColor = ColorFor(state); connections.Items.Add(row);
            }
            var overall = hasFailure ? "Needs attention" : hasWarning ? "Working with warnings" : "All connections healthy";
            summary.Text = overall + " — hosted service is responding.";
            summary.ForeColor = hasFailure ? Color.Firebrick : hasWarning ? Color.DarkGoldenrod : Color.ForestGreen;
            tray.Icon = hasFailure ? SystemIcons.Error : hasWarning ? SystemIcons.Warning : SystemIcons.Information;
            tray.Text = "OptiLens Local: " + overall;
            fixErrorsButton.Enabled = hasFailure && !repairInProgress && !restartInProgress;
            await RefreshSource();
            await RefreshSyncStatus();
            await RefreshRxAliasSyncStatus();
            await RefreshQboInvoiceSyncStatus();
            RefreshTlsStatus();
            if (hasFailure) await ReportIncident(failedConnections);
            if (firstRefresh && !startVisible && !hasFailure && !hasWarning)
            {
                firstRefresh = false;
                BeginInvoke(new Action(HideToTray));
            }
            else
            {
                firstRefresh = false;
            }
        }
        catch
        {
            serviceOnline = false;
            summary.Text = "OptiLens Local service is offline — use the tray menu to start it.";
            summary.ForeColor = Color.Firebrick;
            tray.Icon = SystemIcons.Error; tray.Text = "OptiLens Local: service offline";
            SetServiceControls();
            fixErrorsButton.Enabled = !restartInProgress;
            var _ = ReportIncident(new List<string> { "OptiLens Local service" });
            if (!restartInProgress) RunHostScript("ensure-app-running.ps1");
        }
    }

    private async Task CheckUpdates()
    {
        try
        {
            var status = Map(json.DeserializeObject(await Api("/api/monitor/updates")));
            var available = Convert.ToBoolean(Value(status, "available"));
            var applying = Convert.ToBoolean(Value(status, "applying"));
            var areas = Value(status, "changedAreas") as object[];
            updateStatus.Text = applying ? "Update in progress — waiting for service restart" : available ? "Updates ready: " + (areas == null ? "pushed changes" : areas.Length + " area(s)") : "Updates: up to date";
            updateStatus.ForeColor = applying || available ? Color.DarkGoldenrod : Color.ForestGreen;
            applyUpdatesButton.Enabled = !updateInProgress && !applying && available && Convert.ToBoolean(Value(Value(status, "plan") as IDictionary<string, object>, "restartService"));
        }
        catch (Exception error) { updateStatus.Text = "Update check failed: " + error.Message; updateStatus.ForeColor = Color.Firebrick; applyUpdatesButton.Enabled = false; }
    }

    private async Task ApplyUpdates()
    {
        if (MessageBox.Show("Apply the pushed OptiLens Local update and restart the service?", "Confirm update", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        updateInProgress = true;
        applyUpdatesButton.Enabled = false;
        ShowUpdateProgress();
        try
        {
            var result = Map(json.DeserializeObject(await Api("/api/monitor/updates/apply", "POST")));
            updateStatus.Text = S(Value(result, "message")); updateStatus.ForeColor = Color.DarkGoldenrod;
            AppendUpdateProgress("Update accepted. The monitor will show each runner step and reconnect after the service restart.");
            for (var attempt = 1; attempt <= 180; attempt++)
            {
                await RefreshUpdateProgress();
                await Task.Delay(1000);
                if (await IsUpdateComplete()) break;
            }
        }
        catch (Exception error)
        {
            updateStatus.Text = "Update failed to start: " + error.Message; updateStatus.ForeColor = Color.Firebrick;
            AppendUpdateProgress("UPDATE REQUEST FAILED: " + error.Message);
        }
        finally
        {
            updateInProgress = false;
        }
        await RefreshUpdateProgress();
        await RefreshAll();
    }

    private void ShowUpdateProgress()
    {
        if (updateProgressWindow == null || updateProgressWindow.IsDisposed)
        {
            updateProgressWindow = new Form { Text = "OptiLens Local Update Progress", ClientSize = new Size(820, 520), StartPosition = FormStartPosition.CenterParent, MinimizeBox = true };
            updateProgressSummary = new Label { Text = "Preparing update runner…", Dock = DockStyle.Top, Height = 34, Padding = new Padding(10, 8, 10, 0), ForeColor = Color.DarkGoldenrod };
            updateProgressBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill, Font = new Font("Consolas", 9) };
            updateProgressWindow.Controls.Add(updateProgressBox);
            updateProgressWindow.Controls.Add(updateProgressSummary);
        }
        updateProgressWindow.Show();
        updateProgressWindow.BringToFront();
    }

    private void AppendUpdateProgress(string text)
    {
        if (updateProgressBox == null) return;
        updateProgressBox.AppendText(DateTime.Now.ToString("HH:mm:ss") + " " + text + Environment.NewLine);
        updateProgressBox.SelectionStart = updateProgressBox.TextLength;
        updateProgressBox.ScrollToCaret();
    }

    private async Task RefreshUpdateProgress()
    {
        try
        {
            var response = Map(json.DeserializeObject(await Api("/api/monitor/updates/logs")));
            var logs = Value(response, "logs") as object[];
            var updateLog = logs == null ? null : logs.Select(Map).FirstOrDefault(log => S(Value(log, "path")).EndsWith("data/local-update.log", StringComparison.OrdinalIgnoreCase));
            if (updateLog != null && updateProgressBox != null)
            {
                var text = S(Value(updateLog, "text"));
                if (!string.Equals(updateProgressBox.Tag as string, text, StringComparison.Ordinal))
                {
                    updateProgressBox.Text = text;
                    updateProgressBox.Tag = text;
                    updateProgressBox.SelectionStart = updateProgressBox.TextLength;
                    updateProgressBox.ScrollToCaret();
                }
            }
            if (updateProgressSummary != null) { updateProgressSummary.Text = "Update runner is active. Refreshing diagnostic log every second…"; updateProgressSummary.ForeColor = Color.DarkGoldenrod; }
        }
        catch (Exception error)
        {
            if (updateProgressSummary != null) { updateProgressSummary.Text = "Waiting for service to restart: " + error.Message; updateProgressSummary.ForeColor = Color.DarkGoldenrod; }
        }
    }

    private async Task<bool> IsUpdateComplete()
    {
        try
        {
            var status = Map(json.DeserializeObject(await Api("/api/monitor/updates")));
            if (Convert.ToBoolean(Value(status, "available"))) return false;
            if (updateProgressSummary != null) { updateProgressSummary.Text = "Update completed and service is reachable."; updateProgressSummary.ForeColor = Color.ForestGreen; }
            updateStatus.Text = "Updates: up to date"; updateStatus.ForeColor = Color.ForestGreen;
            return true;
        }
        catch { return false; }
    }

    private async Task ReportIncident(List<string> failedConnections)
    {
        var fingerprint = string.Join(",", failedConnections.OrderBy(value => value));
        if (fingerprint == lastIncidentFingerprint) return;
        lastIncidentFingerprint = fingerprint;
        try { await Api("/api/monitor/incidents", "POST", new { fingerprint = "health:" + fingerprint, title = "OptiLens Local connection error", message = "The host monitor detected one or more failed connections.", failedConnections = failedConnections }); } catch { }
    }

    private async Task FixErrors()
    {
        if (repairInProgress) return;
        if (MessageBox.Show("This privileged command collects host evidence and runs one bounded repair. It never edits source files automatically. Continue?", "Super-user Fix errors", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        repairInProgress = true; fixErrorsButton.Enabled = false;
        try
        {
            var failed = connections.Items.Cast<ListViewItem>().Where(item => item.ForeColor == Color.Firebrick).Select(item => item.Text).ToArray();
            var result = Map(json.DeserializeObject(await Api("/api/monitor/recovery/fix", "POST", new { confirmation = "FIX ERRORS", failedConnections = failed })));
            summary.Text = S(Value(result, "message")); summary.ForeColor = Color.DarkGoldenrod;
            BeginRestartProgressWorkflow(false, "Controlled recovery started; waiting for its restart run.");
        }
        catch (Exception error) { summary.Text = "Super-user recovery blocked or failed: " + error.Message; summary.ForeColor = Color.Firebrick; repairInProgress = false; fixErrorsButton.Enabled = true; }
        await Task.Delay(1000); await RefreshAll(); repairInProgress = false;
    }

    private void SetServiceControls()
    {
        var enabled = !restartInProgress;
        startServiceButton.Enabled = enabled && !serviceOnline;
        restartServiceButton.Enabled = enabled && serviceOnline;
        stopServiceButton.Enabled = enabled && serviceOnline;
        if (trayStartService != null) trayStartService.Enabled = enabled && !serviceOnline;
        if (trayRestartService != null) trayRestartService.Enabled = enabled && serviceOnline;
        if (trayStopService != null) trayStopService.Enabled = enabled && serviceOnline;
    }

    private void BeginRestartProgressWorkflow(bool launchRestart, string initialMessage)
    {
        if (restartInProgress) { ShowRestartProgress(); return; }
        restartInProgress = true; restartProgressStartedAt = DateTime.UtcNow; restartProgressRunId = "";
        SetServiceControls(); ShowRestartProgress(); restartProgressSummary.Text = initialMessage; restartProgressSummary.ForeColor = Color.DarkGoldenrod; restartProgressBar.Value = 0;
        restartProgressBox.Text = "Waiting for durable restart state and logs..." + Environment.NewLine;
        if (launchRestart) RunHostScript("restart-app.ps1");
        restartProgressTimer.Start(); var ignored = RefreshRestartProgress();
    }

    private void ShowRestartProgress()
    {
        if (restartProgressWindow == null || restartProgressWindow.IsDisposed)
        {
            restartProgressWindow = new Form { Text = "OptiLens Local Restart Progress", ClientSize = new Size(820, 560), StartPosition = FormStartPosition.CenterParent, MinimizeBox = true };
            restartProgressSummary = new Label { Text = "Preparing restart…", Dock = DockStyle.Top, Height = 34, Padding = new Padding(10, 8, 10, 0), ForeColor = Color.DarkGoldenrod };
            restartProgressBar = new ProgressBar { Dock = DockStyle.Top, Height = 22, Minimum = 0, Maximum = 100, Style = ProgressBarStyle.Continuous };
            restartProgressBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill, Font = new Font("Consolas", 9) };
            restartProgressWindow.Controls.Add(restartProgressBox); restartProgressWindow.Controls.Add(restartProgressBar); restartProgressWindow.Controls.Add(restartProgressSummary);
        }
        restartProgressWindow.Show(); restartProgressWindow.BringToFront();
    }

    private static string ReadTail(string path, int maximumCharacters)
    {
        try { using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) { var length = Math.Min(stream.Length, maximumCharacters * 2L); stream.Seek(-length, SeekOrigin.End); using (var reader = new StreamReader(stream)) return reader.ReadToEnd(); } }
        catch { return "(no output yet)"; }
    }

    private async Task RefreshRestartProgress()
    {
        if (!restartInProgress) return;
        try
        {
            IDictionary<string, object> state = null;
            try { state = Map(json.DeserializeObject(File.ReadAllText(Path.Combine(projectRoot, "data", "service-restart-state.json")))); } catch { }
            var restartLog = ReadTail(Path.Combine(projectRoot, "data", "logs", "service-restart.log"), 50000);
            var serverErrors = ReadTail(Path.Combine(projectRoot, "server.err.log"), 50000);
            var combined = "RESTART RUN OUTPUT" + Environment.NewLine + restartLog + Environment.NewLine + Environment.NewLine + "SERVER-ERROR OUTPUT" + Environment.NewLine + serverErrors;
            if (restartProgressBox != null && !string.Equals(restartProgressBox.Tag as string, combined, StringComparison.Ordinal)) { restartProgressBox.Text = combined; restartProgressBox.Tag = combined; restartProgressBox.SelectionStart = restartProgressBox.TextLength; restartProgressBox.ScrollToCaret(); }
            if (state == null) { if ((DateTime.UtcNow - restartProgressStartedAt).TotalSeconds > 180) FinishRestartProgress(false, "Timed out waiting for a durable restart state."); return; }
            var runId = S(Value(state, "runId"));
            if (string.IsNullOrEmpty(restartProgressRunId)) { DateTime updated; if (DateTime.TryParse(S(Value(state, "updatedAt")), out updated) && updated.ToUniversalTime() < restartProgressStartedAt.AddSeconds(-2)) return; restartProgressRunId = runId; }
            if (!string.Equals(restartProgressRunId, runId, StringComparison.Ordinal)) return;
            var percentage = 0; int.TryParse(S(Value(state, "percentage")), out percentage); restartProgressBar.Value = Math.Max(0, Math.Min(100, percentage));
            var phase = S(Value(state, "phase")).Replace("_", " "); var message = S(Value(state, "message")); var stateName = S(Value(state, "state"));
            restartProgressSummary.Text = string.IsNullOrEmpty(phase) ? message : phase + " — " + message;
            restartProgressSummary.ForeColor = stateName == "failed" ? Color.Firebrick : stateName == "completed" ? Color.ForestGreen : Color.DarkGoldenrod;
            if (stateName == "completed") FinishRestartProgress(true, message);
            else if (stateName == "failed") FinishRestartProgress(false, string.IsNullOrEmpty(S(Value(state, "error"))) ? message : S(Value(state, "error")));
            else if ((DateTime.UtcNow - restartProgressStartedAt).TotalSeconds > 180) FinishRestartProgress(false, "Timed out waiting for the restart to complete.");
        }
        catch (Exception error) { if (restartProgressSummary != null) { restartProgressSummary.Text = "Restart progress read failed: " + error.Message; restartProgressSummary.ForeColor = Color.Firebrick; } }
        await Task.CompletedTask;
    }

    private void FinishRestartProgress(bool succeeded, string message)
    {
        restartProgressTimer.Stop(); restartInProgress = false; SetServiceControls();
        if (restartProgressSummary != null) { restartProgressSummary.Text = message; restartProgressSummary.ForeColor = succeeded ? Color.ForestGreen : Color.Firebrick; }
        summary.Text = succeeded ? "OptiLens Local restart completed." : "OptiLens Local restart failed: " + message; summary.ForeColor = succeeded ? Color.ForestGreen : Color.Firebrick;
        var ignored = RefreshAll();
    }
    private void ShowMonitorWindow()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void HideToTray()
    {
        if (!exitRequested)
        {
            Hide();
            ShowInTaskbar = false;
            Log("healthy startup hidden to tray");
        }
    }

    private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
    {
        if (!exitRequested && eventArgs.CloseReason == CloseReason.UserClosing)
        {
            eventArgs.Cancel = true;
            Hide();
            ShowInTaskbar = false;
            Log("hidden to tray");
        }
    }

    private async Task RefreshSource()
    {
        try
        {
            var health = Map(json.DeserializeObject(await Api("/api/health")));
            var source = Map(Value(health, "sourceDatabase"));
            sourceStatus.Text = "Direct MSSQL: " + S(Value(source, "state")); sourceStatus.ForeColor = ColorFor(S(Value(source, "state")));
            sourceParity.Text = "Mirror, PSQL, ODBC, and Access connections are retired.";
            sourceParity.ForeColor = Color.ForestGreen;
            sourceMessage.Text = S(Value(source, "detail"));
        }
        catch (Exception error) { sourceStatus.Text = "Source backend unavailable"; sourceStatus.ForeColor = Color.Firebrick; sourceMessage.Text = error.Message; }
    }

    private async Task RefreshSyncStatus()
    {
        try
        {
            var status = Map(json.DeserializeObject(await Api("/api/monitor/innovations-sync/status")));
            syncStatus.Text = "Sync: " + S(Value(status, "state")) + " — " + S(Value(status, "detail"));
            syncCredentials.Text = Convert.ToBoolean(Value(status, "credentialsConfigured")) ? "Credentials: persisted" : "Credentials: missing";
            syncStatus.ForeColor = ColorFor(S(Value(status, "state")));
        }
        catch (Exception error) { syncStatus.Text = "Sync status unavailable: " + error.Message; syncStatus.ForeColor = Color.Firebrick; }
    }

    private async Task RefreshRxAliasSyncStatus()
    {
        try
        {
            var status = Map(json.DeserializeObject(await Api("/api/monitor/rx-alias-sync/status")));
            rxAliasSyncMessage.Text = "RX aliases: " + S(Value(status, "state")) + " — " + S(Value(status, "detail"));
            rxAliasSyncMessage.ForeColor = ColorFor(S(Value(status, "state")));
            rxAliasSyncButton.Enabled = true;
        }
        catch (Exception error) { rxAliasSyncMessage.Text = "RX alias sync status unavailable: " + error.Message; rxAliasSyncMessage.ForeColor = Color.Firebrick; }
    }

    private async Task RefreshQboInvoiceSyncStatus()
    {
        try
        {
            var status = Map(json.DeserializeObject(await Api("/api/monitor/qbo-invoice-sync/status")));
            var state = S(Value(status, "state"));
            var row = new ListViewItem(S(Value(status, "name")));
            row.SubItems.Add(state.ToUpperInvariant());
            row.SubItems.Add(S(Value(status, "detail")));
            row.ForeColor = ColorFor(state);
            connections.Items.Add(row);
        }
        catch (Exception error)
        {
            var row = new ListViewItem("Innovations → QuickBooks invoices");
            row.SubItems.Add("ERROR");
            row.SubItems.Add("Status unavailable: " + error.Message);
            row.ForeColor = Color.Firebrick;
            connections.Items.Add(row);
        }
    }

    private void RefreshTlsStatus()
    {
        try
        {
            using (var store = new X509Store(StoreName.My, StoreLocation.LocalMachine))
            {
                store.Open(OpenFlags.ReadOnly);
                var root = store.Certificates.Cast<X509Certificate2>().FirstOrDefault(c => c.FriendlyName == "OptiLens Local Root CA");
                var leaf = store.Certificates.Cast<X509Certificate2>().FirstOrDefault(c => c.FriendlyName == "OptiLens HTTPS - optilens.cv.net");
                httpsStatus.Text = leaf == null ? "HTTPS certificate: missing" : "HTTPS certificate: optilens.cv.net, expires " + leaf.NotAfter.ToShortDateString();
                httpsStatus.ForeColor = leaf == null || leaf.NotAfter < DateTime.Now.AddDays(30) ? Color.Firebrick : Color.ForestGreen;
                localCaStatus.Text = root == null ? "Local CA: missing" : "Local CA: present, expires " + root.NotAfter.ToShortDateString();
                localCaStatus.ForeColor = root == null ? Color.Firebrick : Color.ForestGreen;
            }
        }
        catch (Exception error) { httpsStatus.Text = "HTTPS status unavailable: " + error.Message; httpsStatus.ForeColor = Color.Firebrick; }
    }

    private async Task StartRxAliasSync()
    {
        try { rxAliasSyncButton.Enabled = false; await Api("/api/monitor/rx-alias-sync/run", "POST", new { }); rxAliasSyncMessage.Text = "RX alias sync started."; }
        catch (Exception error) { rxAliasSyncMessage.Text = "RX alias sync failed to start: " + error.Message; rxAliasSyncMessage.ForeColor = Color.Firebrick; }
        await RefreshRxAliasSyncStatus();
    }

    private async Task RunSelfTest()
    {
        try { resultBox.Text = json.Serialize(json.DeserializeObject(await Api("/api/monitor/innovations-sync/selftest", "POST", new { account = accountBox.Text }))); }
        catch (Exception error) { resultBox.Text = "Self-test failed: " + error.Message; }
    }

    private async Task RunSync(bool commit)
    {
        var entities = entityChecks.Values.Where(c => c.Checked).Select(c => S(c.Tag)).ToArray();
        if (entities.Length == 0) { resultBox.Text = "Select at least one entity."; return; }
        if (commit && MessageBox.Show("Write the selected Innovations data to Classic Visions now?", "Confirm sync", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        try { resultBox.Text = json.Serialize(json.DeserializeObject(await Api("/api/monitor/innovations-sync/run", "POST", new { commit = commit, entities = entities, suppressStatementEmails = suppressEmails.Checked }))); await RefreshSyncStatus(); await RefreshLogs(); }
        catch (Exception error) { resultBox.Text = "Sync failed: " + error.Message; }
    }

    private async Task RefreshLogs()
    {
        try { logsBox.Text = json.Serialize(json.DeserializeObject(await Api("/api/monitor/innovations-sync/logs?limit=80"))); }
        catch (Exception error) { logsBox.Text = "Logs unavailable: " + error.Message; }
    }

    private void RunHostScript(string name, bool intentionalStop = false, string extraArguments = "")
    {
        try
        {
            var script = Path.Combine(projectRoot, "scripts", name);
            if (!File.Exists(script)) return;
            var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            var args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\" -ProjectRoot \"" + projectRoot + "\" -Port " + port + (intentionalStop ? " -Intentional" : "") + " " + extraArguments;
            Process.Start(new ProcessStartInfo(powershell, args) { WorkingDirectory = projectRoot, CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
        }
        catch (Exception error)
        {
            Log("failed to launch script " + name + ": " + error.Message);
        }
    }

    private static Color ColorFor(string state) { return state == "online" || state == "enabled" || state == "ready-for-import" ? Color.ForestGreen : state == "warning" || state == "credentials-needed" || state == "setup-needed" || state == "discovered" ? Color.DarkGoldenrod : Color.Firebrick; }

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(monitorLog));
            File.AppendAllText(monitorLog, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        try
        {
            var root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var port = 8080;
            var trayMode = false;
            for (var i = 0; i < args.Length - 1; i++) if (args[i] == "--port") int.TryParse(args[i + 1], out port);
            trayMode = args.Any(arg => arg == "--tray" || arg == "--background");
            Log("Main starting port " + port + " root " + root);
            using (var showSignal = CreateShowSignal())
            using (var mutex = new System.Threading.Mutex(false, "Global\\OptiLensLocalHostTray"))
            {
                bool hasHandle = false;
                try
                {
                    hasHandle = mutex.WaitOne(0, false);
                }
                catch (System.Threading.AbandonedMutexException)
                {
                    hasHandle = true;
                    Log("recovered abandoned mutex from previous monitor instance");
                }

                if (!hasHandle)
                {
                    try { showSignal.Set(); } catch { }
                    Log("another instance is running; requested it open the monitor");
                    return;
                }
                try
                {
                    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                    Application.ThreadException += (sender, e) => Log("UI thread exception: " + e.Exception);
                    AppDomain.CurrentDomain.UnhandledException += (sender, e) => Log("AppDomain unhandled exception: " + e.ExceptionObject);

                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Log("starting Application.Run");
                    Application.Run(new OptiLensHostMonitor(root, port, showSignal, !trayMode));
                    Log("Application.Run ended normally");
                }
                finally
                {
                    try { mutex.ReleaseMutex(); } catch { }
                }
            }
        }
        catch (Exception error)
        {
            Log("fatal " + error);
            throw;
        }
    }

    private static System.Threading.EventWaitHandle CreateShowSignal()
    {
        try { return new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "Global\\OptiLensLocalHostMonitorShow"); }
        catch (UnauthorizedAccessException)
        {
            Log("Global show signal unavailable; using session-local signal");
            return new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "OptiLensLocalHostMonitorShow");
        }
    }
}
