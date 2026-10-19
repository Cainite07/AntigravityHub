using System.Reflection;
using System.Text.Json;
using AntigravityHub;
using Microsoft.Data.Sqlite;

internal static class ReliabilityTests
{
    public static async Task Run()
    {
        var passed = new List<string>();
        void Check(bool value, string name) { if (!value) throw new Exception(name); passed.Add(name); }
        HubStorage.HubDir = Path.Combine(AppContext.BaseDirectory, "reliability-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        string gemini = Path.Combine(HubStorage.HubDir, "gemini");
        string conversations = Path.Combine(gemini, "antigravity", "conversations");
        Directory.CreateDirectory(conversations);
        string source = Path.Combine(conversations, "fixture.db");
        void Sql(string path, string sql)
        {
            using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
            connection.Open(); using var command = connection.CreateCommand(); command.CommandText = sql; command.ExecuteNonQuery();
        }
        Sql(source, "CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); INSERT INTO gen_metadata VALUES(0,X'0A0422021000');");
        File.WriteAllText(HubStorage.TokensJsonl, "");
        var tracker = new NativeTokenTracker();
        typeof(NativeTokenTracker).GetField("_geminiHome", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(tracker, gemini);
        var repository = new UsageRepository(UsageRepository.DefaultPath);
        long Total() => repository.ReadBuckets().Sum(s => JsonDocument.Parse(s).RootElement.GetProperty("total_tokens").GetInt64());
        Check(await tracker.ScanAndAggregateAsync() == 0 && Total() == 0, "Zero row establishes cursor without inventing usage");
        Sql(source, "UPDATE gen_metadata SET data=X'0A0422021064' WHERE idx=0;");
        Check(await tracker.ScanAndAggregateAsync(true) == 1 && Total() == 100, "Old zero row completed in place is collected");
        Check(await tracker.ScanAndAggregateAsync(true) == 0 && Total() == 100, "Forced and repeated scans are idempotent");
        Sql(UsageRepository.DefaultPath, "CREATE TRIGGER fail_cursor BEFORE INSERT ON cursors BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
        Sql(source, "UPDATE gen_metadata SET data=X'0A05220310C801' WHERE idx=0;");
        bool failed = false;
        try { await tracker.ScanAndAggregateAsync(true); } catch (SqliteException) { failed = true; }
        Check(failed && Total() == 100, "Cursor write failure rolls back event changes in the same transaction");
        Sql(UsageRepository.DefaultPath, "DROP TRIGGER fail_cursor;");
        Check(await tracker.ScanAndAggregateAsync(true) == 1 && Total() == 200, "Retry replaces event with 200 rather than adding 200");
        using (var child = new System.Diagnostics.Process())
        {
            child.StartInfo = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath!)
                { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardInput = true, RedirectStandardError = true, CreateNoWindow = true };
            child.StartInfo.ArgumentList.Add("--transaction-child"); child.StartInfo.ArgumentList.Add(UsageRepository.DefaultPath);
            child.Start();
            try
            {
                string? ready = await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
                if (ready != "READY") throw new Exception("Crash fixture did not start: " + await child.StandardError.ReadToEndAsync());
                child.Kill(); await child.WaitForExitAsync();
                Check(Total() == 200 && repository.LoadCursors().Databases.Count == 1, "Forced process termination rolls back both uncommitted events and cursors");
            }
            finally { if (!child.HasExited) child.Kill(); }
        }
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel(); failed = false;
            try { await tracker.ScanAndAggregateAsync(cancellationToken: cancelled.Token); } catch (OperationCanceledException) { failed = true; }
            Check(failed && Total() == 200, "Cancelled scan leaves committed totals intact");
        }
        var decoder = typeof(NativeTokenTracker).GetMethod("ExtractServerUsage", BindingFlags.NonPublic | BindingFlags.Static)!;
        Check(decoder.Invoke(null, new object[] { new byte[] { 10, 4, 34, 2, 16, 228 } }) == null, "Truncated varint is rejected");
        Check(decoder.Invoke(null, new object[] { new byte[] { 10, 4, 34, 8, 16, 100 } }) == null, "Out-of-bounds protobuf length is rejected");

        string legacy = Path.Combine(HubStorage.HubDir, "historical.jsonl");
        string hour = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:00:00.000Z");
        var bucket = new UsageBucket { model = "fixture-model", hour_start = hour, input_tokens = 500, total_tokens = 500, conversation_count = 5 };
        var archived = new UsageBucket { model = "deleted-session-model", hour_start = hour, input_tokens = 300, total_tokens = 300 };
        File.WriteAllLines(legacy, new[] { JsonSerializer.Serialize(bucket), JsonSerializer.Serialize(archived) });
        string original = File.ReadAllText(legacy);
        var migration = new UsageRepository(Path.Combine(HubStorage.HubDir, "migration.sqlite3"));
        var observed = new UsageBucket { model = "fixture-model", hour_start = hour, input_tokens = 100, total_tokens = 100, conversation_count = 1 };
        migration.Commit(new[] { new UsageEvent("source", 0, "first", observed) }, new CursorsState(), legacy);
        long MigratedTotal() => migration.ReadBuckets().Sum(s => JsonDocument.Parse(s).RootElement.GetProperty("total_tokens").GetInt64());
        Check(MigratedTotal() == 800 && File.ReadAllText(legacy) == original && Directory.GetFiles(Path.Combine(HubStorage.HubDir, "backups")).Length > 0,
            "Migration preserves matched residual, deleted-session history and original backup");
        observed.input_tokens = observed.total_tokens = 200;
        migration.Commit(new[] { new UsageEvent("source", 0, "second", observed) }, new CursorsState(), legacy);
        Check(MigratedTotal() == 900, "Migrated ledger counts only the revision delta above seeded history");
        var invalidMigration = new UsageRepository(Path.Combine(HubStorage.HubDir, "invalid-migration.sqlite3"));
        File.WriteAllText(legacy, "not json"); failed = false;
        try { invalidMigration.Commit(Array.Empty<UsageEvent>(), new CursorsState(), legacy); } catch (JsonException) { failed = true; }
        Check(failed && !invalidMigration.IsInitialized(), "Malformed history cannot silently complete migration");

        var credentials = new FakeCredentials { Value = "original-keyring" };
        string diskCredentials = Path.Combine(HubStorage.HubDir, "oauth-fixture.json");
        File.WriteAllText(diskCredentials, "original-disk");
        var accounts = new AccountService(credentials, diskCredentials, _ => false, _ => Task.CompletedTask,
            _ => Task.FromResult(IdeActivity.Idle));
        string imported = Path.Combine(HubStorage.HubDir, "import.json");
        async Task<OpResult> Import(string id, object token, string email = "fixture@example.invalid")
        {
            File.WriteAllText(imported, JsonSerializer.Serialize(new { id, email, token }));
            return await accounts.ImportFromJsonFileAsync(imported);
        }
        var token = new { access_token = "fixture-access", refresh_token = "fixture-refresh", expiry_timestamp = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds() };
        Check(!(await Import("../escape", token)).Success && !File.Exists(Path.Combine(HubStorage.HubDir, "escape.json")), "Traversal import is rejected");
        Check(!(await Import("safe-id", new { })).Success, "Empty token import is rejected");
        Check((await Import("safe-id", token)).Success && accounts.GetAccounts().Count == 1, "Valid fixture account is encrypted and indexed");
        Check(accounts.GetAccounts()[0].Gemini5hQuota == -1 && accounts.GetAccounts()[0].Tier == "", "Unknown quotas and subscription are not fabricated");
        Check((await Import("safe-id", token, "second@example.invalid")).Success && accounts.GetAccounts().Select(a => a.Id).Distinct().Count() == 2,
            "ID collisions cannot overwrite a different account");
        Check((await Import("SAFE-ID", token, "third@example.invalid")).Success && accounts.GetAccounts().Select(a => a.Id).Distinct(StringComparer.OrdinalIgnoreCase).Count() == 3 && accounts.GetAccounts().Single(a => a.Id == "safe-id").Email == "fixture@example.invalid",
            "Case-insensitive Windows file collisions cannot overwrite a different account");
        string indexBefore = File.ReadAllText(HubStorage.AccountsJson);
        credentials.FailNextWrite = true;
        var switched = await accounts.SwitchAccountAsync("safe-id");
        Check(!switched.Success && credentials.Value == "original-keyring" && File.ReadAllText(diskCredentials) == "original-disk" && File.ReadAllText(HubStorage.AccountsJson) == indexBefore,
            "Credential commit failure restores original account state");
        Check(!File.Exists(Path.Combine(HubStorage.HubDir, "switch_recovery.dat")), "Successful rollback removes recovery journal");
        Check((await accounts.SwitchAccountAsync("safe-id")).Success && accounts.GetAccounts().Single(a => a.IsCurrent).Id == "safe-id",
            "Valid switch commits fixture keyring, disk credentials and current index");
        Check(!(await accounts.DeleteAccountAsync("safe-id")).Success, "Active account cannot be deleted");
        Check(!(await accounts.SwitchAccountAsync("../../escape")).Success, "Switch paths are validated too");
        Check(!AccountSafety.IsOwnedProcess(null, @"C:\Programs\Antigravity") &&
            !AccountSafety.IsOwnedProcess(@"C:\Elsewhere\Antigravity\language_server.exe", @"C:\Programs\Antigravity") &&
            AccountSafety.IsOwnedProcess(@"C:\Programs\Antigravity\resources\language_server.exe", @"C:\Programs\Antigravity"),
            "Only verified installation paths qualify for process termination");
        var quotaParser = typeof(AccountService).GetMethod("ParseQuotaJsonElement", BindingFlags.NonPublic | BindingFlags.Static)!;
        bool ParseQuota(AccountItem item, string json) { using var doc = JsonDocument.Parse(json); return (bool)quotaParser.Invoke(null, new object[] { item, doc.RootElement })!; }
        var quotaAccount = new AccountItem();
        Check(!ParseQuota(quotaAccount, "{}") && quotaAccount.Gemini5hQuota == -1, "Unknown quota schema cannot be reported as full or successful");
        Check(!ParseQuota(quotaAccount, "{\"groups\":[{\"displayName\":\"Gemini\",\"buckets\":[{\"window\":\"5h\"}]}]}") && quotaAccount.Gemini5hQuota == -1,
            "Missing quota fraction stays unknown");
        const string validQuota = "{\"groups\":[{\"displayName\":\"Gemini\",\"buckets\":[{\"window\":\"5h\",\"remainingFraction\":0}]}]}";
        Check(ParseQuota(quotaAccount, validQuota) && quotaAccount.Gemini5hQuota == 0 && quotaAccount.GeminiWeeklyQuota == -1,
            "Real zero quota is preserved and missing windows remain unknown");
        const string argonQuota = """{"groups":[{"displayName":"Gemini","buckets":[{"window":"5h","remainingFraction":0.75},{"window":"weekly","remainingFraction":0.83}]},{"displayName":"Gemini 4 Argon","buckets":[{"window":"weekly","remainingFraction":0.96,"resetTime":"2026-10-29T12:00:00Z"}]}]}""";
        Check(ParseQuota(quotaAccount,argonQuota) && quotaAccount.GeminiWeeklyQuota==83 && quotaAccount.Gemini5hQuota==75 && quotaAccount.ArgonWeeklyQuota==96 && quotaAccount.Argon5hQuota==-1 && quotaAccount.ArgonResetTimeWeekly=="2026-10-29T12:00:00Z","Argon weekly quota is independent and never overwrites Gemini or fabricates a 5h limit");
        Check(ParseQuota(quotaAccount,"""{"groups":[{"display_name":"Gemini 4 Argon","buckets":[{"window":"weekly","remaining_fraction":0}]}]}""") && quotaAccount.ArgonWeeklyQuota==0 && quotaAccount.GeminiWeeklyQuota==-1,"Argon-only and zero quota responses retain unknown shared quotas");
        var updateToken = typeof(AccountService).GetMethod("UpdateAccountTokenInJson", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var saveQuota = typeof(AccountService).GetMethod("SaveQuotaToDetailJson", BindingFlags.NonPublic | BindingFlags.Instance)!;
        using (var quotaDoc = JsonDocument.Parse(validQuota))
            await Task.WhenAll(Enumerable.Range(0, 12).SelectMany(index => new[] {
                Task.Run(() => updateToken.Invoke(accounts, new object[] { "safe-id", "updated-" + index, 3600, "fixture-refresh" })),
                Task.Run(() => saveQuota.Invoke(accounts, new object[] { "safe-id", quotaDoc.RootElement, "fixture-refresh" })) }));
        var readDetail = typeof(AccountService).GetMethod("ReadDetailJson", BindingFlags.NonPublic | BindingFlags.Static)!;
        using (var detail = JsonDocument.Parse((string)readDetail.Invoke(null, new object[] { AccountSafety.DetailPath(HubStorage.AccountsDetailDir, "safe-id") })!))
            Check(detail.RootElement.GetProperty("token").GetProperty("access_token").GetString()!.StartsWith("updated-") && detail.RootElement.TryGetProperty("quota", out _),
                "Concurrent quota and token writes preserve both fields");
        string currentAccountFile = AccountSafety.DetailPath(HubStorage.AccountsDetailDir, "safe-id");
        string beforeStale = File.ReadAllText(currentAccountFile);
        updateToken.Invoke(accounts, new object[] { "safe-id", "stale", 3600, "different-refresh-token" });
        Check(File.ReadAllText(currentAccountFile) == beforeStale, "Stale token refresh cannot overwrite reimported credentials");
        Check(BrowserPolicy.IsTrustedDocument("https://app.local/index.html#accounts") && !BrowserPolicy.IsTrustedDocument("https://app.local.evil/index.html") &&
            !BrowserPolicy.IsTrustedDocument("https://app.local/other.html") && !BrowserPolicy.IsTrustedDocument("https://app.local:1234/index.html"),
            "Only the local app document qualifies for host messages");
        Check(BrowserPolicy.CanOpenExternal("https://accounts.google.com/o/oauth2/v2/auth?state=fixture") &&
            !BrowserPolicy.CanOpenExternal("file:///C:/Windows/System32/cmd.exe") && !BrowserPolicy.CanOpenExternal("https://accounts.google.com.evil/o/oauth2/v2/auth"),
            "External navigation is restricted to the Google authorization endpoint");
        var coordinator = new RefreshCoordinator();
        var releaseRefresh = new TaskCompletionSource<bool>();
        int calls = 0;
        async Task<RefreshOutcome> Operation() { Interlocked.Increment(ref calls); await releaseRefresh.Task; return new RefreshOutcome(false, "fixture failure"); }
        var firstRefresh = coordinator.RunAsync(Operation); var secondRefresh = coordinator.RunAsync(Operation);
        releaseRefresh.SetResult(true);
        Check(ReferenceEquals(firstRefresh, secondRefresh) && !(await secondRefresh).Success && calls == 1,
            "Concurrent refresh requests share the actual failure result");

        var indexField = typeof(AccountService).GetField("_accountsJsonPath", BindingFlags.NonPublic | BindingFlags.Instance)!;
        string blockedIndex = Path.Combine(HubStorage.HubDir, "blocked-index"); Directory.CreateDirectory(blockedIndex);
        byte[] detailBefore = File.ReadAllBytes(currentAccountFile);
        indexField.SetValue(accounts, blockedIndex);
        Check(!(await Import("safe-id", token)).Success && File.ReadAllBytes(currentAccountFile).SequenceEqual(detailBefore),
            "Index write failure rolls back the account detail write");
        indexField.SetValue(accounts, HubStorage.AccountsJson);
        string journal = Path.Combine(HubStorage.HubDir, "account_mutation_recovery.dat");
        var writeDetail = typeof(AccountService).GetMethod("WriteDetailJson", BindingFlags.NonPublic | BindingFlags.Static)!;
        string beforeIndex = File.ReadAllText(HubStorage.AccountsJson);
        writeDetail.Invoke(null, new object[] { journal, JsonSerializer.Serialize(new { Id = "safe-id", DetailBytes = Convert.ToBase64String(detailBefore), Index = beforeIndex }) });
        File.WriteAllText(currentAccountFile, "interrupted mutation"); File.WriteAllText(HubStorage.AccountsJson, "{\"accounts\":[]}");
        _ = new AccountService(credentials, diskCredentials);
        Check(File.ReadAllBytes(currentAccountFile).SequenceEqual(detailBefore) && File.ReadAllText(HubStorage.AccountsJson) == beforeIndex && !File.Exists(journal),
            "Startup recovers an interrupted account mutation from the encrypted journal");

        HubStorage.HubDir = Path.Combine(HubStorage.HubDir, "stats-fixture"); HubStorage.EnsureInitialized();
        File.WriteAllText(HubStorage.TokensJsonl, JsonSerializer.Serialize(new {
            model = "claude-sonnet-4-6", hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = 100,
            input_tokens = 0, cached_input_tokens = 0, cache_creation_input_tokens = 100, output_tokens = 0, reasoning_output_tokens = 0, conversation_count = 1 }));
        var statistics = new TokenStatsService(); var summary = statistics.GetStats();
        Check(summary.TodayCacheWriteTokens == 100 && Math.Abs(summary.TodayCostUsd - .000375) < 1e-12 && summary.DailyRecords[0].CacheWriteTokens == 100,
            "Cache writes appear in summary, daily breakdown and reference cost");
        File.WriteAllText(HubStorage.TokensJsonl, JsonSerializer.Serialize(new { model = "unknown-pro-flash", hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = 100, input_tokens = 100 }));
        summary = statistics.GetStats();
        Check(summary.TodayCostFormatted == "未定价" && summary.UnpricedTokens == 100 && summary.Models[0].PriceKnown == false,
            "Unknown model does not silently inherit Flash or Pro pricing");
        File.WriteAllText(HubStorage.TokensJsonl, "corrupt"); bool statsFailed = false;
        try { statistics.GetStats(); } catch (InvalidDataException) { statsFailed = true; }
        Check(statsFailed && statistics.GetCachedStats().TodayTokens == 100, "Failed stats read cannot replace last snapshot with zero");
        var settings = new SettingsService();
        var settingsCopy = settings.GetSettings(); settingsCopy.Currency = "USD";
        Check(settings.GetSettings().Currency == "CNY", "Settings snapshots cannot mutate shared state without saving");
        settingsCopy.PollIntervalSeconds = 1; settings.SaveSettings(settingsCopy);
        Check(settings.GetSettings().PollIntervalSeconds == 10 && new SettingsService().GetSettings().Currency == "USD",
            "Validated settings are atomically persisted and polling is bounded");
        var settingsPath = typeof(SettingsService).GetField("_settingsPath", BindingFlags.NonPublic | BindingFlags.Instance)!;
        string settingsDirectory = Path.Combine(HubStorage.HubDir, "blocked-settings"); Directory.CreateDirectory(settingsDirectory);
        settingsPath.SetValue(settings, settingsDirectory);
        settingsCopy = settings.GetSettings(); settingsCopy.Currency = "CNY";
        bool saveFailed = false;
        try { settings.SaveSettings(settingsCopy); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { saveFailed = true; }
        Check(saveFailed && settings.GetSettings().Currency == "USD", "Settings write failure is visible and leaves the previous in-memory settings intact");

        string redirect = "http://127.0.0.1:18500/oauth-callback";
        Check(OAuthCallback.Parse(redirect + "?code=a%2Bb&state=session", redirect, "session") == "a+b",
            "OAuth callback matches the current endpoint/state and decodes the code exactly");
        foreach (string callback in new[] { "https://evil.invalid/oauth-callback?code=x&state=session", redirect + "?code=x&state=other", redirect + "?code=x&code=y&state=session", redirect + "?state=session", "code=x&state=session" })
        {
            bool rejected = false; try { OAuthCallback.Parse(callback, redirect, "session"); } catch (ArgumentException) { rejected = true; }
            Check(rejected, "OAuth rejects mismatched, duplicate, absent or incomplete callback parameters: " + Array.IndexOf(new[] { "https://evil.invalid/oauth-callback?code=x&state=session", redirect + "?code=x&state=other", redirect + "?code=x&code=y&state=session", redirect + "?state=session", "code=x&state=session" }, callback));
        }
        Check(!(await accounts.SubmitManualAuthCodeAsync("fixture-code")).Success, "Manual OAuth redemption requires a live pending authorization");
        var portProbe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0); portProbe.Start();
        int port = ((System.Net.IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
        using (var listener = new System.Net.HttpListener())
        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
        using (var http = new System.Net.Http.HttpClient())
        {
            string prefix = $"http://127.0.0.1:{port}/"; listener.Prefixes.Add(prefix); listener.Start();
            var completed = new TaskCompletionSource<OpResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            accounts.OnOAuthCompleted += result => completed.TrySetResult(result);
            var listen = typeof(AccountService).GetMethod("ListenForOAuthCallbackAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
            Task pending = (Task)listen.Invoke(accounts, new object[] { listener, timeout.Token, port, "fixture-state", prefix + "oauth-callback", 0 })!;
            using var invalid = await http.GetAsync(prefix + "oauth-callback?code=fixture&state=wrong", timeout.Token);
            Check(invalid.StatusCode == System.Net.HttpStatusCode.BadRequest && !completed.Task.IsCompleted,
                "Invalid local OAuth callback is rejected without consuming the pending authorization");
            using var denied = await http.GetAsync(prefix + "oauth-callback?error=access_denied&state=fixture-state", timeout.Token);
            var denial = await completed.Task.WaitAsync(timeout.Token); await pending;
            Check(!denial.Success && denied.StatusCode == System.Net.HttpStatusCode.BadRequest,
                "Loopback callback without a trailing slash reaches the listener and user denial completes as failure");
        }
        var negativeArea = new System.Drawing.Rectangle(-1920, -200, 1920, 1080);
        var placed = TrayPlacement.Calculate(new System.Drawing.Point(-10, 870), negativeArea, 435, 900);
        Check(negativeArea.Contains(placed) && placed.Right <= -8 && placed.Bottom <= 872,
            "Tray physical coordinates stay within a negative-origin monitor working area");
        placed = TrayPlacement.Calculate(new System.Drawing.Point(4, 2), new System.Drawing.Rectangle(0, 0, 800, 600), 1000, 1000);
        Check(placed == new System.Drawing.Rectangle(8, 8, 784, 584), "Oversized tray dimensions are bounded by the target monitor");
        passed.AddRange(PricingTests.Run());
        passed.AddRange(await MetadataTests.Run());
        passed.AddRange(await ActivityTests.Run());
        string output = JsonSerializer.Serialize(new { passed, scope = "Isolated fixture DB/files, fake credential store; no real account, network or IDE operation." }, JsonOpts.Indented);
        File.WriteAllText(Path.GetFullPath("outputs/reliability-results.json"), output);
        Console.WriteLine($"PASS: {passed.Count} reliability regression cases.");
    }

    private sealed class FakeCredentials : ICredentialStore
    {
        public string? Value;
        public bool FailNextWrite;
        public string? Read() => Value;
        public bool Write(string json) { if (FailNextWrite) { FailNextWrite = false; return false; } Value = json; return true; }
        public bool Delete() { Value = null; return true; }
    }
}
