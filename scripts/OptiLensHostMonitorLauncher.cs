using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
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
    private readonly Button startServiceButton = new Button { Text = "Start service", Width = 100 };
    private readonly Button restartServiceButton = new Button { Text = "Restart service", Width = 110 };
    private readonly Button stopServiceButton = new Button { Text = "Shut down service", Width = 120 };
    private readonly ListView connections = new ListView();
    private readonly Label sourceStatus = new Label();
    private readonly Label sourceParity = new Label();
    private readonly Label sourceMessage = new Label();
    private readonly Button liveButton = new Button { Text = "Use live MSSQL", Width = 120 };
    private readonly Button mirrorButton = new Button { Text = "Use mirror", Width = 100 };
    private readonly Button mirrorSyncButton = new Button { Text = "Sync mirror now", Width = 120 };
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
    private string forcedSource = "";
    private bool serviceOnline;
    private bool exitRequested;
    private bool firstRefresh = true;

    public OptiLensHostMonitor(string root, int requestedPort, System.Threading.EventWaitHandle signal)
    {
        projectRoot = root;
        port = requestedPort;
        showSignal = signal;
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

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open monitor", null, delegate { ShowMonitorWindow(); });
        menu.Items.Add("Open OptiLens Local", null, delegate { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/") { UseShellExecute = true }); });
        menu.Items.Add("Start OptiLens Local", null, delegate { RunHostScript("start-app.ps1"); });
        menu.Items.Add("Restart OptiLens Local", null, delegate { RunHostScript("restart-app.ps1"); });
        menu.Items.Add("Shut down OptiLens Local", null, delegate { RunHostScript("stop-app.ps1", true); });
        menu.Items.Add("Check for pushed updates", null, async delegate { await CheckUpdates(); });
        menu.Items.Add("Exit monitor", null, delegate { exitRequested = true; Close(); });
        tray = new NotifyIcon { Icon = Icon, Text = "OptiLens Local Host Monitor", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { ShowMonitorWindow(); };

        timer.Tick += async delegate { await RefreshAll(); };
        activationTimer.Tick += delegate { try { if (showSignal.WaitOne(0)) ShowMonitorWindow(); } catch { } };
        Shown += async delegate { await RefreshAll(); await RefreshLogs(); };
        FormClosing += OnFormClosing;
        FormClosed += delegate { Log("closed"); timer.Stop(); tray.Visible = false; tray.Dispose(); http.Dispose(); };
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
        service.Controls.Add(checkUpdatesButton); service.Controls.Add(applyUpdatesButton);
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
        source.Controls.Add(liveButton); source.Controls.Add(mirrorButton); source.Controls.Add(mirrorSyncButton);
        sourceMessage.AutoSize = true; source.Controls.Add(sourceMessage);
        liveButton.Click += async delegate { await SwitchSource("live"); };
        mirrorButton.Click += async delegate { await SwitchSource("mirror"); };
        mirrorSyncButton.Click += async delegate { await StartMirrorSync(); };
        checkUpdatesButton.Click += async delegate { await CheckUpdates(); };
        applyUpdatesButton.Click += async delegate { await ApplyUpdates(); };
        startServiceButton.Click += delegate { RunHostScript("start-app.ps1"); };
        restartServiceButton.Click += delegate { RunHostScript("restart-app.ps1"); };
        stopServiceButton.Click += delegate { RunHostScript("stop-app.ps1", true); };
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
            startServiceButton.Enabled = !serviceOnline;
            restartServiceButton.Enabled = serviceOnline;
            stopServiceButton.Enabled = serviceOnline;
            connections.Items.Clear();
            var hasFailure = false;
            var hasWarning = false;
            foreach (var key in new[] { "appDatabase", "sourceDatabase", "psqlDatabase", "mirrorDatabase", "innovationsSync" })
            {
                var item = Map(Value(health, key)); if (item == null) continue;
                var state = S(Value(item, "state"));
                if (state == "error" || state == "offline" || state == "failed") hasFailure = true;
                else if (state != "online" && state != "enabled" && state != "ready-for-import") hasWarning = true;
                var row = new ListViewItem(S(Value(item, "name"))); row.SubItems.Add(state.ToUpperInvariant()); row.SubItems.Add(S(Value(item, "detail")));
                row.ForeColor = ColorFor(state); connections.Items.Add(row);
            }
            var overall = hasFailure ? "Needs attention" : hasWarning ? "Working with warnings" : "All connections healthy";
            summary.Text = overall + " — hosted service is responding.";
            summary.ForeColor = hasFailure ? Color.Firebrick : hasWarning ? Color.DarkGoldenrod : Color.ForestGreen;
            tray.Icon = hasFailure ? SystemIcons.Error : hasWarning ? SystemIcons.Warning : SystemIcons.Information;
            tray.Text = "OptiLens Local: " + overall;
            await RefreshSource();
            await RefreshSyncStatus();
            if (firstRefresh && !hasFailure && !hasWarning)
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
            startServiceButton.Enabled = true; restartServiceButton.Enabled = false; stopServiceButton.Enabled = false;
            RunHostScript("ensure-app-running.ps1");
        }
    }

    private async Task CheckUpdates()
    {
        try
        {
            var status = Map(json.DeserializeObject(await Api("/api/monitor/updates")));
            var available = Convert.ToBoolean(Value(status, "available"));
            var areas = Value(status, "changedAreas") as object[];
            updateStatus.Text = available ? "Updates ready: " + (areas == null ? "pushed changes" : areas.Length + " area(s)") : "Updates: up to date";
            updateStatus.ForeColor = available ? Color.DarkGoldenrod : Color.ForestGreen;
            applyUpdatesButton.Enabled = available && Convert.ToBoolean(Value(Value(status, "plan") as IDictionary<string, object>, "restartService"));
        }
        catch (Exception error) { updateStatus.Text = "Update check failed: " + error.Message; updateStatus.ForeColor = Color.Firebrick; applyUpdatesButton.Enabled = false; }
    }

    private async Task ApplyUpdates()
    {
        if (MessageBox.Show("Apply the pushed OptiLens Local update and restart the service?", "Confirm update", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        applyUpdatesButton.Enabled = false;
        try { var result = Map(json.DeserializeObject(await Api("/api/monitor/updates/apply", "POST"))); updateStatus.Text = S(Value(result, "message")); updateStatus.ForeColor = Color.DarkGoldenrod; }
        catch (Exception error) { updateStatus.Text = "Update failed: " + error.Message; updateStatus.ForeColor = Color.Firebrick; }
        await Task.Delay(1000); await RefreshAll();
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
            var status = Map(json.DeserializeObject(await Api("/api/monitor/source-backend")));
            sourceStatus.Text = "Active: " + S(Value(status, "active")); sourceStatus.ForeColor = Color.ForestGreen;
            var parity = Value(status, "parity") as object[];
            sourceParity.Text = parity != null && parity.Length > 0 ? "Parity warning: " + string.Join("; ", parity.Select(S)) : "Live and mirror are within parity tolerance.";
            sourceParity.ForeColor = parity != null && parity.Length > 0 ? Color.DarkGoldenrod : Color.ForestGreen;
            liveButton.Enabled = S(Value(status, "active")) != "live"; mirrorButton.Enabled = S(Value(status, "active")) != "mirror";
            sourceMessage.Text = "Source controls are connected to OptiLens Local.";
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

    private async Task SwitchSource(string target)
    {
        if (forcedSource != target && sourceParity.Text.StartsWith("Parity warning", StringComparison.OrdinalIgnoreCase)) { forcedSource = target; sourceMessage.Text = "Parity warning detected. Click again to force the switch."; return; }
        try { await Api("/api/monitor/source-backend/switch", "POST", new { target = target, force = forcedSource == target }); forcedSource = ""; sourceMessage.Text = "Source switched to " + target + "."; await RefreshAll(); }
        catch (Exception error) { sourceMessage.Text = error.Message; }
    }

    private async Task StartMirrorSync()
    {
        try { mirrorSyncButton.Enabled = false; await Api("/api/monitor/zen-mirror/sync", "POST", new { full = false }); sourceMessage.Text = "Mirror sync started."; }
        catch (Exception error) { sourceMessage.Text = error.Message; }
        mirrorSyncButton.Enabled = true;
        await RefreshSource();
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

    private void RunHostScript(string name, bool intentionalStop = false)
    {
        var script = Path.Combine(projectRoot, "scripts", name);
        if (!File.Exists(script)) return;
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\" -ProjectRoot \"" + projectRoot + "\" -Port " + port + (intentionalStop ? " -Intentional" : "");
        Process.Start(new ProcessStartInfo(powershell, args) { WorkingDirectory = projectRoot, CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
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
            for (var i = 0; i < args.Length - 1; i++) if (args[i] == "--port") int.TryParse(args[i + 1], out port);
            using (var showSignal = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "Global\\OptiLensLocalHostMonitorShow"))
            using (var mutex = new System.Threading.Mutex(false, "Global\\OptiLensLocalHostTray"))
            {
                if (!mutex.WaitOne(0, false))
                {
                    try { showSignal.Set(); } catch { }
                    Log("another instance is running; requested it open the monitor");
                    return;
                }
                try
                {
                    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new OptiLensHostMonitor(root, port, showSignal));
                }
                finally
                {
                    mutex.ReleaseMutex();
                }
            }
        }
        catch (Exception error)
        {
            Log("fatal " + error);
            throw;
        }
    }
}
