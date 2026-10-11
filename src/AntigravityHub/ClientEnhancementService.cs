using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AntigravityHub;

internal static class ClientEnhancementService
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static string Tools => Path.Combine(AppContext.BaseDirectory, "client", "maintenance", "tools");
    private static string ClientRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "antigravity");
    private static string Runtime => Path.Combine(AppContext.BaseDirectory, "client", "runtime");

    public static async Task<string> EnsureReadyAsync()
    {
        var status = await RunAsync(false);
        if (status == "已就绪。" || !status.StartsWith("需要安装", StringComparison.Ordinal)) return status;
        return await RunAsync(true);
    }

    public static async Task LaunchAsync(CancellationToken cancellation)
    {
        await Gate.WaitAsync(cancellation);
        try
        {
            cancellation.ThrowIfCancellationRequested();
            // The maintenance launch shares the deployment mutex with the waiting worker.
            // This completes any queued update before the client opens the archive.
            var output = await RunProcess(Path.Combine(Runtime,"python","python.exe"),
                new[] {Path.Combine(Tools,"maintain.py"), "--launch", "--root", ClientRoot, "--", "--hub-show-window"}, Tools);
            using var document = JsonDocument.Parse(output.Trim());
            if (!document.RootElement.TryGetProperty("status",out var state) || state.GetString() != "launched")
                throw new IOException("未能打开 Antigravity，请稍后重试");
        }
        finally { Gate.Release(); }
    }

    public static async Task<string> RunAsync(bool install)
    {
        await Gate.WaitAsync();
        try
        {
            if (!File.Exists(Path.Combine(ClientRoot, "resources", "app.asar")))
                return "没有找到 Antigravity 客户端，请先安装 Windows 版客户端。";
            if (!File.Exists(Path.Combine(Tools, "maintain.py")))
                return "客户端增强组件缺失，请使用完整发布包。";
            if (!Directory.Exists(Path.Combine(Tools, "node_modules", "@electron", "asar")) ||
                !File.Exists(Path.Combine(Runtime, "node", "node.exe")) ||
                !File.Exists(Path.Combine(Runtime, "python", "python.exe")))
                return "组件文件不完整，请使用完整发布包。";
            if (install)
                await RunProcess(Path.Combine(Runtime,"node","node.exe"), new[] {Path.Combine(Tools, "seed-base.cjs"), Path.Combine(ClientRoot,"resources","app.asar")}, Tools);
            var output = await RunProcess(Path.Combine(Runtime,"python","python.exe"), new[] {Path.Combine(Tools,"maintain.py"), install ? "--queue" : "--check", "--root", ClientRoot}, Tools);
            using var document = JsonDocument.Parse(output.Trim());
            var value = document.RootElement;
            if (!install)
            {
                var version = value.TryGetProperty("version", out var versionValue) ? versionValue.GetString() : null;
                if (version != "2.22.0") return "暂未适配 Antigravity " + (version ?? "当前版本") + "。";
                bool ready = value.TryGetProperty("unified", out var enabled) && enabled.GetBoolean();
                return ready ? "已就绪。" :
                    "需要安装或更新组件（2.22.0）。";
            }
            string status = value.TryGetProperty("status", out var state) ? state.GetString() ?? "" : "";
            return status switch
            {
                "installed" or "already-installed" or "already-installed-by-another-operation" => "已就绪。",
                "queued" or "already-queued" => "已准备好，等待 Antigravity 退出后安装。",
                "prepared-for-next-launch" => "已准备好，退出 Antigravity 后重新打开 Hub 即可完成。",
                _ => "组件未就绪，请重试。"
            };
        }
        catch (Exception error)
        {
            Logger.Log("Client components", error.ToString());
            return "客户端连接失败，重新打开 Hub 后会再试。";
        }
        finally { Gate.Release(); }
    }

    private static async Task<string> RunProcess(string file, string[] arguments, string workingDirectory)
    {
        var info = new ProcessStartInfo(file) { WorkingDirectory = workingDirectory, UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        // Per-user state survives application upgrades; no installation history is bundled.
        info.Environment["ANTIGRAVITY_MAINTENANCE_STATE"] = Path.Combine(HubStorage.HubDir,"client_maintenance");
        info.Environment["PYTHONUTF8"] = "1";
        // Workers inherit only the packaged runtimes; end users need no development tools.
        info.Environment["PATH"] = Path.Combine(Runtime,"node") + Path.PathSeparator +
            Path.Combine(Runtime,"python") + Path.PathSeparator + info.Environment["PATH"];
        using var process = Process.Start(info) ?? throw new IOException("无法启动客户端维护程序。");
        process.StandardInput.Close();
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(4));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { try { process.Kill(entireProcessTree: true); } catch { } throw new IOException("客户端维护超时，请稍后重试。"); }
        var output = await outputTask; var error = await errorTask;
        if (process.ExitCode != 0) throw new IOException((string.IsNullOrWhiteSpace(error) ? output : error).Trim());
        return output;
    }
}
