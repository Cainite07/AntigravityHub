using System.Text.Json;
using AntigravityHub;
using Microsoft.Data.Sqlite;

internal static class ActivityTests
{
    public static async Task<List<string>> Run()
    {
        var passed = new List<string>();
        void Check(bool ok, string name) { if (!ok) throw new Exception(name); passed.Add("Activity gate: " + name); }
        string previous = HubStorage.HubDir;
        HubStorage.HubDir = Path.Combine(AppContext.BaseDirectory, "activity-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        try
        {
            string path = Path.Combine(HubStorage.HubDir, "summaries.db");
            Check(IdeActivity.ReadDatabase(path).State == IdeActivityState.Unknown && !File.Exists(path), "Missing database requires confirmation and is never created");
            using var connection = new SqliteConnection($"Data Source={path};Pooling=False"); connection.Open();
            void Sql(string sql) { using var c = connection.CreateCommand(); c.CommandText = sql; c.ExecuteNonQuery(); }
            Sql("CREATE TABLE conversation_summaries(conversation_id TEXT,status TEXT,not_fully_idle INTEGER,killed INTEGER); INSERT INTO conversation_summaries VALUES('a','CASCADE_RUN_STATUS_IDLE',0,0)");
            Check(IdeActivity.ReadDatabase(path).State == IdeActivityState.Idle, "Known idle client task state proceeds without a prompt");
            Sql("INSERT INTO conversation_summaries VALUES('b','CASCADE_RUN_STATUS_RUNNING',1,0)");
            var busy = IdeActivity.ReadDatabase(path);
            Check(busy.State == IdeActivityState.Busy && busy.TaskCount == 1, "Running task status is detected");
            Sql("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE' WHERE conversation_id='b'");
            Check(IdeActivity.ReadDatabase(path).State == IdeActivityState.Busy, "Waiting/non-idle task still requires confirmation");
            Sql("UPDATE conversation_summaries SET killed=1 WHERE conversation_id='b'");
            Check(IdeActivity.ReadDatabase(path).State == IdeActivityState.Idle, "Killed historical task is excluded");
            Sql("UPDATE conversation_summaries SET status='FUTURE_STATUS' WHERE conversation_id='a'");
            Check(IdeActivity.ReadDatabase(path).State == IdeActivityState.Unknown, "Unrecognized task state cannot masquerade as idle");
            Sql("DROP TABLE conversation_summaries");
            Check(IdeActivity.ReadDatabase(path).State == IdeActivityState.Unknown, "Changed schema conservatively requires confirmation");
            connection.Close();

            var credentials = new FakeCredentials { Value = "old-keyring" };
            string disk = Path.Combine(HubStorage.HubDir, "fake-creds.json"); File.WriteAllText(disk, "old-disk");
            var state = busy; int restarted = 0, reads = 0; bool oldClientRunning = true;
            Func<IdeActivity>? readOverride = null;
            Func<Task>? restartOverride = null;
            var service = new AccountService(credentials, disk, _ => oldClientRunning, async _ => { restarted++; await (restartOverride?.Invoke() ?? Task.CompletedTask); oldClientRunning = false; },
                _ => { reads++; return Task.FromResult(readOverride?.Invoke() ?? state); });
            string fixture = Path.Combine(HubStorage.HubDir, "import.json");
            File.WriteAllText(fixture, JsonSerializer.Serialize(new { id = "fixture", email = "fixture@example.invalid", token = new {
                access_token = "fake-access", refresh_token = "fake-refresh", expiry_timestamp = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds() } }));
            if (!(await service.ImportFromJsonFileAsync(fixture)).Success) throw new Exception("Fixture import failed");
            string index = File.ReadAllText(HubStorage.AccountsJson);
            bool Unchanged() => credentials.Value == "old-keyring" && File.ReadAllText(disk) == "old-disk" && File.ReadAllText(HubStorage.AccountsJson) == index && restarted == 0;
            Check((await service.SwitchAccountAsync("fixture", _ => Task.FromResult(false))).Cancelled && Unchanged(), "Cancel leaves keyring, disk, account index and running client untouched");
            Check((await service.SwitchAccountAsync("fixture")).Cancelled && Unchanged(), "Busy switch cannot bypass confirmation by omitting the callback");
            state = IdeActivity.Unknown;
            Check((await service.SwitchAccountAsync("fixture", _ => Task.FromResult(false))).Cancelled && Unchanged(), "Unknown state also preserves all state on cancellation");
            state = busy;
            var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var pending = service.SwitchAccountAsync("fixture", _ => { entered.SetResult(); return gate.Task; });
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Check((await Task.Run(service.GetAccounts).WaitAsync(TimeSpan.FromSeconds(2))).Count == 1, "Account refresh remains responsive while confirmation is open");
            Check(!(await service.SwitchAccountAsync("fixture", _ => Task.FromResult(true))).Success && Unchanged(), "Concurrent switch cannot bypass an outstanding confirmation");
            gate.SetResult(false); Check((await pending).Cancelled && Unchanged(), "Outstanding confirmation cancels cleanly");
            reads = 0; readOverride = () => reads == 1 ? IdeActivity.Idle : busy;
            Check((await service.SwitchAccountAsync("fixture")).Cancelled && Unchanged(), "New task appearing before commit blocks a previously idle switch");
            readOverride = null;
            var changed = await service.SwitchAccountAsync("fixture", _ => { state = busy with { Fingerprint = "new-task" }; return Task.FromResult(true); });
            Check(changed.Cancelled && Unchanged(), "A task appearing after approval requires a fresh confirmation");
            using var cancellation = new CancellationTokenSource();
            var waiting = service.SwitchAccountAsync("fixture", _ => { cancellation.Cancel(); return new TaskCompletionSource<bool>().Task; }, cancellation.Token);
            Check((await waiting.WaitAsync(TimeSpan.FromSeconds(2))).Cancelled && Unchanged(), "Shutdown cancels a pending confirmation without writing credentials");
            state = busy;
            var restartEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var restartDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            restartOverride = () => { restartEntered.SetResult(); return restartDone.Task; };
            var switching = service.SwitchAccountAsync("fixture", _ => Task.FromResult(true));
            await restartEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Check((await Task.Run(service.GetAccounts).WaitAsync(TimeSpan.FromSeconds(2))).Single().IsCurrent, "Committed account can be refreshed while the client is restarting");
            Check(!(await service.SwitchAccountAsync("fixture", _ => Task.FromResult(true))).Success && restarted == 1, "Another switch remains blocked until restart finishes");
            restartDone.SetResult();
            var success = await switching;
            Check(success.Success && success.IdeRestarted && restarted == 1 && credentials.Value != "old-keyring", "Explicit busy-task approval commits once and restarts once");
        }
        finally { HubStorage.HubDir = previous; }
        return passed;
    }
    private sealed class FakeCredentials : ICredentialStore
    {
        public string? Value;
        public string? Read() => Value;
        public bool Write(string value) { Value = value; return true; }
        public bool Delete() { Value = null; return true; }
    }
}
