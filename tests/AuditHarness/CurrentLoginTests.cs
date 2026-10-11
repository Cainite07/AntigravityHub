using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AntigravityHub;

internal static class CurrentLoginTests
{
    internal static async Task Run()
    {
        int passed = 0;
        void Check(bool condition, string label)
        {
            if (!condition) throw new Exception(label);
            passed++;
        }
        HubStorage.HubDir = Path.Combine(AppContext.BaseDirectory, "current-login-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        string file = Path.Combine(HubStorage.HubDir, "oauth_creds.json");
        string Id(string email) => "header." + Convert.ToBase64String(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new { email, name = "Import fixture" }))).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".signature";
        string Native(string email) => JsonSerializer.Serialize(new {
            token = new { access_token = "native-access", refresh_token = "native-refresh", token_type = "Bearer", expiry = "2026-10-06T01:02:03Z" },
            id_token = Id(email), auth_method = "consumer" });
        string Legacy(string email) => JsonSerializer.Serialize(new {
            access_token = "legacy-access", refresh_token = "legacy-refresh", expiry_date = 1791248523000L, id_token = Id(email) });
        var store = new Store { Value = Native("native@example.invalid") };
        var service = new AccountService(store, file, _ => false, _ => Task.CompletedTask);
        var parsed = CurrentLoginCredentials.Parse(store.Value, "native")!;
        Check(parsed.ExpiryTimestamp == 1791248523L, "Native ISO expiry is preserved");
        Check(parsed.IdToken == Id("native@example.invalid"), "Native root-level id_token is read");
        Check(service.GetClientStatus().CredsFound && !File.Exists(file), "Native-only login is ready without a CLI file");
        var result = await service.ImportFromCurrentLoginAsync();
        Check(result.Success && service.GetAccounts().Count == 1, "Native-only import succeeds");
        Check(!File.Exists(file) && store.Writes == 0, "Import does not rewrite native credentials or create a CLI file");
        result = await service.ImportFromCurrentLoginAsync();
        Check(result.Success && service.GetAccounts().Count == 1, "Repeated import updates the same account");
        string detail = Directory.GetFiles(HubStorage.AccountsDetailDir).Single();
        byte[] encrypted = File.ReadAllBytes(detail);
        using (var document = JsonDocument.Parse(ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser)))
        {
            Check(document.RootElement.GetProperty("token").GetProperty("refresh_token").GetString() == "native-refresh", "The stored account uses the native refresh token");
        }
        Check(encrypted[0] != (byte)'{', "Imported credentials remain encrypted at rest");
        File.WriteAllText(file, Legacy("old@example.invalid"));
        result = await service.ImportFromCurrentLoginAsync();
        Check(result.Success && service.GetAccounts().Count == 1, "Native login takes priority over another account's stale file");
        store.Value = "{broken-json";
        string indexBefore = File.ReadAllText(HubStorage.AccountsJson);
        result = await service.ImportFromCurrentLoginAsync();
        Check(!result.Success && File.ReadAllText(HubStorage.AccountsJson) == indexBefore, "Malformed native credentials cannot import a stale account or change the index");
        Check(!service.GetClientStatus().CredsFound, "Malformed credentials are not marked ready");
        store.Value = null;
        result = await service.ImportFromCurrentLoginAsync();
        Check(result.Success && service.GetAccounts().Count == 2, "Legacy file remains supported when native credentials are absent");
        Check(CurrentLoginCredentials.Parse(Legacy("legacy@example.invalid"), "file")!.ExpiryTimestamp == 1791248523L, "Legacy millisecond expiry is preserved");
        Check(CurrentLoginCredentials.Parse("{\"token\":{\"refresh_token\":\"r\",\"id_token\":\"nested\"}}", "native")!.IdToken == "nested", "Nested id_token is supported");
        foreach (string invalid in new[] { "[]", "null", "{\"token\":null}", "{\"access_token\":123}", "{}" })
            Check(CurrentLoginCredentials.Parse(invalid, "invalid") == null, "Unsupported credential structure is rejected");
        File.WriteAllText(file, "{}");
        Check(!service.GetClientStatus().CredsFound, "An empty file is not proof of login");
        Console.WriteLine($"PASS: {passed} current-login import checks; synthetic accounts only.");
    }

    private sealed class Store : ICredentialStore
    {
        internal string? Value;
        internal int Writes;
        public string? Read() => Value;
        public bool Write(string json) { Writes++; Value = json; return true; }
        public bool Delete() { Writes++; Value = null; return true; }
    }
}
