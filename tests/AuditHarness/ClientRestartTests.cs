using AntigravityHub;

internal static class ClientRestartTests
{
    private sealed class Host : IClientRestartHost
    {
        public bool Exists { get; set; } = true;
        public bool Running;
        public bool ExitOnRequest;
        public bool Closed;
        public int Launches;
        public bool FailLaunch;
        public void RequestClose() { Closed = true; if (ExitOnRequest) Running = false; }
        public bool IsRunning => Running;
        public Task LaunchAsync(CancellationToken cancellation)
        {
            if (Running) throw new Exception("Launched while client still running");
            cancellation.ThrowIfCancellationRequested();
            Launches++;
            if (FailLaunch) throw new IOException("Launch failure");
            return Task.CompletedTask;
        }
    }
    public static async Task Run()
    {
        var idle = new Host();
        await ClientRestartService.RestartAsync(idle,CancellationToken.None);
        if (idle.Launches != 1) throw new Exception("Closed client was not launched exactly once");
        var normal = new Host {Running=true,ExitOnRequest=true};
        await ClientRestartService.RestartAsync(normal,CancellationToken.None);
        if (!normal.Closed || normal.Launches != 1) throw new Exception("Normal restart did not request close before launch");
        var blocked = new Host {Running=true};
        try { await ClientRestartService.RestartAsync(blocked,CancellationToken.None,TimeSpan.Zero); throw new Exception("Blocked close was bypassed"); }
        catch(IOException) { }
        if (!blocked.Running || blocked.Launches != 0) throw new Exception("Unsaved or cancelled client was interrupted");
        var absent = new Host {Exists=false};
        try { await ClientRestartService.RestartAsync(absent,CancellationToken.None); throw new Exception("Missing installation accepted"); }
        catch(IOException) { }
        if (absent.Closed || absent.Launches != 0) throw new Exception("Missing client modified process state");
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        var stopped = new Host();
        try { await ClientRestartService.RestartAsync(stopped,cancelled.Token); throw new Exception("Cancelled restart launched"); }
        catch(OperationCanceledException) { }
        if (stopped.Closed || stopped.Launches != 0) throw new Exception("Cancelled restart affected client");
        var fixture = Path.Combine(Path.GetTempPath(), "hub-quit-csharp-" + Guid.NewGuid());
        Directory.CreateDirectory(fixture);
        try
        {
            var executable = Environment.ProcessPath!;
            var ready = Path.Combine(fixture,"ready-42.json");
            if (ClientQuitChannel.TryRequest(42, executable, fixture)) throw new Exception("Missing capability accepted");
            File.WriteAllText(ready,System.Text.Json.JsonSerializer.Serialize(new {pid=42,nonce=new string('a',64),executable}));
            if (ClientQuitChannel.TryRequest(42, executable+".other", fixture)) throw new Exception("Wrong installation accepted");
            if (!ClientQuitChannel.TryRequest(42, executable, fixture)) throw new Exception("Verified quit capability rejected");
            using var request = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(fixture,"request-42.json")));
            if (request.RootElement.GetProperty("action").GetString() != "quit") throw new Exception("Wrong quit command");
        }
        finally { foreach(var file in Directory.GetFiles(fixture)) File.Delete(file); Directory.Delete(fixture); }
        var failed = new Host {FailLaunch=true};
        try { await ClientRestartService.RestartAsync(failed,CancellationToken.None); throw new Exception("Launch failure lost"); }
        catch(IOException) { }
        Console.WriteLine("PASS: six restart scenarios: closed, normal exit, blocked exit, absent, cancelled, launch failure.");
    }
}
