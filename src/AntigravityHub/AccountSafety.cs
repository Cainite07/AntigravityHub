using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Text.RegularExpressions;

namespace AntigravityHub
{
    internal interface ICredentialStore
    {
        string? Read();
        bool Write(string json);
        bool Delete();
    }
    internal sealed class WindowsCredentialStore : ICredentialStore
    {
        public string? Read() => CredentialManager.ReadCredential("gemini:antigravity");
        public bool Write(string json) => CredentialManager.WriteCredential("gemini:antigravity", "antigravity", json);
        public bool Delete() => CredentialManager.DeleteCredential("gemini:antigravity");
    }

    internal sealed class AccountSwitchRecovery
    {
        public string? Credential { get; set; }
        public string? DiskCredentials { get; set; }
        public string? AccountIndex { get; set; }
    }

    internal static class AccountSafety
    {
        public static string DetailPath(string directory, string id)
        {
            if (string.IsNullOrWhiteSpace(id) || !Regex.IsMatch(id, @"\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\z") ||
                Regex.IsMatch(id, @"\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\z", RegexOptions.IgnoreCase))
                throw new ArgumentException("账号 ID 无效，只允许字母、数字、下划线及连字符。");
            string root = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
            string result = Path.GetFullPath(Path.Combine(root, id + ".json"));
            if (!result.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("账号路径超出存储目录。");
            return result;
        }

        public static bool IsOwnedProcess(string? processPath, string installationDirectory)
        {
            if (string.IsNullOrWhiteSpace(processPath)) return false;
            try
            {
                string root = Path.GetFullPath(installationDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                return Path.GetFullPath(processPath).StartsWith(root, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        public static bool HasIdeProcessStartedBefore(string executable, DateTimeOffset cutoff)
        {
            foreach (var process in Process.GetProcessesByName("Antigravity"))
            {
                using (process)
                {
                    try
                    {
                        if (string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase) && process.StartTime.ToUniversalTime() <= cutoff.UtcDateTime) return true;
                    }
                    catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { }
                }
            }
            return false;
        }

        public static async Task RestartIdeAsync(string executable, System.Threading.CancellationToken cancellationToken = default)
        {
            if (!File.Exists(executable)) throw new FileNotFoundException("未找到 Antigravity 程序，账号已切换，请手动启动 IDE。", executable);
            string installation = Path.GetDirectoryName(executable)!;
            foreach (string name in new[] { "Antigravity", "language_server" })
            {
                foreach (var process in Process.GetProcessesByName(name))
                {
                    using (process)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        string? path;
                        try { path = process.MainModule?.FileName; }
                        catch { continue; } // Unknown ownership is never permission to terminate.
                        if (!IsOwnedProcess(path, installation)) continue;
                        if (name == "Antigravity" && process.CloseMainWindow())
                        {
                            if (await Task.Run(() => process.WaitForExit(3000))) continue;
                        }
                        cancellationToken.ThrowIfCancellationRequested();
                        process.Kill();
                        await Task.Run(() => process.WaitForExit(3000));
                    }
                }
            }
            cancellationToken.ThrowIfCancellationRequested();
            Process.Start(new ProcessStartInfo { FileName = executable, UseShellExecute = true });
        }
    }
}
