using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace AntigravityHub;

internal static class OAuthConfiguration
{
    public static string Read(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            var file = Path.Combine(HubStorage.HubDir, "oauth_client.dat");
            if (File.Exists(file))
            {
                var bytes = ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser);
                using var document = JsonDocument.Parse(bytes);
                if (document.RootElement.TryGetProperty(name, out var property)) value = property.GetString();
                CryptographicOperations.ZeroMemory(bytes);
            }
        }
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException("尚未配置 OAuth 客户端。请按 README 设置 " + name + " 后重新打开 Hub。");
        return value.Trim();
    }
}
