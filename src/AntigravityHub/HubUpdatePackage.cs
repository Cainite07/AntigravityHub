using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;

namespace AntigravityHub;

internal sealed record HubRelease(Version Version, string Tag, string Notes, Uri Download, long Size, string Sha256);
internal sealed record HubPackageFile(string Path, long Size, string Sha256);
internal sealed record HubPackageManifest(int Schema, string Version, HubPackageFile[] Files);

internal static class HubUpdatePackage
{
    internal const string ManifestName = "update-manifest.json";
    internal const long MaxPackageBytes = 1024L * 1024 * 1024;
    internal const long MaxExpandedBytes = 2L * 1024 * 1024 * 1024;
    internal static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, WriteIndented = true };

    internal static Version ParseVersion(string text)
    {
        if (string.IsNullOrEmpty(text) || !Regex.IsMatch(text, @"^v?\d{1,5}\.\d{1,5}\.\d{1,5}$") ||
            !System.Version.TryParse(text.TrimStart('v'), out var version) ||
            version.Major > 65535 || version.Minor > 65535 || version.Build > 65535)
            throw new InvalidDataException("版本号无效。");
        return version;
    }

    internal static bool IsHash(string? value) => value != null && Regex.IsMatch(value, "^[a-fA-F0-9]{64}$");
    internal static string Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    internal static void ValidateRelative(string relative)
    {
        if (relative.Length == 0 || relative.Length > 240 || relative.Contains('\\') || relative.Contains(':') ||
            relative.StartsWith('/') || relative.IndexOfAny(['\0', '*', '?', '"', '<', '>', '|']) >= 0)
            throw new InvalidDataException("更新文件路径无效。");
        var parts = relative.Split('/');
        foreach (string part in parts)
            if (part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') ||
                part.Any(char.IsControl) || Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|\.)", RegexOptions.IgnoreCase))
                throw new InvalidDataException("更新文件路径无效。");
        if (parts.Any(p => p.Equals("base", StringComparison.OrdinalIgnoreCase)) ||
            new[] { ".git", ".antigravity_hub", "accounts", "src", "tests", "work", "outputs", "artifacts", "publish", "WebView2Data" }
                .Contains(parts[0], StringComparer.OrdinalIgnoreCase) ||
            new[] { "accounts.json", "app_settings.json", "oauth_client.dat", "oauth_creds.json", "window_state.json" }
                .Contains(parts[^1], StringComparer.OrdinalIgnoreCase) ||
            new[] { ".asar", ".dat", ".db", ".sqlite3", ".log" }.Contains(System.IO.Path.GetExtension(relative), StringComparer.OrdinalIgnoreCase))
            throw new InvalidDataException("更新包包含用户数据或客户端底包。");
    }

    internal static string Resolve(string root, string relative)
    {
        ValidateRelative(relative);
        string prefix = System.IO.Path.GetFullPath(root).TrimEnd(System.IO.Path.DirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar;
        string path = System.IO.Path.GetFullPath(System.IO.Path.Combine(prefix, relative.Replace('/', System.IO.Path.DirectorySeparatorChar)));
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新路径越界。");
        RejectLinks(path);
        return path;
    }

    internal static void RejectLinks(string path)
    {
        for (string? current = System.IO.Path.GetFullPath(path); current != null; current = System.IO.Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("更新目录不能包含符号链接或目录联接。");
    }

    internal static HubPackageManifest ReadManifest(string path)
    {
        RejectLinks(path);
        if (!File.Exists(path) || new FileInfo(path).Length > 4 * 1024 * 1024) throw new InvalidDataException("缺少有效的更新清单，请使用完整发布包。");
        return ValidateManifest(JsonSerializer.Deserialize<HubPackageManifest>(File.ReadAllText(path), Json)
            ?? throw new InvalidDataException("更新清单无效。"));
    }

    internal static HubPackageManifest ValidateManifest(HubPackageManifest manifest)
    {
        if (manifest.Schema != 1 || manifest.Files == null || manifest.Files.Length is < 4 or > 12000)
            throw new InvalidDataException("更新清单无效。");
        ParseVersion(manifest.Version);
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long size = 0;
        foreach (var file in manifest.Files)
        {
            if (file == null || file.Path == null) throw new InvalidDataException("更新清单无效。");
            ValidateRelative(file.Path);
            if (file.Path.Equals(ManifestName, StringComparison.OrdinalIgnoreCase) || !paths.Add(file.Path) ||
                file.Size < 0 || file.Size > MaxExpandedBytes || !IsHash(file.Sha256)) throw new InvalidDataException("更新清单无效。");
            size = checked(size + file.Size);
        }
        if (size > MaxExpandedBytes || new[] { "AntigravityHub.exe", "AntigravityHub.dll", "AntigravityHub.runtimeconfig.json", "wwwroot/index.html" }.Any(f => !paths.Contains(f)))
            throw new InvalidDataException("更新包不完整。");
        return manifest;
    }

    internal static HubPackageManifest ExtractVerified(string archivePath, string stage, Version expected, CancellationToken cancellation)
    {
        using var archive = ZipFile.OpenRead(archivePath);
        if (archive.Entries.Count > 12500) throw new InvalidDataException("更新包文件过多。");
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var entry in archive.Entries)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!entry.FullName.StartsWith("AntigravityHub/", StringComparison.Ordinal)) throw new InvalidDataException("更新包目录无效。");
            string relative = entry.FullName["AntigravityHub/".Length..];
            if (relative.Length == 0) continue;
            ValidateRelative(relative.TrimEnd('/'));
            int unixType = (entry.ExternalAttributes >> 16) & 0xF000;
            if (unixType == 0xA000 || (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("更新包不能包含链接。");
            if (entry.FullName.EndsWith('/')) continue;
            total = checked(total + entry.Length);
            if (total > MaxExpandedBytes || !entries.TryAdd(relative, entry)) throw new InvalidDataException("更新包文件无效或重复。");
        }
        if (!entries.TryGetValue(ManifestName, out var manifestEntry) || manifestEntry.Length > 4 * 1024 * 1024)
            throw new InvalidDataException("更新包缺少清单。");
        HubPackageManifest manifest;
        using (var stream = manifestEntry.Open()) manifest = ValidateManifest(JsonSerializer.Deserialize<HubPackageManifest>(stream, Json)
            ?? throw new InvalidDataException("更新清单无效。"));
        if (ParseVersion(manifest.Version) != expected || entries.Count != manifest.Files.Length + 1)
            throw new InvalidDataException("更新版本或文件清单不匹配。");
        Directory.CreateDirectory(stage);
        foreach (var file in manifest.Files)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!entries.TryGetValue(file.Path, out var entry) || entry.Length != file.Size) throw new InvalidDataException("更新包不完整。");
            string path = Resolve(stage, file.Path);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            entry.ExtractToFile(path, false);
            if (!Hash(path).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新文件校验失败。");
        }
        manifestEntry.ExtractToFile(Resolve(stage, ManifestName), false);
        return manifest;
    }
}
