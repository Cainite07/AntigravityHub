using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AntigravityHub;

internal static class ClientLaunchEntry
{
    private static string DirectoryPath => Path.Combine(HubStorage.HubDir, "client_maintenance");
    private static string Configuration => Path.Combine(DirectoryPath, "launcher.json");

    internal static void RefreshIfEnabled()
    {
        try
        {
            if (!File.Exists(Configuration)) return;
            using var document = JsonDocument.Parse(File.ReadAllText(Configuration));
            if (document.RootElement.TryGetProperty("manageShortcuts", out var enabled) && enabled.ValueKind == JsonValueKind.True) Enable();
        }
        catch (Exception error) { Logger.Log("Client entry", error.Message); }
    }

    internal static void Enable()
    {
        Directory.CreateDirectory(DirectoryPath);
        File.WriteAllText(Configuration, JsonSerializer.Serialize(new { hubRoot = AppContext.BaseDirectory, manageShortcuts = true }));
        string client = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "antigravity", "Antigravity.exe");
        string hub = Path.Combine(AppContext.BaseDirectory, "AntigravityHub.exe");
        foreach (string link in new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Antigravity.lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Antigravity.lnk") })
        {
            if (!File.Exists(link)) continue;
            object? shell = null, shortcut = null;
            try
            {
                shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!);
                shortcut = ((dynamic)shell!).CreateShortcut(link);
                dynamic entry = shortcut;
                if (string.Equals((string)entry.TargetPath, hub, StringComparison.OrdinalIgnoreCase) && (string)entry.Arguments == "--launch-client")
                {
                    if (((string)entry.IconLocation).Trim() == ",0") { entry.IconLocation = client + ",0"; entry.Save(); }
                    continue;
                }
                if (!string.Equals(Path.GetFullPath((string)entry.TargetPath), client, StringComparison.OrdinalIgnoreCase) ||
                    !string.IsNullOrWhiteSpace((string)entry.Arguments)) continue;
                string backup = Path.Combine(DirectoryPath, "shortcuts", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(link)))[..16] + ".lnk");
                System.IO.Directory.CreateDirectory(Path.GetDirectoryName(backup)!);
                if (!File.Exists(backup)) File.Copy(link, backup);
                if (string.IsNullOrEmpty((string)entry.IconLocation) || ((string)entry.IconLocation).Trim() == ",0") entry.IconLocation = client + ",0";
                entry.TargetPath = hub; entry.Arguments = "--launch-client"; entry.Save();
            }
            catch (Exception error) { Logger.Log("Client entry", error.Message); }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }
    }
}
