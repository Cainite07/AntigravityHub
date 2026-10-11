using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using AntigravityHub;
using Microsoft.Data.Sqlite;

internal static class MigrationReplay
{
    public static async Task Run()
    {
        HubStorage.HubDir = Path.Combine(AppContext.BaseDirectory, "migration-replay-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        string original = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".antigravity_hub", "tokens.jsonl");
        if (File.Exists(original)) File.Copy(original, HubStorage.TokensJsonl);
        var service = new TokenStatsService();
        var decode = typeof(UsageDecoder).GetMethod("DecodeServerUsage", BindingFlags.NonPublic | BindingFlags.Static)!;
        var decodeErrors = new Dictionary<string, int>(); int sourceRows = 0, emptyRows = 0, validRows = 0;
        string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini");
        foreach (string family in new[] { "antigravity", "antigravity-ide" })
        {
            string directory = Path.Combine(home, family, "conversations"); if (!Directory.Exists(directory)) continue;
            foreach (string database in Directory.GetFiles(directory, "*.db"))
            {
                using var source = new SqliteConnection($"Data Source={database};Mode=ReadOnly;Pooling=False"); source.Open();
                using var read = source.CreateCommand(); read.CommandText = "SELECT data FROM gen_metadata";
                using var reader = read.ExecuteReader();
                while (reader.Read())
                {
                    sourceRows++;
                    try { if (reader.IsDBNull(0) || decode.Invoke(null, new[] { reader.GetValue(0) }) == null) emptyRows++; else validRows++; }
                    catch (TargetInvocationException ex) { string kind = ex.InnerException!.GetType().Name + ": " + ex.InnerException.Message; decodeErrors[kind] = decodeErrors.GetValueOrDefault(kind) + 1; }
                }
            }
        }
        long before = service.GetStats().TotalTokens;
        var tracker = new NativeTokenTracker(); var clock = Stopwatch.StartNew();
        int first = await tracker.ScanAndAggregateAsync(); long scanMs = clock.ElapsedMilliseconds;
        clock.Restart(); var summary = service.GetStats(); long statsMs = clock.ElapsedMilliseconds;
        clock.Restart(); int repeat = await tracker.ScanAndAggregateAsync(); long unchangedMs = clock.ElapsedMilliseconds;
        long repeatedTotal = service.GetStats().TotalTokens;
        if (repeat != 0 || repeatedTotal != summary.TotalTokens) throw new Exception("Repeated migration scan changed totals.");
        using var connection = new SqliteConnection($"Data Source={UsageRepository.DefaultPath};Mode=ReadOnly;Pooling=False"); connection.Open();
        using var command = connection.CreateCommand(); command.CommandText = "SELECT value FROM meta WHERE key='migration'";
        using var migration = JsonDocument.Parse((string)command.ExecuteScalar()!);
        var report = new { mode = "Copied legacy JSONL; read-only source DBs; no real usage/account writes", beforeTokens = before,
            afterTokens = summary.TotalTokens, acceptedEvents = first, repeatAcceptedEvents = repeat, repeatTotalUnchanged = true,
            scanMs, statsMs, unchangedMs, sourceRows, validRows, emptyRows, decodeErrors, migration = migration.RootElement.Clone(),
            warning = "Unmatched historical usage is retained; older unidentifiable duplicate data is not automatically removed." };
        File.WriteAllText(Path.GetFullPath("outputs/全量优化_历史迁移演练.json"), JsonSerializer.Serialize(report, JsonOpts.Indented));
        Console.WriteLine($"PASS migration replay: {first} accepted events; repeat=0; scan={scanMs}ms; stats={statsMs}ms; unchanged={unchangedMs}ms.");
    }
}
