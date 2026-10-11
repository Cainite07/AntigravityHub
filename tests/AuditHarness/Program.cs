using System.Reflection;
using System.Text.Json;
using AntigravityHub;
using Microsoft.Data.Sqlite;

if (args.Length == 2 && args[0] == "--transaction-child")
{
    using var connection = new SqliteConnection($"Data Source={args[1]};Pooling=False"); connection.Open();
    using var transaction = connection.BeginTransaction();
    using var command = connection.CreateCommand(); command.Transaction = transaction;
    command.CommandText = "UPDATE events SET fingerprint='uncommitted',payload='{}'; DELETE FROM cursors;";
    command.ExecuteNonQuery(); Console.WriteLine("READY"); Console.Out.Flush(); Console.ReadLine(); return;
}
HubStorage.HubDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "fixtures"));
HubStorage.EnsureInitialized();
if (args.Contains("--client-restart-only")) { await ClientRestartTests.Run(); return; }
if (args.Contains("--client-settings-only")) {
    HubStorage.HubDir = Path.Combine(HubStorage.HubDir, "client-settings-" + Guid.NewGuid().ToString("N"));
    HubStorage.EnsureInitialized();
    var clientSettingsService = new SettingsService(); var s = clientSettingsService.GetSettings();
    if (s.EnableClientLocalization || s.EnableThinkingTranslation || s.EnableClientWindowSize) throw new Exception("New client features must default off.");
    if (s.ClientWindowWidth != 1400 || s.ClientWindowHeight != 900 || !s.CloseToTray || !s.StartMinimized)
        throw new Exception("First-run dimensions and tray defaults do not match the product defaults.");
    s.CloseToTray = false; s.StartMinimized = false;
    s.EnableThinkingTranslation = true; s.ClientWindowWidth = 1280; s.ClientWindowHeight = 720;
    clientSettingsService.SaveSettings(s); var reloaded = new SettingsService().GetSettings();
    if (!reloaded.EnableThinkingTranslation || reloaded.EnableClientLocalization || reloaded.ClientWindowWidth != 1280 || reloaded.ClientWindowHeight != 720)
        throw new Exception("Client settings persistence or independent toggles failed.");
    if (reloaded.CloseToTray || reloaded.StartMinimized) throw new Exception("Existing tray choices were overwritten.");
    foreach (int width in new[] { 0, 639, 7681 }) {
        var invalid = clientSettingsService.GetSettings(); invalid.ClientWindowWidth = width;
        try { clientSettingsService.SaveSettings(invalid); throw new Exception("Invalid width accepted."); } catch (ArgumentException) { }
    }
    foreach (int height in new[] { 0, 479, 4321 }) {
        var invalid = clientSettingsService.GetSettings(); invalid.ClientWindowHeight = height;
        try { clientSettingsService.SaveSettings(invalid); throw new Exception("Invalid height accepted."); } catch (ArgumentException) { }
    }
    s.EnableThinkingTranslation = false; clientSettingsService.SaveSettings(s);
    s.EnableClientWindowSize = false; s.ClientWindowWidth = 1475; s.ClientWindowHeight = 875;
    clientSettingsService.SaveSettings(s);
    var migrated = new SettingsService().GetSettings();
    if (migrated.ClientWindowWidth != 1400 || migrated.ClientWindowHeight != 900 || migrated.StartMinimized)
        throw new Exception("Unused legacy preset migration failed or altered an existing tray preference.");
    s.EnableClientWindowSize = true; clientSettingsService.SaveSettings(s);
    var custom = new SettingsService().GetSettings();
    if (custom.ClientWindowWidth != 1475 || custom.ClientWindowHeight != 875) throw new Exception("An enabled custom size was overwritten.");
    Console.WriteLine("PASS: client defaults, independent thinking/UI persistence, rejected dimensions preserve existing settings."); return;
}
if (args.Contains("--current-login-only")) { await CurrentLoginTests.Run(); return; }
if (args.Contains("--live-login-read-only"))
{
    var credentials = CurrentLoginCredentials.Read(new WindowsCredentialStore(), Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "oauth_creds.json"), out _);
    if (credentials == null) throw new Exception("Current login credentials were not readable.");
    var profile = AccountMetadata.ReadIdToken(credentials.IdToken);
    Console.WriteLine(JsonSerializer.Serialize(new { readable = true, native = credentials.Source == "Windows 登录凭据",
        hasAccessToken = credentials.AccessToken.Length > 0, hasRefreshToken = credentials.RefreshToken.Length > 0,
        hasEmail = !string.IsNullOrWhiteSpace(profile?.Email) }));
    return;
}
if (args.Contains("--live-current-login-import"))
{
    // Explicit import acceptance mode: same backend as the UI, no login/switch/restart.
    HubStorage.HubDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".antigravity_hub");
    var live = new AccountService();
    int before = live.GetAccounts().Count;
    var result = await live.ImportFromCurrentLoginAsync();
    var credentials = CurrentLoginCredentials.Read(new WindowsCredentialStore(), Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "oauth_creds.json"), out _);
    string email = AccountMetadata.ReadIdToken(credentials?.IdToken ?? "")?.Email ?? "";
    var after = live.GetAccounts();
    bool matched = after.Any(account => string.Equals(account.Email, email, StringComparison.OrdinalIgnoreCase));
    Console.WriteLine(JsonSerializer.Serialize(new { result.Success, accountsBefore = before, accountsAfter = after.Count,
        currentLoginImported = matched, legacyFileCreated = File.Exists(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "oauth_creds.json")) }));
    if (!result.Success || !matched) throw new Exception("Current-login import acceptance failed.");
    return;
}
if (args.Contains("--live-metadata-refresh"))
{
    // Explicit maintenance mode: refresh profile/quota caches, never switch an account or restart IDE.
    HubStorage.HubDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".antigravity_hub");
    var liveAccounts = new AccountService();
    int failed = await liveAccounts.RefreshAllQuotasAsync(liveAccounts.GetAccounts());
    var metadata = liveAccounts.GetAccounts().Select((account, index) => new { index, hasAvatar = account.AvatarUrl.Length > 0,
        cachedAvatar = account.AvatarDataUrl.Length > 0, tier = account.Tier, quotaStatus = account.QuotaStatus });
    var evidence = JsonSerializer.Serialize(new { failed, accounts = metadata }, JsonOpts.Indented);
    File.WriteAllText(Path.GetFullPath("outputs/订阅切号_实机资料同步.json"), evidence);
    Console.WriteLine(evidence); return;
}
if (args.Contains("--aggregation-only")) { AggregateTests.Run(); return; }
if (args.Contains("--snapshot-cache-only")) { SnapshotCacheTests.Run(); return; }
if (args.Contains("--migration-replay")) { await MigrationReplay.Run(); return; }
if (args.Contains("--reliability-only")) { await ReliabilityTests.Run(); return; }
var results = new List<object>();
void Result(string name, object evidence) => results.Add(new { name, evidence });

var rows = Enumerable.Range(0, 32).Select(day => JsonSerializer.Serialize(new {
    model = "gemini-3.8-flash", hour_start = new DateTimeOffset(DateTime.Today.AddDays(-day).AddHours(12)).ToUniversalTime().ToString("o"),
    total_tokens = 1, input_tokens = 1, cached_input_tokens = 0, output_tokens = 0, reasoning_output_tokens = 0, conversation_count = 1
}));
File.WriteAllLines(HubStorage.TokensJsonl, rows);
bool dateWindowOnly = args.Contains("--date-window-only");
if (dateWindowOnly)
{
    File.AppendAllText(HubStorage.TokensJsonl, JsonSerializer.Serialize(new {
        model = "gemini-3.8-flash", hour_start = new DateTimeOffset(DateTime.Today.AddDays(1).AddHours(12)).ToUniversalTime().ToString("o"),
        total_tokens = 1000, input_tokens = 1000, cached_input_tokens = 0, output_tokens = 0, reasoning_output_tokens = 0, conversation_count = 1
    }) + Environment.NewLine);
}
var settings = new SettingsService();
var service = new TokenStatsService(settings);
var stats = service.GetStats();
Result("rolling_windows", new { expected7 = 7, actual7 = stats.SevenDaysTokens, expected30 = 30, actual30 = stats.ThirtyDaysTokens });
if (dateWindowOnly)
{
    if (stats.SevenDaysTokens != 7 || stats.ThirtyDaysTokens != 30 || stats.TodayTokens != 1 || stats.TotalTokens != 1032 ||
        Math.Abs(stats.SevenDaysCostUsd - 7 * 0.75 / 1_000_000) > 1e-12 ||
        Math.Abs(stats.ThirtyDaysCostUsd - 30 * 0.75 / 1_000_000) > 1e-12)
        throw new Exception("Date window regression failed.");
    Console.WriteLine("PASS: 7/30 local dates, boundary exclusion, future exclusion, matching cost, unchanged today/all-time.");
    return;
}
service.InvalidateCache();
Result("settings_invalidation_snapshot", new { expectedRetainedTokens = stats.TotalTokens, actualCachedTokens = service.GetCachedStats().TotalTokens });
if (args.Contains("--settings-cache-only"))
{
    if (service.GetCachedStats().TotalTokens != stats.TotalTokens)
        throw new Exception("Invalidation lost the last successful snapshot.");
    File.WriteAllText(HubStorage.TokensJsonl, JsonSerializer.Serialize(new {
        model = "gemini-3.8-flash", hour_start = DateTimeOffset.Now.ToString("o"),
        total_tokens = 1_000_000, input_tokens = 1_000_000, cached_input_tokens = 0,
        output_tokens = 0, reasoning_output_tokens = 0, conversation_count = 1
    }));
    var dollarSettings = settings.GetSettings(); dollarSettings.Currency = "USD"; settings.SaveSettings(dollarSettings);
    service.InvalidateCache();
    var dollarStats = await service.GetStatsAsync(triggerScan: false);
    var yuanSettings = settings.GetSettings(); yuanSettings.Currency = "CNY"; yuanSettings.LiveUsdToCnyRate = 2; settings.SaveSettings(yuanSettings);
    service.InvalidateCache();
    var yuanStats = await service.GetStatsAsync(triggerScan: false);
    if (dollarStats.TodayTokens != 1_000_000 || !dollarStats.TodayCostFormatted.StartsWith("$") ||
        Math.Abs(dollarStats.TodayCostUsd - 0.75) > 1e-12 || yuanStats.TodayTokens != 1_000_000 ||
        !yuanStats.TodayCostFormatted.StartsWith("¥") || Math.Abs(yuanStats.TodayCostRmb - 1.5) > 1e-12 ||
        service.GetCachedStats().TodayTokens != 1_000_000)
        throw new Exception("Settings recalculation regression failed.");
    Console.WriteLine("PASS: invalidation retains snapshot; currency/rate recalculate without scanning; refreshed cache keeps token totals.");
    return;
}

throw new ArgumentException("Use --reliability-only, --date-window-only or --settings-cache-only.");

namespace AntigravityHub
{
    public static class HubStorage
    {
        public static string HubDir { get; set; } = "";
        public static string AccountsJson => Path.Combine(HubDir, "accounts.json");
        public static string AccountsDetailDir => Path.Combine(HubDir, "accounts");
        public static string TokensJsonl => Path.Combine(HubDir, "tokens.jsonl");
        public static string CursorsJson => Path.Combine(HubDir, "cursors.json");
        public static void EnsureInitialized() { Directory.CreateDirectory(HubDir); Directory.CreateDirectory(AccountsDetailDir); }
    }
}
