using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;

namespace AntigravityHub;

internal interface IClientRestartHost
{
    bool Exists { get; }
    void RequestClose();
    bool IsRunning { get; }
    Task LaunchAsync(CancellationToken cancellation);
}

internal static class ClientRestartService
{
    public static async Task RestartAsync(IClientRestartHost host, CancellationToken cancellation,
        TimeSpan? waitLimit = null, TimeSpan? pollInterval = null)
    {
        if (!host.Exists) throw new IOException("没有找到 Antigravity 客户端");
        cancellation.ThrowIfCancellationRequested();
        host.RequestClose();
        var watch = Stopwatch.StartNew();
        while (host.IsRunning)
        {
            cancellation.ThrowIfCancellationRequested();
            if (watch.Elapsed >= (waitLimit ?? TimeSpan.FromSeconds(40)))
                throw new IOException("Antigravity 尚未退出，请先处理客户端的保存或退出提示，再重试");
            await Task.Delay(pollInterval ?? TimeSpan.FromMilliseconds(300), cancellation);
        }
        cancellation.ThrowIfCancellationRequested();
        await host.LaunchAsync(cancellation);
    }
}

internal sealed class WindowsClientRestartHost(string executable, Func<CancellationToken, Task> launch) : IClientRestartHost, IDisposable
{
    private readonly System.Collections.Generic.List<Process> originals = new();
    public bool Exists => File.Exists(executable);
    public void RequestClose()
    {
        foreach (var old in originals) old.Dispose();
        originals.Clear();
        foreach (var process in Process.GetProcessesByName("Antigravity"))
        {
            if (Matches(process)) { _ = process.Handle; originals.Add(process); }
            else process.Dispose();
        }
        foreach (var process in originals)
            if (ClientQuitChannel.TryRequest(process.Id, executable)) return;
        if (originals.Count > 0)
            throw new IOException("客户端增强组件需要更新，请先正常退出 Antigravity，再重新打开 Hub");
    }
    public bool IsRunning
    {
        get
        {
            bool running = false;
            // Retain process handles: a later process with the same name/PID
            // is a new instance, not an old process still refusing to exit.
            foreach (var process in originals) running |= !process.HasExited;
            return running;
        }
    }
    private bool AnyClientRunning()
    {
        bool running = false;
        foreach (var process in Process.GetProcessesByName("Antigravity"))
        {
            using (process)
            {
                running |= Matches(process);
            }
        }
        return running;
    }
    public async Task LaunchAsync(CancellationToken cancellation)
    {
        try
        {
            if (AnyClientRunning()) throw new IOException("Antigravity 已由其他操作重新启动，请正常退出后重试，以便应用设置");
            await launch(cancellation);
            var watch = Stopwatch.StartNew();
            while (!HasVisibleWindow())
            {
                if (watch.Elapsed > TimeSpan.FromSeconds(30)) throw new IOException("Antigravity 已启动，但窗口尚未就绪，请从托盘打开客户端");
                await Task.Delay(300, cancellation);
            }
        }
        finally { foreach (var process in originals) process.Dispose(); originals.Clear(); }
    }
    private bool Matches(Process process)
    {
        try { return !process.HasExited && string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase); }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { throw new IOException("无法确认 Antigravity 的退出状态，请手动重启客户端"); }
    }
    public void Dispose() { foreach (var process in originals) process.Dispose(); originals.Clear(); }
    private bool HasVisibleWindow()
    {
        foreach (var process in Process.GetProcessesByName("Antigravity"))
            using (process)
                if (Matches(process) && process.MainWindowHandle != IntPtr.Zero && IsWindowVisible(process.MainWindowHandle)) return true;
        return false;
    }
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);
}

internal static class ClientQuitChannel
{
    public static bool TryRequest(int pid, string executable, string? directory = null)
    {
        directory ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".antigravity_hub", "client_control");
        var ready = Path.Combine(directory, $"ready-{pid}.json");
        try
        {
            var info = new FileInfo(ready);
            if (!info.Exists || info.Length > 4096 || info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            using var json = JsonDocument.Parse(File.ReadAllText(ready));
            var value = json.RootElement;
            var nonce = value.GetProperty("nonce").GetString();
            if (value.GetProperty("pid").GetInt32() != pid || nonce?.Length != 64 ||
                !string.Equals(Path.GetFullPath(value.GetProperty("executable").GetString()!), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase)) return false;
            var request = Path.Combine(directory, $"request-{pid}.json");
            var stage = request + ".tmp";
            File.WriteAllText(stage, JsonSerializer.Serialize(new {pid, nonce, action="quit", id=Guid.NewGuid().ToString(), issuedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}));
            File.Move(stage, request, true);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException or System.Collections.Generic.KeyNotFoundException) { return false; }
    }
}
