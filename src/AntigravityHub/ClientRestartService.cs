using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

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

internal sealed class WindowsClientRestartHost(string executable, Func<CancellationToken, Task> launch) : IClientRestartHost
{
    public bool Exists => File.Exists(executable);
    public void RequestClose()
    {
        foreach (var process in Process.GetProcessesByName("Antigravity"))
        {
            using (process)
            {
                if (!Matches(process)) continue;
                try { if (process.MainWindowHandle != IntPtr.Zero) process.CloseMainWindow(); }
                catch (InvalidOperationException) { /* Exited between discovery and close request. */ }
            }
        }
    }
    public bool IsRunning
    {
        get
        {
            bool running = false;
            foreach (var process in Process.GetProcessesByName("Antigravity"))
                using (process) { running |= Matches(process); }
            return running;
        }
    }
    private bool Matches(Process process)
    {
        try { return !process.HasExited && string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase); }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { throw new IOException("无法确认 Antigravity 的退出状态，请手动重启客户端"); }
    }
    public Task LaunchAsync(CancellationToken cancellation) => launch(cancellation);
}
