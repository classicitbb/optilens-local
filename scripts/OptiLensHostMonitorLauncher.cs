using System;
using System.Diagnostics;
using System.IO;

internal static class OptiLensHostMonitorLauncher
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        var projectRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var script = Path.Combine(projectRoot, "scripts", "optilens-host-tray.ps1");
        var port = "8080";
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "--port", StringComparison.OrdinalIgnoreCase)) port = args[i + 1];
        }

        if (!File.Exists(script)) return 2;

        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var info = new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -STA -File " + Quote(script)
                + " -ProjectRoot " + Quote(projectRoot) + " -Port " + Quote(port)
                + " -HealthUrl " + Quote("http://127.0.0.1:" + port + "/api/health"),
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        Process.Start(info);
        return 0;
    }
}
