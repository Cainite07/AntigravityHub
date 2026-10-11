using System.Reflection;
using System.Text.Json;
using AntigravityHub;

internal static class MetadataTests
{
    public static async Task<List<string>> Run()
    {
        var passed = new List<string>();
        void Check(bool value, string name) { if (!value) throw new Exception(name); passed.Add("Metadata/switch: " + name); }
        string previous = HubStorage.HubDir;
        HubStorage.HubDir = Path.Combine(AppContext.BaseDirectory, "metadata-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        try
        {
            JsonElement Json(string value) { using var doc = JsonDocument.Parse(value); return doc.RootElement.Clone(); }
            Check(AccountMetadata.ParseTier(Json("{\"paidTier\":{\"name\":\"Google AI Pro\"},\"currentTier\":{\"name\":\"Free\"}}")) == "PRO", "Selected paid tier takes precedence");
            Check(AccountMetadata.ParseTier(Json("{\"currentTier\":{\"id\":\"free-tier\"}}")) == "FREE", "Explicit free tier remains free");
            Check(AccountMetadata.ParseTier(Json("{\"allowedTiers\":[{\"name\":\"Ultra\",\"isDefault\":true}]}")) == "", "Offered tiers cannot become a paid subscription");
            Check(AccountMetadata.ParseTier(Json("{}")) == "", "Missing tier remains absent");
            using (var request = AccountMetadata.CreateRequest("fixture-access", false))
            {
                Check(request.Method == System.Net.Http.HttpMethod.Post && request.RequestUri!.AbsoluteUri == "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "Subscription uses the Antigravity daily endpoint");
                Check(request.Headers.UserAgent.ToString() == "antigravity/2.17.0" && request.Headers.Authorization?.Parameter == "fixture-access", "Antigravity user agent and bearer authorization accompany the request");
                var body = Json(await request.Content!.ReadAsStringAsync()).GetProperty("metadata");
                Check(body.GetProperty("ideType").GetString() == "ANTIGRAVITY" && body.GetProperty("platform").GetString() == "PLATFORM_UNSPECIFIED" && body.GetProperty("pluginType").GetString() == "GEMINI", "Subscription request identifies Antigravity, platform and plugin");
            }
            using (var request = AccountMetadata.CreateRequest("fixture-access", true))
                Check(request.Method == System.Net.Http.HttpMethod.Get && request.RequestUri!.Host == "openidconnect.googleapis.com" && request.Content == null, "Profile query remains the official UserInfo GET");
            var now = DateTimeOffset.UtcNow;
            var cached = JsonSerializer.Serialize(new { metadata_query_version = AccountMetadata.QueryVersion, subscription = new { name = "Google AI Pro", updated_at = now.AddMinutes(-2).ToString("o") } });
            Check(AccountMetadata.IsRecent(Json(cached), now), "Verified tier with matching request revision is cached for one hour");
            Check(!AccountMetadata.IsRecent(Json(cached.Replace(AccountMetadata.QueryVersion, "old-query")), now), "Old request cache is invalidated immediately after upgrade");
            Check(!AccountMetadata.IsRecent(Json(JsonSerializer.Serialize(new { metadata_query_version = AccountMetadata.QueryVersion,
                subscription = new { name = "Google AI Pro", updated_at = now.AddHours(-2).ToString("o") } })), now), "Expired subscription cache is refreshed");
            Check(!AccountMetadata.IsRecent(Json("{\"metadata_updated_at\":\"" + now.ToString("o") + "\"}"), now), "Profile-only cache cannot suppress retrying a missing tier");
            File.WriteAllText(Path.Combine(HubStorage.HubDir, "app_settings.json"), "{\"AutoReloadAntigravity\":false,\"Currency\":\"USD\"}");
            Check(new SettingsService().GetSettings().Currency == "USD" && !JsonSerializer.Serialize(new SettingsService().GetSettings()).Contains("AutoReloadAntigravity"), "Legacy restart setting is ignored without losing other preferences");
            foreach (var url in new[] { "http://lh3.googleusercontent.com/a", "https://evil.invalid/a", "https://lh3.googleusercontent.com.evil.invalid/a", "https://user@lh3.googleusercontent.com/a", "file:///a" })
                Check(AccountMetadata.ValidPicture(url) == "", "Unsafe avatar source rejected: " + url);
            Check(AccountMetadata.ValidPicture("https://lh3.googleusercontent.com/a").Length > 0, "Known Google avatar host accepted");
            Check(AccountMetadata.ReadIdToken("bad") == null, "Malformed JWT display hint is harmless");
            Check(AvatarCache.ToDataUrl(new byte[9]) == "" && AvatarCache.ToDataUrl(new byte[600000]) == "", "Invalid or oversized avatar bytes rejected");
            var image = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA3sAAAAASUVORK5CYII=");
            Check(AvatarCache.ToDataUrl(image).StartsWith("data:image/png;base64,"), "Cached image uses a bounded raster data URL");
            bool running = true, failRestart = false, ignoreRestart = false;
            var credentials = new FakeCredentials();
            var service = new AccountService(credentials, Path.Combine(HubStorage.HubDir, "fake-ide-creds.json"),
                cutoff => running, cancellation => { if (failRestart) throw new IOException("fixture restart failure"); if (!ignoreRestart) running = false; return Task.CompletedTask; },
                _ => Task.FromResult(IdeActivity.Idle));
            var fixture = JsonSerializer.Serialize(new { id = "fixture", email = "fixture@example.invalid", name = "fixture", token = new {
                access_token = "fixture-access", refresh_token = "fixture-refresh", expiry_timestamp = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds() } });
            string importPath = Path.Combine(HubStorage.HubDir, "import.json"); File.WriteAllText(importPath, fixture);
            Check((await service.ImportFromJsonFileAsync(importPath)).Success, "Isolated fixture account imported");
            var save = typeof(AccountService).GetMethod("SaveMetadata", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var profile = new AccountProfile("fixture@example.invalid", "Google display name", "https://lh3.googleusercontent.com/fixture");
            save.Invoke(service, new object?[] { "fixture", "fixture@example.invalid", "fixture-refresh", profile, "PRO" });
            var account = service.GetAccounts().Single();
            Check(account.Name == "Google display name" && account.AvatarUrl == profile.Picture && account.Tier == "PRO", "Profile and selected tier survive an encrypted round trip");
            save.Invoke(service, new object?[] { "fixture", "fixture@example.invalid", "stale-refresh", new AccountProfile(profile.Email, "stale", ""), "Ultra" });
            Check(service.GetAccounts().Single().Name == "Google display name", "Stale credential response cannot overwrite a reimported profile");
            save.Invoke(service, new object?[] { "fixture", "fixture@example.invalid", "fixture-refresh", new AccountProfile("other@example.invalid", "other", profile.Picture), "Ultra" });
            Check(service.GetAccounts().Single().Tier == "PRO", "Another account's profile cannot be attached to this account");
            save.Invoke(service, new object?[] { "fixture", "fixture@example.invalid", "fixture-refresh", null, "" });
            Check(service.GetAccounts().Single().AvatarUrl == profile.Picture && service.GetAccounts().Single().Tier == "PRO", "Metadata failure keeps previously verified profile/tier");
            running = true; failRestart = true;
            var result = await service.SwitchAccountAsync("fixture");
            Check(result.Success && result.RequiresIdeRestart && !result.IdeRestarted && credentials.Value != null && result.Message.Contains("未完成"), "Failed IDE restart preserves committed credentials and reports pending activation");
            running = false;
            Check(!service.GetAccounts().Single().IdeRestartPending, "Manual IDE exit/restart clears the pending state from live process age");
            running = true;
            failRestart = false;
            ignoreRestart = true;
            result = await service.SwitchAccountAsync("fixture");
            Check(result.Success && result.RequiresIdeRestart && !result.IdeRestarted && result.Message.Contains("旧客户端仍在运行"), "Restart cannot claim activation when the old client survives");
            ignoreRestart = false;
            result = await service.SwitchAccountAsync("fixture");
            Check(result.Success && result.IdeRestarted && !result.RequiresIdeRestart && !result.NewAccount!.IdeRestartPending, "Successful fake restart clears pending activation");
            result = await service.SwitchAccountAsync("fixture");
            Check(result.Success && result.IdeRestarted && !result.RequiresIdeRestart, "Switch also starts a previously closed client");

            HubStorage.HubDir = Path.Combine(HubStorage.HubDir, "heatmap"); HubStorage.EnsureInitialized();
            File.WriteAllLines(HubStorage.TokensJsonl, new long[] { 9_000_000, 25_000_000, 100_000_000, 400_000_000 }.Select((amount, i) => JsonSerializer.Serialize(new {
                model = "gemini-3.8-flash-tiered", hour_start = new DateTimeOffset(DateTime.Today.AddDays(-i)).ToString("o"), total_tokens = amount, input_tokens = amount } )));
            var summary = new TokenStatsService().GetStats();
            Check(summary.Heatmap.Where(day => day.Tokens > 0).Select(day => day.Level).Distinct().Count() == 4 && summary.Heatmap.Any(day => day.Level == 0), "Million-token usage retains four heatmap intensities and empty days");
            Check(summary.UnpricedTokens == 0 && !summary.TotalCostFormatted.Contains("未定价"), "Real-world tiered suffix now receives an explicit family reference estimate");
        }
        finally { HubStorage.HubDir = previous; }
        return passed;
    }
    private sealed class FakeCredentials : ICredentialStore
    {
        public string? Value;
        public string? Read() => Value;
        public bool Write(string json) { Value = json; return true; }
        public bool Delete() { Value = null; return true; }
    }
}
