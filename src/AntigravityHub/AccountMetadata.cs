using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AntigravityHub;

internal sealed record AccountProfile(string Email, string Name, string Picture);

internal static class AccountMetadata
{
    internal const string QueryVersion = "antigravity-2.17.0-daily-v1";
    internal static bool IsRecent(JsonElement root, DateTimeOffset now) =>
        Text(root, "metadata_query_version") == QueryVersion && root.TryGetProperty("subscription", out var subscription) &&
        !string.IsNullOrWhiteSpace(Text(subscription, "name")) &&
        DateTimeOffset.TryParse(Text(subscription, "updated_at"), out var stamp) && stamp <= now && now - stamp < TimeSpan.FromHours(1);
    private static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false });
    public static string Text(JsonElement root, string name) => root.ValueKind == JsonValueKind.Object &&
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    public static AccountProfile ParseProfile(JsonElement root) => new(Text(root, "email"), Text(root, "name"), ValidPicture(Text(root, "picture")));
    public static AccountProfile? ReadIdToken(string token)
    {
        try
        {
            var parts = token.Split('.'); if (parts.Length != 3) return null;
            string payload = parts[1].Replace('-', '+').Replace('_', '/'); payload += new string('=', (4 - payload.Length % 4) % 4);
            using var doc = JsonDocument.Parse(Convert.FromBase64String(payload));
            return ParseProfile(doc.RootElement); // Display hints only, never an authentication decision.
        }
        catch (Exception ex) when (ex is FormatException or JsonException) { return null; }
    }
    public static string ValidPicture(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.UserInfo.Length == 0 && uri.IsDefaultPort &&
        (uri.Host.EndsWith(".googleusercontent.com", StringComparison.OrdinalIgnoreCase) || uri.Host == "lh3.google.com") ? uri.AbsoluteUri : "";
    public static string NormalizeTier(string? tier)
    {
        if (string.IsNullOrWhiteSpace(tier)) return "";
        string lower = tier.Trim().ToLowerInvariant();
        if (lower.Contains("ultra")) return "ULTRA";
        if (lower.Contains("pro")) return "PRO";
        if (lower.Contains("free") || lower.Contains("免费")) return "FREE";
        return tier.Trim().ToUpperInvariant();
    }
    public static string ParseTier(JsonElement root)
    {
        // Only the selected tier: offered/allowed plans are not evidence of a subscription.
        foreach (string field in new[] { "paidTier", "currentTier" })
        {
            if (!root.TryGetProperty(field, out var tier) || tier.ValueKind != JsonValueKind.Object) continue;
            string name = Text(tier, "name"), id = Text(tier, "id");
            if (!string.IsNullOrWhiteSpace(name)) return NormalizeTier(name);
            if (!string.IsNullOrWhiteSpace(id)) return NormalizeTier(id switch {
                "g1-pro-tier" => "PRO", "g1-ultra-tier" => "ULTRA", "free-tier" => "FREE", _ => id });
        }
        return "";
    }
    internal static HttpRequestMessage CreateRequest(string accessToken, bool profile)
    {
        string url = profile ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
        var request = new HttpRequestMessage(profile ? HttpMethod.Get : HttpMethod.Post, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.UserAgent.ParseAdd("antigravity/2.17.0");
        if (!profile) request.Content = new StringContent("{\"metadata\":{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\"}}", Encoding.UTF8, "application/json");
        return request;
    }
    public static async Task<JsonElement?> QueryAsync(string accessToken, bool profile, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        using var request = CreateRequest(accessToken, profile);
        try
        {
            using var response = await Client.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
            return doc.RootElement.Clone();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException) { return null; }
    }
}

internal static class AvatarCache
{
    private const int MaxBytes = 512 * 1024;
    private static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false });
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTimeOffset> Attempts = new();
    private static string CachePath(string url) => Path.Combine(HubStorage.HubDir, "avatars", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))) + ".img");
    public static string ToDataUrl(byte[] bytes)
    {
        if (bytes.Length < 8 || bytes.Length > MaxBytes) return "";
        string type = bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ? "png"
            : bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255 ? "jpeg" : "";
        return type.Length == 0 ? "" : $"data:image/{type};base64,{Convert.ToBase64String(bytes)}";
    }
    public static string Read(string url)
    {
        if (AccountMetadata.ValidPicture(url).Length == 0) return "";
        try { string path = CachePath(url); return File.Exists(path) && new FileInfo(path).Length <= MaxBytes ? ToDataUrl(File.ReadAllBytes(path)) : ""; }
        catch (IOException) { return ""; }
    }
    public static async Task<string> FetchAsync(string url, CancellationToken cancellationToken)
    {
        if (AccountMetadata.ValidPicture(url).Length == 0) return "";
        string path = CachePath(url), cached = Read(url);
        if (cached.Length > 0 && DateTime.UtcNow - File.GetLastWriteTimeUtc(path) < TimeSpan.FromDays(1)) return cached;
        if (Attempts.TryGetValue(url, out var attempt) && DateTimeOffset.UtcNow - attempt < TimeSpan.FromMinutes(5)) return cached;
        if (Attempts.Count >= 128) Attempts.Clear();
        Attempts[url] = DateTimeOffset.UtcNow;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            using var response = await Client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxBytes) return cached;
            using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var output = new MemoryStream(); byte[] buffer = new byte[8192]; int count;
            while ((count = await input.ReadAsync(buffer, timeout.Token)) > 0)
            {
                if (output.Length + count > MaxBytes) return cached;
                output.Write(buffer, 0, count);
            }
            byte[] bytes = output.ToArray(); string data = ToDataUrl(bytes);
            if (data.Length == 0) return cached;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!); AtomicFile.WriteBytes(path, bytes);
            return data;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException) { return cached; }
    }
}
