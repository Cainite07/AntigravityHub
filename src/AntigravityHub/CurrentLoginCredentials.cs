using System;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace AntigravityHub;

internal sealed record CurrentLoginCredentials(string AccessToken, string RefreshToken, string TokenType,
    string IdToken, long ExpiryTimestamp, string Source)
{
    internal static CurrentLoginCredentials? Read(ICredentialStore store, string filePath, out string error)
    {
        error = "";
        try
        {
            // The native client's current login takes precedence over an older CLI file.
            string? native = store.Read();
            if (!string.IsNullOrWhiteSpace(native))
            {
                var credentials = Parse(native, "Windows 登录凭据");
                if (credentials == null) error = "已找到客户端登录凭据，但格式不受支持或没有可用令牌。";
                return credentials;
            }
            if (!File.Exists(filePath))
            {
                error = "未找到客户端登录凭据，请确认 Antigravity 已完成账号登录后重试。";
                return null;
            }
            var legacy = Parse(File.ReadAllText(filePath), "本地登录文件");
            if (legacy == null) error = "本地登录文件格式不受支持或没有可用令牌。";
            return legacy;
        }
        catch
        {
            error = "无法读取客户端登录凭据，请稍后重试。";
            return null;
        }
    }

    internal static CurrentLoginCredentials? Parse(string json, string source)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var token = root.TryGetProperty("token", out var nested) ? nested : root;
            if (token.ValueKind != JsonValueKind.Object) return null;
            string access = Text(token, "access_token"), refresh = Text(token, "refresh_token");
            if (string.IsNullOrWhiteSpace(access) && string.IsNullOrWhiteSpace(refresh)) return null;
            string id = Text(token, "id_token");
            if (id.Length == 0) id = Text(root, "id_token");
            string type = Text(token, "token_type");
            long expiry = 0;
            if (token.TryGetProperty("expiry_date", out var milliseconds) && milliseconds.TryGetInt64(out long ms) && ms > 0)
                expiry = ms / 1000;
            else if (DateTimeOffset.TryParse(Text(token, "expiry"), CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var instant)) expiry = instant.ToUnixTimeSeconds();
            return new(access, refresh, type.Length == 0 ? "Bearer" : type, id, expiry, source);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
        {
            return null;
        }
    }

    private static string Text(JsonElement element, string name) => element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
}
