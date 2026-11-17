using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class OptiLensScheduledNode
{
    private static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        string log = args[0];
        try
        {
            var nodeArguments = new string[args.Length - 2];
            for (int i = 2; i < args.Length; i++)
            {
                if (args[i].Contains("\"") || args[i].EndsWith("\\")) throw new ArgumentException("Invalid Node argument.");
                nodeArguments[i - 2] = "\"" + args[i] + "\"";
            }
            Directory.CreateDirectory(Path.GetDirectoryName(log));
            using (var output = File.Open(log + ".out.log", FileMode.Append, FileAccess.Write, FileShare.Read))
            using (var errors = File.Open(log + ".err.log", FileMode.Append, FileAccess.Write, FileShare.Read))
            using (var child = Process.Start(new ProcessStartInfo(args[1], string.Join(" ", nodeArguments)) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            }))
            {
                Task.WaitAll(child.StandardOutput.BaseStream.CopyToAsync(output), child.StandardError.BaseStream.CopyToAsync(errors));
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            try { File.AppendAllText(log + ".err.log", DateTime.UtcNow.ToString("o") + " " + error + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return 1;
        }
    }
}

