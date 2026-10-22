using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AntigravityHub;

internal sealed record HubUpdateStatus(string State, string CurrentVersion, string LatestVersion, string Message, int Progress = 0, string Notes = "");

internal sealed class HubUpdateService : IDisposable
{
    internal const string Repository = "Cainite07/AntigravityHub";
    internal static readonly Uri LatestEndpoint = new($"https://api.github.com/repos/{Repository}/releases/latest");
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _target;
    private readonly Version _version;
    private HubRelease? _release;
    private HubRelease? _download;
    private HubUpdateCatalog? _catalog;
    private string _packageNote = "";
    internal event Action<HubUpdateStatus>? Changed;
    internal HubUpdateStatus Status { get; private set; }
    internal bool IsInstalling { get; private set; }

    internal HubUpdateService(string target, HttpMessageHandler? handler = null, Version? version = null)
    {
        _target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        _version = version ?? HubUpdatePackage.InstalledVersion(_target);
        _http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"AntigravityHub/{_version}");
        _http.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        Status = new("idle", _version.ToString(), "", "尚未检查");
    }

    internal void ReportRollback() => Publish("error", "更新未完成，已恢复原版本，请重新检查更新");
    internal void ReportBusy() => Publish("error", "请等当前操作完成后再更新 Hub");

    private void Publish(string state, string message, int progress = 0)
    {
        Status = new(state, _version.ToString(), _release?.Version.ToString() ?? "", message, progress, _release?.Notes ?? "");
        Changed?.Invoke(Status);
    }

    internal static bool IsReleaseDownload(Uri uri) => uri.Scheme == "https" && uri.Host == "github.com" && uri.IsDefaultPort &&
        uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0 &&
        uri.AbsolutePath.StartsWith($"/{Repository}/releases/download/", StringComparison.Ordinal);

    internal static bool IsAllowedRedirect(Uri uri) => uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0 &&
        (IsReleaseDownload(uri) || uri.Host is "release-assets.githubusercontent.com" or "objects.githubusercontent.com");

    internal static HubRelease? ParseRelease(JsonElement root, Version current)
    {
        if (root.GetProperty("draft").GetBoolean() || root.GetProperty("prerelease").GetBoolean()) return null;
        string tag = root.GetProperty("tag_name").GetString() ?? "";
        var version = HubUpdatePackage.ParseVersion(tag);
        if (version <= current) return null;
        string notes = root.TryGetProperty("body", out var body) ? body.GetString() ?? "" : "";
        var full = ParseAsset(root, version, tag, $"AntigravityHub-{version}-Windows-x64.zip", notes);
        try
        {
            return full with {
                Adaptation = ParseAsset(root, version, tag, $"AntigravityHub-{version}-Adaptation.zip", ""),
                Catalog = ParseAsset(root, version, tag, "update-catalog.json", "") };
        }
        catch (InvalidDataException) { return full; } // Old releases remain usable.
    }

    private static HubRelease ParseAsset(JsonElement root, Version version, string tag, string name, string notes)
    {
        var candidates = root.GetProperty("assets").EnumerateArray().Where(a => a.GetProperty("name").GetString() == name).ToArray();
        if (candidates.Length != 1) throw new InvalidDataException("新版本缺少完整 Windows 更新包。");
        var asset = candidates[0];
        if (asset.GetProperty("state").GetString() != "uploaded" || !asset.GetProperty("size").TryGetInt64(out long size) || size is <= 0 or > HubUpdatePackage.MaxPackageBytes)
            throw new InvalidDataException("更新包尚未准备好。");
        string digest = asset.TryGetProperty("digest", out var d) ? d.GetString() ?? "" : "";
        if (!digest.StartsWith("sha256:", StringComparison.Ordinal) || !HubUpdatePackage.IsHash(digest[7..]))
            throw new InvalidDataException("更新包缺少 SHA-256 校验，已停止更新。");
        if (!Uri.TryCreate(asset.GetProperty("browser_download_url").GetString(), UriKind.Absolute, out var download) ||
            !IsReleaseDownload(download) || download.AbsolutePath != $"/{Repository}/releases/download/{Uri.EscapeDataString(tag)}/{name}")
            throw new InvalidDataException("更新来源无效。");
        return new(version, tag, notes[..Math.Min(notes.Length, 1800)], download, size, digest[7..].ToLowerInvariant());
    }

    private static string Size(long bytes) => $"{bytes / 1048576d:0.0} MB";

    private async Task SelectPackageAsync(CancellationToken cancellation)
    {
        _download = _release; _catalog = null;
        _packageNote = "完整更新包 " + Size(_release!.Size);
        if (_release.Adaptation == null || _release.Catalog == null) return;
        try
        {
            var asset = _release.Catalog;
            if (asset.Size > 64 * 1024) throw new InvalidDataException("适配信息过大。");
            Uri url = asset.Download;
            byte[]? data = null;
            for (int redirects = 0; redirects < 5; redirects++)
            {
                using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
                if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
                {
                    var location = response.Headers.Location ?? throw new InvalidDataException("适配信息地址无效。");
                    url = location.IsAbsoluteUri ? location : new Uri(url, location);
                    if (!IsAllowedRedirect(url)) throw new InvalidDataException("适配信息来源无效。");
                    continue;
                }
                response.EnsureSuccessStatusCode();
                data = await ReadBoundedAsync(response.Content, 64 * 1024, cancellation); break;
            }
            if (data == null || data.Length != asset.Size ||
                !Convert.ToHexString(SHA256.HashData(data)).Equals(asset.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("适配信息校验失败。");
            var catalog = JsonSerializer.Deserialize<HubUpdateCatalog>(data, HubUpdatePackage.Json) ?? throw new InvalidDataException("适配信息无效。");
            var current = HubUpdatePackage.ReadManifest(Path.Combine(_target, HubUpdatePackage.ManifestName));
            string clientExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Antigravity", "Antigravity.exe");
            string? rawClient = File.Exists(clientExe) ? FileVersionInfo.GetVersionInfo(clientExe).FileVersion : null;
            string? client = Version.TryParse(rawClient, out var clientVersion) && clientVersion.Build >= 0 ?
                new Version(clientVersion.Major, clientVersion.Minor, clientVersion.Build).ToString() : rawClient;
            if (catalog.Version != _release.Version.ToString() || catalog.Clients == null ||
                client != null && !catalog.Clients.Contains(client) || !HubUpdatePackage.CanAdapt(_target, current, catalog))
            { _packageNote += "（本机需要更新主程序或客户端适配）"; return; }
            if (_release.Adaptation.Size >= _release.Size) return;
            _catalog = catalog; _download = _release.Adaptation;
            _packageNote = "小型适配包 " + Size(_download.Size) + "，复用现有运行环境";
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or JsonException or HttpRequestException or UnauthorizedAccessException)
        { _packageNote += "（小包条件未通过）"; }
    }

    internal async Task CheckAsync(CancellationToken cancellation)
    {
        if (!await _gate.WaitAsync(0, cancellation)) return;
        try
        {
            Publish("checking", "正在检查更新…");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            using var response = await _http.GetAsync(LatestEndpoint, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.StatusCode == HttpStatusCode.NotFound) { _release = null; Publish("current", "已是最新版本"); return; }
            if (!response.IsSuccessStatusCode) throw new HttpRequestException("GitHub 暂时不可用。");
            byte[] data = await ReadBoundedAsync(response.Content, 512 * 1024, timeout.Token);
            using var document = JsonDocument.Parse(data);
            _release = ParseRelease(document.RootElement, _version);
            if (_release != null) await SelectPackageAsync(timeout.Token);
            Publish(_release == null ? "current" : "available", _release == null ? "已是最新版本" : $"发现新版本 {_release.Version} · {_packageNote}");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or IOException or JsonException or InvalidOperationException or KeyNotFoundException or OperationCanceledException)
        {
            _release = null;
            Publish("error", ex is InvalidDataException ? ex.Message : "暂时无法检查更新，请稍后重试");
        }
        finally { _gate.Release(); }
    }

    private static async Task<byte[]> ReadBoundedAsync(HttpContent content, int limit, CancellationToken cancellation)
    {
        if (content.Headers.ContentLength > limit) throw new InvalidDataException("更新信息过大。");
        using var stream = await content.ReadAsStreamAsync(cancellation);
        using var output = new MemoryStream();
        byte[] buffer = new byte[8192]; int count;
        while ((count = await stream.ReadAsync(buffer, cancellation)) > 0)
        {
            if (output.Length + count > limit) throw new InvalidDataException("更新信息过大。");
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }

    internal async Task<bool> InstallAsync(CancellationToken cancellation)
    {
        if (!await _gate.WaitAsync(0, cancellation)) { Changed?.Invoke(Status); return false; }
        string? jobDirectory = null;
        bool handedOff = false;
        try
        {
            if (_release == null || _release.Version <= _version) throw new InvalidDataException("请先检查可用更新。");
            HubUpdatePackage.RejectLinks(_target);
            var previous = HubUpdatePackage.ReadManifest(Path.Combine(_target, HubUpdatePackage.ManifestName));
            if (HubUpdatePackage.ParseVersion(previous.Version) != _version) throw new InvalidDataException("当前程序与发布包不匹配，请使用完整发布包。");
            string probe = Path.Combine(_target, ".hub-update-probe-" + Guid.NewGuid().ToString("N"));
            try { await File.WriteAllTextAsync(probe, "", cancellation); } finally { if (File.Exists(probe)) File.Delete(probe); }
            IsInstalling = true;
            jobDirectory = HubUpdateInstaller.CreateJobDirectory();
            string archive = Path.Combine(jobDirectory, "download.zip");
            Publish("downloading", "正在下载更新…");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromMinutes(15));
            await DownloadAsync(_download ?? _release, archive, timeout.Token);
            Publish("verifying", "正在校验更新…", 100);
            string stage = Path.Combine(jobDirectory, "stage");
            await Task.Run(() => HubUpdatePackage.ExtractVerified(archive, stage, _release.Version, cancellation,
                _catalog == null ? null : _target, _catalog), cancellation);
            var parent = Process.GetCurrentProcess();
            var job = new HubUpdateJob(_target, _version.ToString(), _release.Version.ToString(), parent.Id, parent.StartTime.ToUniversalTime().Ticks);
            HubUpdateInstaller.WriteJson(Path.Combine(jobDirectory, "job.json"), job);
            var start = new ProcessStartInfo { FileName = Path.Combine(stage, "AntigravityHub.exe"), UseShellExecute = false,
                CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = stage };
            start.ArgumentList.Add("--apply-hub-update"); start.ArgumentList.Add(Path.Combine(jobDirectory, "job.json"));
            using var helper = Process.Start(start) ?? throw new IOException("无法启动更新助手。");
            for (int i = 0; i < 100; i++)
            {
                cancellation.ThrowIfCancellationRequested();
                if (File.Exists(Path.Combine(jobDirectory, "helper-ready")))
                {
                    await File.WriteAllTextAsync(Path.Combine(jobDirectory, "proceed"), "proceed", cancellation);
                    handedOff = true; break;
                }
                if (helper.HasExited) throw new IOException("更新助手未能启动，当前版本已保留。");
                await Task.Delay(100, cancellation);
            }
            if (!handedOff) throw new IOException("更新助手启动超时，当前版本已保留。");
            Publish("restarting", "更新已准备好，正在重启 Hub…", 100);
            return true;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return false; }
        catch (Exception ex) when (ex is InvalidDataException or IOException or HttpRequestException or JsonException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or OperationCanceledException)
        {
            string message = ex is InvalidDataException ? ex.Message : "更新未完成，当前版本已保留，请重试";
            if (_catalog != null)
            {
                _catalog = null; _download = _release;
                message += $" 小包更新未完成；再次点击将使用完整包 {Size(_release!.Size)}。";
            }
            Publish("error", message); return false;
        }
        finally
        {
            IsInstalling = false;
            if (!handedOff && jobDirectory != null)
            {
                try { File.WriteAllText(Path.Combine(jobDirectory, "abort"), "abort"); } catch (IOException) { }
                string cancelledJob = jobDirectory;
                _ = Task.Run(async () =>
                {
                    for (int i = 0; i < 100; i++) { if (HubUpdateInstaller.TryCleanJob(cancelledJob)) return; await Task.Delay(300); }
                });
            }
            _gate.Release();
        }
    }

    private async Task DownloadAsync(HubRelease release, string destination, CancellationToken cancellation)
    {
        Uri url = release.Download;
        for (int redirects = 0; redirects < 5; redirects++)
        {
            using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
            {
                var location = response.Headers.Location;
                if (location == null) throw new InvalidDataException("更新下载地址无效。");
                url = location.IsAbsoluteUri ? location : new Uri(url, location);
                if (!IsAllowedRedirect(url)) throw new InvalidDataException("更新下载跳转到未知来源。");
                continue;
            }
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is long length && length != release.Size) throw new InvalidDataException("更新包大小不匹配。");
            using var input = await response.Content.ReadAsStreamAsync(cancellation);
            using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            byte[] buffer = new byte[65536]; long total = 0; int count, lastProgress = -1;
            while ((count = await input.ReadAsync(buffer, cancellation)) > 0)
            {
                total += count;
                if (total > release.Size) throw new InvalidDataException("更新包超出预期大小。");
                await output.WriteAsync(buffer.AsMemory(0, count), cancellation);
                hash.AppendData(buffer, 0, count);
                int progress = (int)(total * 100 / release.Size);
                if (progress != lastProgress) { lastProgress = progress; Publish("downloading", "正在下载更新…", progress); }
            }
            if (total != release.Size || !Convert.ToHexString(hash.GetHashAndReset()).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("更新包 SHA-256 校验失败，当前版本已保留。");
            return;
        }
        throw new InvalidDataException("更新下载跳转次数过多。");
    }

    public void Dispose() => _http.Dispose();
}
