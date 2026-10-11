using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;

namespace AntigravityHub
{
    public class AccountService
    {
        private readonly string _accountsJsonPath;
        private readonly string _accountsDetailDir;
        private readonly string _geminiCredsPath;
        private readonly string _ideExePath;
        private readonly ICredentialStore _credentialStore;
        private readonly Func<DateTimeOffset, bool> _hasOldIdeProcess;
        private readonly Func<CancellationToken, Task> _restartIde;
        private readonly Func<CancellationToken, Task<IdeActivity>> _readIdeActivity;
        private readonly SemaphoreSlim _switchLock = new(1, 1);
        private readonly string _switchRecoveryPath;
        private readonly string _mutationRecoveryPath;
        private static readonly HttpClient _httpClient = new HttpClient();
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> _quotaStates = new();
        private static readonly SemaphoreSlim _accountsLock = new(1, 1);

        private static string OAUTH_CLIENT_ID => OAuthConfiguration.Read("ANTIGRAVITY_OAUTH_CLIENT_ID");
        private static string OAUTH_CLIENT_SECRET => OAuthConfiguration.Read("ANTIGRAVITY_OAUTH_CLIENT_SECRET");

        private System.Net.HttpListener? _oauthListener;
        private System.Threading.CancellationTokenSource? _oauthCts;
        private string? _currentOauthRedirectUri;
        private string? _currentOauthState;
        private DateTimeOffset _oauthExpiresAt;
        private int _oauthGeneration;
        private int _oauthClaimed;
        public event Action<OpResult>? OnOAuthCompleted;

        private static void Log(string msg) => Logger.Log("AccountService", msg);

        private static string DecodeDetailJson(byte[] bytes)
        {
            if (bytes.Length == 0) throw new InvalidDataException("账号文件为空。");
            try { return new UTF8Encoding(false, true).GetString(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser)); }
            catch (CryptographicException)
            {
                // Accept legacy plaintext only if it is a valid JSON object.
                try
                {
                    string legacy = new UTF8Encoding(false, true).GetString(bytes);
                    using var document = JsonDocument.Parse(legacy);
                    if (document.RootElement.ValueKind == JsonValueKind.Object) return legacy;
                }
                catch (Exception ex) when (ex is JsonException or DecoderFallbackException) { }
                throw new InvalidDataException("账号文件无法解密或已损坏，已保留原文件。");
            }
        }

        private static string ReadDetailJson(string path) => File.Exists(path) ? DecodeDetailJson(File.ReadAllBytes(path)) : "";

        private static async Task<string> ReadDetailJsonAsync(string path) =>
            File.Exists(path) ? DecodeDetailJson(await File.ReadAllBytesAsync(path)) : "";

        private static void WriteDetailJson(string path, string json)
        {
            byte[] encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(json), null, DataProtectionScope.CurrentUser);
            AtomicFile.WriteBytes(path, encrypted);
        }

        private static Task WriteDetailJsonAsync(string path, string json) => Task.Run(() => WriteDetailJson(path, json));
        private static Task WriteTextAtomicAsync(string path, string content) => AtomicFile.WriteTextAsync(path, content);
        private string DetailPath(string id) => AccountSafety.DetailPath(_accountsDetailDir, id);

        public AccountService() : this(new WindowsCredentialStore(), null) { }

        internal AccountService(ICredentialStore credentialStore, string? credentialsPath, Func<DateTimeOffset, bool>? hasOldIdeProcess = null,
            Func<CancellationToken, Task>? restartIde = null, Func<CancellationToken, Task<IdeActivity>>? readIdeActivity = null)
        {
            _credentialStore = credentialStore;
            HubStorage.EnsureInitialized();
            _accountsJsonPath = HubStorage.AccountsJson;
            _accountsDetailDir = HubStorage.AccountsDetailDir;

            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            _geminiCredsPath = credentialsPath ?? Path.Combine(userProfile, ".gemini", "oauth_creds.json");
            _switchRecoveryPath = Path.Combine(HubStorage.HubDir, "switch_recovery.dat");
            _mutationRecoveryPath = Path.Combine(HubStorage.HubDir, "account_mutation_recovery.dat");
            _ideExePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Antigravity", "Antigravity.exe");
            _hasOldIdeProcess = hasOldIdeProcess ?? (cutoff => AccountSafety.HasIdeProcessStartedBefore(_ideExePath, cutoff));
            _restartIde = restartIde ?? (cancellation => AccountSafety.RestartIdeAsync(_ideExePath, cancellation));
            _readIdeActivity = readIdeActivity ?? (cancellation => IdeActivity.ReadAsync(_ideExePath, cancellation));
            _accountsLock.Wait();
            try { RecoverPendingMutation(); RecoverPendingSwitch(); }
            finally { _accountsLock.Release(); }
        }

        public List<AccountItem> GetAccounts()
        {
            _accountsLock.Wait();
            try { return GetAccountsCore(); }
            finally { _accountsLock.Release(); }
        }

        private List<AccountItem> GetAccountsCore()
        {
            RecoverPendingMutation(); RecoverPendingSwitch();
            var list = new List<AccountItem>();
            if (!File.Exists(_accountsJsonPath))
                return list;

            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_accountsJsonPath));
                var root = doc.RootElement;
                string currentId = root.TryGetProperty("current_account_id", out var curElem) ? curElem.GetString() ?? "" : "";

                bool pending = root.TryGetProperty("ide_restart_pending", out var pendingFlag) && pendingFlag.ValueKind == JsonValueKind.True &&
                    DateTimeOffset.TryParse(AccountMetadata.Text(root, "ide_restart_pending_since"), out var switchedAt) && _hasOldIdeProcess(switchedAt);

                if (root.TryGetProperty("accounts", out var accsElem) && accsElem.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in accsElem.EnumerateArray())
                    {
                        string id = item.TryGetProperty("id", out var idElem) ? idElem.GetString() ?? "" : "";
                        try { DetailPath(id); } catch (ArgumentException) { continue; }
                        string email = item.TryGetProperty("email", out var emailElem) ? emailElem.GetString() ?? "" : "";
                        string name = item.TryGetProperty("name", out var nameElem) ? nameElem.GetString() ?? "" : "";
                        
                        var acc = new AccountItem
                        {
                            Id = id,
                            Email = email,
                            Name = string.IsNullOrEmpty(name) ? email : name,
                            Tier = "",
                            IsCurrent = (id == currentId),
                            IdeRestartPending = id == currentId && pending,
                            Gemini5hQuota = -1,
                            GeminiWeeklyQuota = -1,
                            Claude5hQuota = -1,
                            ClaudeWeeklyQuota = -1
                        };

                        // Enrich with detail account file
                        string detailPath = DetailPath(id);
                        if (File.Exists(detailPath))
                        {
                            try
                            {
                                string detailJson = ReadDetailJson(detailPath);
                                if (!string.IsNullOrEmpty(detailJson))
                                {
                                    using var detailDoc = JsonDocument.Parse(detailJson);
                                    var dRoot = detailDoc.RootElement;

                                    var profile = dRoot.TryGetProperty("profile", out var profileRoot) ? AccountMetadata.ParseProfile(profileRoot) : null;
                                    var hint = dRoot.TryGetProperty("token", out var tokenRoot) ? AccountMetadata.ReadIdToken(AccountMetadata.Text(tokenRoot, "id_token")) : null;
                                    if (profile?.Email.Equals(email, StringComparison.OrdinalIgnoreCase) == true)
                                    {
                                        if (profile.Name.Length > 0) acc.Name = profile.Name;
                                        acc.AvatarUrl = profile.Picture;
                                    }
                                    if (acc.AvatarUrl.Length == 0 && hint?.Email.Equals(email, StringComparison.OrdinalIgnoreCase) == true) acc.AvatarUrl = hint.Picture;
                                    acc.AvatarDataUrl = AvatarCache.Read(acc.AvatarUrl);
                                    if (dRoot.TryGetProperty("subscription", out var subscription)) acc.Tier = AccountMetadata.NormalizeTier(AccountMetadata.Text(subscription, "name"));

                                    // Cached quota if available
                                    if (dRoot.TryGetProperty("quota", out var quotaElem))
                                    {
                                        ParseQuotaJsonElement(acc, quotaElem);
                                        acc.LastQuotaRefreshTime = dRoot.TryGetProperty("quota_updated_at", out var updated) ? updated.GetString() ?? "" : "";
                                        acc.QuotaStatus = "cached";
                                    }
                                }
                            }
                            catch { }
                        }

                        if (_quotaStates.TryGetValue(id, out var status)) acc.QuotaStatus = status;
                        list.Add(acc);
                    }
                }
            }
            catch (Exception ex)
            {
                throw new IOException("账号索引读取失败，已保留原文件。", ex);
            }

            return list;
        }

        public async Task<int> RefreshAllQuotasAsync(List<AccountItem> accounts, CancellationToken cancellationToken = default)
        {
            int failures = 0;
            using var throttle = new SemaphoreSlim(4);
            await Task.WhenAll(accounts.Select(async account =>
            {
                await throttle.WaitAsync(cancellationToken);
                try
                {
                    await RefreshAccountQuotaAsync(account, cancellationToken);
                    _quotaStates[account.Id] = "fresh";
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref failures);
                    _quotaStates[account.Id] = "failed";
                    Log($"Quota refresh failed: {ex.GetType().Name}");
                }
                finally { throttle.Release(); }
            }));
            return failures;
        }

        private async Task RefreshAccountQuotaAsync(AccountItem acc, CancellationToken cancellationToken)
        {
            string? token = null;

            // 2. Read from accounts detail json
            string detailPath = DetailPath(acc.Id);
            string refreshToken = "";
            long expiryTimestamp = 0;

            if (File.Exists(detailPath))
            {
                try
                {
                    string detailJson = ReadDetailJson(detailPath);
                    if (!string.IsNullOrEmpty(detailJson))
                    {
                        using var doc = JsonDocument.Parse(detailJson);
                        var root = doc.RootElement;
                        if (root.TryGetProperty("token", out var tElem))
                        {
                            if (string.IsNullOrEmpty(token) && tElem.TryGetProperty("access_token", out var atElem))
                            {
                                token = atElem.GetString();
                            }
                            if (tElem.TryGetProperty("refresh_token", out var rtElem))
                            {
                                refreshToken = rtElem.GetString() ?? "";
                            }
                            if (tElem.TryGetProperty("expiry_timestamp", out var expElem))
                            {
                                expiryTimestamp = expElem.GetInt64();
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log($"[AccountService] Error reading detail json for {acc.Email}: {ex.Message}");
                }
            }

            // If token is missing or expired (within 120s of expiry), refresh it
            long nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if ((string.IsNullOrEmpty(token) || (expiryTimestamp > 0 && nowSec >= expiryTimestamp - 120)) && !string.IsNullOrEmpty(refreshToken))
            {
                Log($"[AccountService] Token expired/missing for {acc.Email}, refreshing via OAuth...");
                var refreshed = await RefreshAccessTokenViaOAuthAsync(refreshToken, cancellationToken);
                if (!string.IsNullOrEmpty(refreshed.accessToken))
                {
                    token = refreshed.accessToken;
                    UpdateAccountTokenInJson(acc.Id, refreshed.accessToken, refreshed.expiresIn, refreshToken);
                    Log($"[AccountService] Token refreshed via OAuth for {acc.Email} (expires in {refreshed.expiresIn}s)");
                }
            }

            if (string.IsNullOrEmpty(token))
            {
                Log($"[AccountService] No access token available for {acc.Email}");
                throw new InvalidOperationException("账号缺少有效令牌，请重新授权。");
            }

            // Profile/tier failure must not discard otherwise valid quota data.
            try { await RefreshMetadataAsync(acc, token, refreshToken, cancellationToken); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log($"Profile cache failed: {ex.GetType().Name}"); }

            // 3. Query Google CloudCode retrieveUserQuotaSummary
            var quotaResult = await QueryGoogleQuotaApiAsync(token, cancellationToken);
            if (quotaResult == null && !string.IsNullOrEmpty(refreshToken))
            {
                Log($"[AccountService] Quota API query failed for {acc.Email}, attempting token refresh retry...");
                var refreshed = await RefreshAccessTokenViaOAuthAsync(refreshToken, cancellationToken);
                if (!string.IsNullOrEmpty(refreshed.accessToken))
                {
                    token = refreshed.accessToken;
                    UpdateAccountTokenInJson(acc.Id, refreshed.accessToken, refreshed.expiresIn, refreshToken);
                    quotaResult = await QueryGoogleQuotaApiAsync(token, cancellationToken);
                }
            }

            if (quotaResult != null)
            {
                if (!ParseQuotaJsonElement(acc, quotaResult.Value)) throw new InvalidDataException("无法识别配额响应，已保留旧缓存。");
                acc.LastQuotaRefreshTime = DateTimeOffset.UtcNow.ToString("o");
                SaveQuotaToDetailJson(acc.Id, quotaResult.Value, refreshToken);
                Log($"[AccountService] Successfully refreshed quota for {acc.Email}: Gemini 5h={acc.Gemini5hQuota}%, Weekly={acc.GeminiWeeklyQuota}%, Claude 5h={acc.Claude5hQuota}%, Weekly={acc.ClaudeWeeklyQuota}%");
            }
            else
            {
                throw new HttpRequestException("配额查询失败，已保留旧缓存。");
            }
        }

        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTimeOffset> _metadataAttempts = new();

        private async Task RefreshMetadataAsync(AccountItem acc, string accessToken, string expectedRefreshToken, CancellationToken cancellationToken)
        {
            string path = DetailPath(acc.Id);
            bool recent = false;
            try
            {
                using var detail = JsonDocument.Parse(ReadDetailJson(path));
                recent = AccountMetadata.IsRecent(detail.RootElement, DateTimeOffset.UtcNow);
            }
            catch (Exception ex) when (ex is IOException or JsonException) { return; }
            if (!recent && (!_metadataAttempts.TryGetValue(acc.Id, out var attempted) || DateTimeOffset.UtcNow - attempted > TimeSpan.FromMinutes(5)))
            {
                _metadataAttempts[acc.Id] = DateTimeOffset.UtcNow;
                var profileTask = AccountMetadata.QueryAsync(accessToken, true, cancellationToken);
                var tierTask = AccountMetadata.QueryAsync(accessToken, false, cancellationToken);
                await Task.WhenAll(profileTask, tierTask);
                var response = await profileTask;
                var profile = response.HasValue ? AccountMetadata.ParseProfile(response.Value) : null;
                if (profile?.Email.Equals(acc.Email, StringComparison.OrdinalIgnoreCase) != true) profile = null;
                var tierResponse = await tierTask;
                string tier = tierResponse.HasValue && tierResponse.Value.ValueKind == JsonValueKind.Object ? AccountMetadata.ParseTier(tierResponse.Value) : "";
                if (profile != null || tier.Length > 0)
                {
                    SaveMetadata(acc.Id, acc.Email, expectedRefreshToken, profile, tier);
                    if (profile?.Picture.Length > 0) acc.AvatarUrl = profile.Picture;
                }
            }
            if (acc.AvatarUrl.Length > 0) await AvatarCache.FetchAsync(acc.AvatarUrl, cancellationToken);
        }

        private void SaveMetadata(string id, string email, string expectedRefreshToken, AccountProfile? profile, string tier)
        {
            if (profile != null && !profile.Email.Equals(email, StringComparison.OrdinalIgnoreCase)) return;
            _accountsLock.Wait();
            try
            {
                RecoverPendingMutation(); RecoverPendingSwitch();
                string path = DetailPath(id); if (!File.Exists(path)) return;
                var node = System.Text.Json.Nodes.JsonNode.Parse(ReadDetailJson(path));
                if (node?["token"]?["refresh_token"]?.GetValue<string>() != expectedRefreshToken ||
                    !string.Equals(node?["email"]?.GetValue<string>(), email, StringComparison.OrdinalIgnoreCase)) return;
                if (profile != null) node!["profile"] = new System.Text.Json.Nodes.JsonObject { ["email"] = profile.Email, ["name"] = profile.Name, ["picture"] = profile.Picture };
                if (tier.Length > 0)
                {
                    node!["subscription"] = new System.Text.Json.Nodes.JsonObject { ["name"] = tier, ["source"] = "loadCodeAssist", ["updated_at"] = DateTimeOffset.UtcNow.ToString("o") };
                    node!["metadata_query_version"] = AccountMetadata.QueryVersion;
                }
                node!["metadata_updated_at"] = DateTimeOffset.UtcNow.ToString("o");
                WriteDetailJson(path, node.ToJsonString(JsonOpts.Indented));
            }
            finally { _accountsLock.Release(); }
        }

        private static string? GetActiveAccessToken()
        {
            try
            {
                string? keyringJson = CredentialManager.ReadCredential("gemini:antigravity");
                if (!string.IsNullOrEmpty(keyringJson))
                {
                    using var doc = JsonDocument.Parse(keyringJson);
                    if (doc.RootElement.TryGetProperty("token", out var tElem) &&
                        tElem.TryGetProperty("access_token", out var atElem))
                    {
                        return atElem.GetString();
                    }
                }
            }
            catch { }
            return null;
        }

        private static async Task<(string? accessToken, int expiresIn)> RefreshAccessTokenViaOAuthAsync(string refreshToken, CancellationToken cancellationToken = default)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token")
                {
                    Content = new FormUrlEncodedContent(new Dictionary<string, string>
                    {
                        ["client_id"] = OAUTH_CLIENT_ID,
                        ["client_secret"] = OAUTH_CLIENT_SECRET,
                        ["grant_type"] = "refresh_token",
                        ["refresh_token"] = refreshToken
                    })
                };

                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(TimeSpan.FromSeconds(8));
                using var res = await _httpClient.SendAsync(req, cts.Token);
                if (res.IsSuccessStatusCode)
                {
                    string json = await res.Content.ReadAsStringAsync();
                    using var doc = JsonDocument.Parse(json);
                    string? at = doc.RootElement.TryGetProperty("access_token", out var atElem) ? atElem.GetString() : null;
                    int exp = doc.RootElement.TryGetProperty("expires_in", out var expElem) ? expElem.GetInt32() : 3599;
                    return (at, exp);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch { }
            return (null, 0);
        }

        private static async Task<JsonElement?> QueryGoogleQuotaApiAsync(string accessToken, CancellationToken cancellationToken = default)
        {
            string[] endpoints = new[]
            {
                "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
                "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
            };

            foreach (var url in endpoints)
            {
                try
                {
                    Log($"[AccountService] Querying quota endpoint: {url}");
                    using var req = new HttpRequestMessage(HttpMethod.Post, url);
                    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                    req.Headers.Add("User-Agent", "antigravity/2.9.1");
                    req.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");

                    using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    cts.CancelAfter(TimeSpan.FromSeconds(6));
                    using var res = await _httpClient.SendAsync(req, cts.Token);
                    if (res.IsSuccessStatusCode)
                    {
                        string json = await res.Content.ReadAsStringAsync();
                        using var doc = JsonDocument.Parse(json);
                        Log($"[AccountService] Successfully received quota from: {url}");
                        return doc.RootElement.Clone();
                    }
                    else
                    {
                        Log($"[AccountService] Endpoint {url} returned HTTP {(int)res.StatusCode}");
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    Log($"[AccountService] Error querying {url}: {ex.Message}");
                }
            }
            return null;
        }

        private static bool ParseQuotaJsonElement(AccountItem acc, JsonElement root)
        {
            try
            {
                var parsed = new AccountItem();
                // Structure can be: { "groups": [ ... ] } or { "userQuotas": [ { "quotaGroups": [ ... ] } ] }
                JsonElement groupsElem = default;
                if (root.TryGetProperty("groups", out var g) && g.ValueKind == JsonValueKind.Array)
                {
                    groupsElem = g;
                }
                else if (root.TryGetProperty("userQuotas", out var uq) && uq.ValueKind == JsonValueKind.Array)
                {
                    foreach (var u in uq.EnumerateArray())
                    {
                        if (u.TryGetProperty("quotaGroups", out var qg) && qg.ValueKind == JsonValueKind.Array)
                        {
                            groupsElem = qg;
                            break;
                        }
                    }
                }
                else if (root.TryGetProperty("quota_groups", out var qg2) && qg2.ValueKind == JsonValueKind.Array)
                {
                    groupsElem = qg2;
                }

                if (groupsElem.ValueKind != JsonValueKind.Array) return false;

                foreach (var group in groupsElem.EnumerateArray())
                {
                    string gName = group.TryGetProperty("displayName", out var dn) ? dn.GetString() ?? "" : "";
                    if (string.IsNullOrEmpty(gName) && group.TryGetProperty("display_name", out var dn2))
                    {
                        gName = dn2.GetString() ?? "";
                    }

                    if (group.TryGetProperty("buckets", out var bucketsElem) && bucketsElem.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var b in bucketsElem.EnumerateArray())
                        {
                            string window = b.TryGetProperty("window", out var win) ? win.GetString() ?? "" : "";
                            JsonElement remaining;
                            if (!b.TryGetProperty("remainingFraction", out remaining) && !b.TryGetProperty("remaining_fraction", out remaining)) continue;
                            if (!remaining.TryGetDouble(out double frac) || !double.IsFinite(frac) || frac < 0 || frac > 1) continue;
                            int pct = (int)Math.Round(frac * 100);
                            string resetTime = "";
                            if (b.TryGetProperty("resetTime", out var rt)) resetTime = rt.GetString() ?? "";
                            else if (b.TryGetProperty("reset_time", out var rt2)) resetTime = rt2.GetString() ?? "";

                            string countdown = FormatResetCountdown(resetTime);
                            string formatted = FormatResetExact(resetTime);

                            if (gName.Contains("Gemini", StringComparison.OrdinalIgnoreCase))
                            {
                                if (window == "5h")
                                {
                                    parsed.Gemini5hQuota = pct;
                                    parsed.ResetTime5h = resetTime;
                                    parsed.ResetTime5hDesc = countdown;
                                    parsed.ResetTime5hFormatted = formatted;
                                }
                                else if (window == "weekly")
                                {
                                    parsed.GeminiWeeklyQuota = pct;
                                    parsed.ResetTimeWeekly = resetTime;
                                    parsed.ResetTimeWeeklyDesc = countdown;
                                    parsed.ResetTimeWeeklyFormatted = formatted;
                                }
                            }
                            else if (gName.Contains("Claude", StringComparison.OrdinalIgnoreCase) || 
                                     gName.Contains("GPT", StringComparison.OrdinalIgnoreCase) ||
                                     gName.Contains("3p", StringComparison.OrdinalIgnoreCase))
                            {
                                if (window == "5h")
                                {
                                    parsed.Claude5hQuota = pct;
                                    parsed.ClaudeResetTime5h = resetTime;
                                    parsed.ClaudeResetTime5hDesc = countdown;
                                    parsed.ClaudeResetTime5hFormatted = formatted;
                                }
                                else if (window == "weekly")
                                {
                                    parsed.ClaudeWeeklyQuota = pct;
                                    parsed.ClaudeResetTimeWeekly = resetTime;
                                    parsed.ClaudeResetTimeWeeklyDesc = countdown;
                                    parsed.ClaudeResetTimeWeeklyFormatted = formatted;
                                }
                            }
                        }
                    }
                }
                if (parsed.Gemini5hQuota < 0 && parsed.GeminiWeeklyQuota < 0 && parsed.Claude5hQuota < 0 && parsed.ClaudeWeeklyQuota < 0) return false;
                acc.Gemini5hQuota = parsed.Gemini5hQuota;
                acc.GeminiWeeklyQuota = parsed.GeminiWeeklyQuota;
                acc.Claude5hQuota = parsed.Claude5hQuota;
                acc.ClaudeWeeklyQuota = parsed.ClaudeWeeklyQuota;
                acc.ResetTime5h = parsed.ResetTime5h;
                acc.ResetTimeWeekly = parsed.ResetTimeWeekly;
                acc.ResetTime5hDesc = parsed.ResetTime5hDesc;
                acc.ResetTimeWeeklyDesc = parsed.ResetTimeWeeklyDesc;
                acc.ResetTime5hFormatted = parsed.ResetTime5hFormatted;
                acc.ResetTimeWeeklyFormatted = parsed.ResetTimeWeeklyFormatted;
                acc.ClaudeResetTime5h = parsed.ClaudeResetTime5h;
                acc.ClaudeResetTimeWeekly = parsed.ClaudeResetTimeWeekly;
                acc.ClaudeResetTime5hDesc = parsed.ClaudeResetTime5hDesc;
                acc.ClaudeResetTimeWeeklyDesc = parsed.ClaudeResetTimeWeeklyDesc;
                acc.ClaudeResetTime5hFormatted = parsed.ClaudeResetTime5hFormatted;
                acc.ClaudeResetTimeWeeklyFormatted = parsed.ClaudeResetTimeWeeklyFormatted;
                return true;
            }
            catch { return false; }
        }

        private static string FormatResetCountdown(string? resetTimeIso)
        {
            if (string.IsNullOrEmpty(resetTimeIso)) return "";
            if (DateTimeOffset.TryParse(resetTimeIso, out var resetDto))
            {
                var diff = resetDto - DateTimeOffset.UtcNow;
                if (diff.TotalMinutes <= 0) return "即将刷新";
                if (diff.TotalHours < 1) return $"{(int)Math.Max(1, diff.TotalMinutes)}分钟后";
                if (diff.TotalDays < 1) return $"{(int)diff.TotalHours}小时{diff.Minutes}分后";
                return $"{(int)diff.TotalDays}天{diff.Hours}小时后";
            }
            return "";
        }

        private static string FormatResetExact(string? resetTimeIso)
        {
            if (string.IsNullOrEmpty(resetTimeIso)) return "";
            if (DateTimeOffset.TryParse(resetTimeIso, out var resetDto))
            {
                var local = resetDto.ToLocalTime();
                var now = DateTimeOffset.Now;
                if (local.Date == now.Date)
                {
                    return $"今日 {local:HH:mm}";
                }
                if (local.Date == now.Date.AddDays(1))
                {
                    return $"明日 {local:HH:mm}";
                }
                return $"{local:M月d日 HH:mm}";
            }
            return "";
        }

        private void UpdateAccountTokenInJson(string accountId, string newAccessToken, int expiresIn, string expectedRefreshToken)
        {
            _accountsLock.Wait();
            try { RecoverPendingMutation(); RecoverPendingSwitch(); UpdateAccountTokenCore(accountId, newAccessToken, expiresIn, expectedRefreshToken); }
            finally { _accountsLock.Release(); }
        }

        private void UpdateAccountTokenCore(string accountId, string newAccessToken, int expiresIn, string expectedRefreshToken)
        {
            string path = DetailPath(accountId);
            if (!File.Exists(path)) return;
            var node = System.Text.Json.Nodes.JsonNode.Parse(ReadDetailJson(path));
            if (node?["token"]?["refresh_token"]?.GetValue<string>() != expectedRefreshToken) return;
            node["token"]!["access_token"] = newAccessToken;
            node["token"]!["expires_in"] = expiresIn;
            node["token"]!["expiry_timestamp"] = DateTimeOffset.UtcNow.AddSeconds(expiresIn).ToUnixTimeSeconds();
            WriteDetailJson(path, node.ToJsonString(JsonOpts.Indented));
        }

        private void SaveQuotaToDetailJson(string accountId, JsonElement quotaRoot, string expectedRefreshToken)
        {
            _accountsLock.Wait();
            try
            {
                RecoverPendingMutation(); RecoverPendingSwitch();
                string path = DetailPath(accountId);
                if (!File.Exists(path)) return;
                var node = System.Text.Json.Nodes.JsonNode.Parse(ReadDetailJson(path));
                if (node?["token"]?["refresh_token"]?.GetValue<string>() != expectedRefreshToken) return;
                node!["quota"] = System.Text.Json.Nodes.JsonNode.Parse(quotaRoot.GetRawText());
                node["quota_updated_at"] = DateTimeOffset.UtcNow.ToString("o");
                WriteDetailJson(path, node.ToJsonString(JsonOpts.Indented));
            }
            finally { _accountsLock.Release(); }
        }

        private sealed class AccountMutationRecovery
        {
            public string Id { get; set; } = "";
            public string? DetailBytes { get; set; }
            public string? Index { get; set; }
        }

        private void RecoverPendingMutation()
        {
            if (!File.Exists(_mutationRecoveryPath)) return;
            var old = JsonSerializer.Deserialize<AccountMutationRecovery>(ReadDetailJson(_mutationRecoveryPath))
                ?? throw new InvalidDataException("账号操作恢复记录无效，已保留文件。");
            string path = DetailPath(old.Id);
            if (old.DetailBytes == null) { if (File.Exists(path)) File.Delete(path); }
            else AtomicFile.WriteBytes(path, Convert.FromBase64String(old.DetailBytes));
            RestoreFile(_accountsJsonPath, old.Index);
            File.Delete(_mutationRecoveryPath);
        }

        private async Task CommitAccountMutationAsync(string id, string? detailJson, string indexJson)
        {
            RecoverPendingMutation(); RecoverPendingSwitch();
            string path = DetailPath(id);
            var old = new AccountMutationRecovery { Id = id,
                DetailBytes = File.Exists(path) ? Convert.ToBase64String(await File.ReadAllBytesAsync(path)) : null,
                Index = File.Exists(_accountsJsonPath) ? await File.ReadAllTextAsync(_accountsJsonPath) : null };
            await WriteDetailJsonAsync(_mutationRecoveryPath, JsonSerializer.Serialize(old));
            try
            {
                if (detailJson == null) { if (File.Exists(path)) File.Delete(path); }
                else await WriteDetailJsonAsync(path, detailJson);
                await WriteTextAtomicAsync(_accountsJsonPath, indexJson);
                File.Delete(_mutationRecoveryPath);
            }
            catch
            {
                RecoverPendingMutation();
                throw;
            }
        }

        private void RecoverPendingSwitch()
        {
            if (!File.Exists(_switchRecoveryPath)) return;
            var old = JsonSerializer.Deserialize<AccountSwitchRecovery>(ReadDetailJson(_switchRecoveryPath))
                ?? throw new IOException("账号切换恢复文件无效，请保留该文件并检查。");
            bool restored = old.Credential == null ? _credentialStore.Delete() : _credentialStore.Write(old.Credential);
            if (!restored) throw new IOException("无法恢复 Windows 凭据，恢复文件已保留。");
            RestoreFile(_geminiCredsPath, old.DiskCredentials);
            RestoreFile(_accountsJsonPath, old.AccountIndex);
            File.Delete(_switchRecoveryPath);
        }

        private static void RestoreFile(string path, string? content)
        {
            if (content == null) { if (File.Exists(path)) File.Delete(path); }
            else AtomicFile.WriteBytes(path, Encoding.UTF8.GetBytes(content));
        }

        public async Task<SwitchResult> SwitchAccountAsync(string targetAccountId,
            Func<IdeActivity, Task<bool>>? confirmRestart = null, CancellationToken cancellationToken = default)
        {
            if (!await _switchLock.WaitAsync(0, cancellationToken))
                return new SwitchResult { Message = "已有切号操作正在进行，请先完成或取消。" };
            try
            {
                // No account lock is held while waiting for a user: periodic UI refresh remains responsive.
                DetailPath(targetAccountId);
                if (!GetAccounts().Any(account => account.Id == targetAccountId))
                    return new SwitchResult { Message = "账号不在索引中，请重新导入。" };
                IdeActivity activity = await _readIdeActivity(cancellationToken);
                DateTimeOffset? confirmedAt = null;
                if (activity.NeedsConfirmation)
                {
                    if (confirmRestart == null || !await confirmRestart(activity).WaitAsync(cancellationToken))
                        return new SwitchResult { Cancelled = true, Message = "已取消切换，当前账号和任务保持不变。" };
                    confirmedAt = DateTimeOffset.UtcNow;
                }
                cancellationToken.ThrowIfCancellationRequested();
                // Disk/OAuth continuations must not depend on the WPF dispatcher while holding the account lock.
                return await Task.Run(() => SwitchAccountCoreAsync(targetAccountId, activity, confirmedAt, cancellationToken), cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            { return new SwitchResult { Cancelled = true, Message = "已取消切换。" }; }
            catch (Exception ex) { return new SwitchResult { Message = $"切换失败: {ex.Message}" }; }
            finally { _switchLock.Release(); }
        }

        private async Task<SwitchResult> SwitchAccountCoreAsync(string targetAccountId, IdeActivity approvedActivity,
            DateTimeOffset? confirmedAt, CancellationToken cancellationToken)
        {
            await _accountsLock.WaitAsync(cancellationToken);
            bool accountsLockHeld = true;
            try
            {
            RecoverPendingMutation(); RecoverPendingSwitch();
            string detailPath = DetailPath(targetAccountId);
            if (!File.Exists(detailPath))
            {
                return new SwitchResult { Success = false, Message = $"找不到账号配置: {targetAccountId}" };
            }

            try
            {
                string jsonText = await ReadDetailJsonAsync(detailPath);
                if (string.IsNullOrEmpty(jsonText))
                {
                    return new SwitchResult { Success = false, Message = "账号配置文件为空或无法读取" };
                }
                using var detailDoc = JsonDocument.Parse(jsonText);
                var root = detailDoc.RootElement;
                string email = root.TryGetProperty("email", out var eElem) ? eElem.GetString() ?? "" : "";

                if (!root.TryGetProperty("token", out var tokenElem) || !HasUsableToken(tokenElem))
                {
                    return new SwitchResult { Success = false, Message = "账号配置中缺少有效令牌 (token)" };
                }

                string accessToken = tokenElem.TryGetProperty("access_token", out var atElem) ? atElem.GetString() ?? "" : "";
                string refreshToken = tokenElem.TryGetProperty("refresh_token", out var rtElem) ? rtElem.GetString() ?? "" : "";
                string tokenType = tokenElem.TryGetProperty("token_type", out var ttElem) ? ttElem.GetString() ?? "Bearer" : "Bearer";
                string idToken = tokenElem.TryGetProperty("id_token", out var idtElem) ? idtElem.GetString() ?? "" : "";
                long expiryTimestamp = tokenElem.TryGetProperty("expiry_timestamp", out var expElem) ? expElem.GetInt64() : 0;

                long nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                if ((string.IsNullOrEmpty(accessToken) || expiryTimestamp <= nowSec + 120) && !string.IsNullOrEmpty(refreshToken))
                {
                    Log($"[AccountService] SwitchAccountAsync: Access token for {email} is expiring/missing ({expiryTimestamp - nowSec}s left). Pre-refreshing via OAuth...");
                    var refreshed = await RefreshAccessTokenViaOAuthAsync(refreshToken, cancellationToken);
                    if (!string.IsNullOrEmpty(refreshed.accessToken))
                    {
                        accessToken = refreshed.accessToken;
                        expiryTimestamp = nowSec + refreshed.expiresIn;
                        UpdateAccountTokenCore(targetAccountId, refreshed.accessToken, refreshed.expiresIn, refreshToken);
                        Log($"[AccountService] SwitchAccountAsync: Successfully pre-refreshed token for {email} (new expiry in {refreshed.expiresIn}s)");
                    }
                    else
                    {
                        Log($"[AccountService] SwitchAccountAsync: Pre-refresh failed for {email}, continuing with existing credentials");
                    }
                }

                if (string.IsNullOrWhiteSpace(accessToken) || expiryTimestamp <= nowSec)
                    return new SwitchResult { Success = false, Message = "账号令牌已过期或为空，请重新授权。" };
                if (!GetAccountsCore().Any(a => a.Id == targetAccountId))
                    return new SwitchResult { Success = false, Message = "账号不在索引中，请重新导入。" };

                cancellationToken.ThrowIfCancellationRequested();
                var latestActivity = await _readIdeActivity(cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                if (latestActivity.NeedsConfirmation && (confirmedAt == null ||
                    DateTimeOffset.UtcNow - confirmedAt.Value > TimeSpan.FromSeconds(30) ||
                    latestActivity.Fingerprint != approvedActivity.Fingerprint))
                    return new SwitchResult { Cancelled = true, Message = "任务状态已变化，尚未切换账号。请再次点击切换并确认。" };
                var recovery = new AccountSwitchRecovery { Credential = _credentialStore.Read(),
                    DiskCredentials = File.Exists(_geminiCredsPath) ? await File.ReadAllTextAsync(_geminiCredsPath) : null,
                    AccountIndex = File.Exists(_accountsJsonPath) ? await File.ReadAllTextAsync(_accountsJsonPath) : null };
                await WriteDetailJsonAsync(_switchRecoveryPath, JsonSerializer.Serialize(recovery));

                string expiryIso = DateTimeOffset.FromUnixTimeSeconds(expiryTimestamp).ToString("yyyy-MM-ddTHH:mm:ss.ffffffZ");
                long expiryMs = expiryTimestamp * 1000;

                // 1. Write to Windows Credential Manager: gemini:antigravity
                var keyringData = new
                {
                    token = new
                    {
                        access_token = accessToken,
                        token_type = tokenType,
                        refresh_token = refreshToken,
                        expiry = expiryIso
                    },
                    auth_method = "consumer"
                };

                string keyringJson = JsonSerializer.Serialize(keyringData, JsonOpts.CamelCase);
                bool credWritten = _credentialStore.Write(keyringJson);
                if (!credWritten)
                {
                    throw new IOException("写入 Windows 凭据管理器失败");
                }

                // 2. Write to ~/.gemini/oauth_creds.json (Must remain plaintext JSON for Antigravity IDE)
                var oauthData = new Dictionary<string, object>
                {
                    ["access_token"] = accessToken,
                    ["refresh_token"] = refreshToken,
                    ["token_type"] = tokenType,
                    ["expiry_date"] = expiryMs,
                    ["id_token"] = idToken,
                    ["scope"] = "https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile"
                };

                var geminiDir = Path.GetDirectoryName(_geminiCredsPath);
                if (!string.IsNullOrEmpty(geminiDir) && !Directory.Exists(geminiDir))
                {
                    Directory.CreateDirectory(geminiDir);
                }
                await WriteTextAtomicAsync(_geminiCredsPath, JsonSerializer.Serialize(oauthData, JsonOpts.Indented));

                // Index and external credentials are one serialized operation with a durable recovery record.
                var index = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(_accountsJsonPath))
                    ?? throw new InvalidDataException("账号索引无效");
                index["current_account_id"] = targetAccountId;
                var switchedAt = DateTimeOffset.UtcNow;
                bool requiresRestart = _hasOldIdeProcess(switchedAt);
                index["ide_restart_pending"] = requiresRestart;
                index["ide_restart_pending_since"] = switchedAt.ToString("o");
                await WriteTextAtomicAsync(_accountsJsonPath, index.ToJsonString(JsonOpts.Indented));
                File.Delete(_switchRecoveryPath); // Commit point: after this, a restart failure must not revert credentials.
                // Restart may take seconds. Keep the switch gate, release the committed account transaction
                // so quota/profile reads and the UI remain responsive during process shutdown/startup.
                _accountsLock.Release(); accountsLockHeld = false;
                bool restarted = false;
                string restartMessage;
                {
                    try
                    {
                        await _restartIde(cancellationToken);
                        if (_hasOldIdeProcess(switchedAt)) throw new IOException("旧客户端仍在运行，新账号尚未生效。");
                        restarted = true;
                        requiresRestart = false;
                        restartMessage = "；已重新启动 Antigravity";
                    }
                    catch (Exception ex) { restartMessage = $"；IDE 启动或重启未完成，请手动启动后生效：{ex.Message}"; }
                }

                AccountItem? active = null;
                try { active = GetAccounts().Find(a => a.Id == targetAccountId); }
                catch (Exception ex) { Log($"Committed switch snapshot unavailable: {ex.GetType().Name}"); }

                return new SwitchResult
                {
                    Success = true,
                    Message = $"账号凭据已更新为: {email}{restartMessage}",
                    RequiresIdeRestart = requiresRestart,
                    IdeRestarted = restarted,
                    NewAccount = active
                };
            }
            catch (Exception ex)
            {
                string recoveryMessage = "";
                try { if (accountsLockHeld) RecoverPendingSwitch(); }
                catch (Exception restoreError) { recoveryMessage = $"；自动恢复未完成：{restoreError.Message}"; }
                return new SwitchResult { Success = false, Message = $"切换失败: {ex.Message}{recoveryMessage}" };
            }
                    }
            catch (Exception ex) { return new SwitchResult { Success = false, Message = $"切换失败: {ex.Message}" }; }
            finally { if (accountsLockHeld) _accountsLock.Release(); }
        }

        public async Task<OpResult> ImportFromCurrentLoginAsync()
        {
            try
            {
                var credentials = CurrentLoginCredentials.Read(_credentialStore, _geminiCredsPath, out string readError);
                if (credentials == null) return new OpResult { Success = false, Message = readError };
                string accessToken = credentials.AccessToken;
                string refreshToken = credentials.RefreshToken;
                string tokenType = credentials.TokenType;
                string idToken = credentials.IdToken;
                long expiryTimestamp = credentials.ExpiryTimestamp;

                if (string.IsNullOrWhiteSpace(accessToken) && string.IsNullOrWhiteSpace(refreshToken))
                    return new OpResult { Success = false, Message = "当前凭据中没有可用令牌。" };
                string email = "";
                string name = "";

                if (!string.IsNullOrEmpty(idToken))
                {
                    var parts = idToken.Split('.');
                    if (parts.Length > 1)
                    {
                        try
                        {
                            string b64 = parts[1];
                            b64 += new string('=', (4 - b64.Length % 4) % 4);
                            var payloadBytes = Convert.FromBase64String(b64.Replace('-', '+').Replace('_', '/'));
                            using var jwtDoc = JsonDocument.Parse(payloadBytes);
                            if (jwtDoc.RootElement.TryGetProperty("email", out var eElem)) email = eElem.GetString() ?? "";
                            if (jwtDoc.RootElement.TryGetProperty("name", out var nElem)) name = nElem.GetString() ?? name;
                        }
                        catch { }
                    }
                }

                if (string.IsNullOrEmpty(email))
                {
                    // Some native credentials omit id_token; resolve the same token's profile.
                    JsonElement? profile = string.IsNullOrWhiteSpace(accessToken) ? null :
                        await AccountMetadata.QueryAsync(accessToken, true, CancellationToken.None);
                    if (profile == null && !string.IsNullOrWhiteSpace(refreshToken))
                    {
                        var refreshed = await RefreshAccessTokenViaOAuthAsync(refreshToken);
                        if (!string.IsNullOrWhiteSpace(refreshed.accessToken))
                        {
                            accessToken = refreshed.accessToken;
                            expiryTimestamp = DateTimeOffset.UtcNow.AddSeconds(refreshed.expiresIn).ToUnixTimeSeconds();
                            profile = await AccountMetadata.QueryAsync(accessToken, true, CancellationToken.None);
                        }
                    }
                    if (profile is JsonElement user)
                    {
                        var accountProfile = AccountMetadata.ParseProfile(user);
                        email = accountProfile.Email; name = accountProfile.Name;
                    }
                    if (string.IsNullOrWhiteSpace(email))
                        return new OpResult { Success = false, Message = "已读取登录凭据，但未能取得账号邮箱，请检查网络后重试。" };
                }

                await _accountsLock.WaitAsync();
                try
                {
                    RecoverPendingMutation(); RecoverPendingSwitch();
                    if (!Directory.Exists(_accountsDetailDir)) Directory.CreateDirectory(_accountsDetailDir);

                    string accountsJsonContent = File.Exists(_accountsJsonPath) ? await File.ReadAllTextAsync(_accountsJsonPath) : "{\"version\":\"2.0\",\"accounts\":[],\"current_account_id\":\"\"}";
                    var node = System.Text.Json.Nodes.JsonNode.Parse(accountsJsonContent) ?? new System.Text.Json.Nodes.JsonObject();
                    var accsArray = node["accounts"]?.AsArray();
                    if (accsArray == null)
                    {
                        accsArray = new System.Text.Json.Nodes.JsonArray();
                        node["accounts"] = accsArray;
                    }

                    string targetId = "";
                    foreach (var item in accsArray)
                    {
                        if (item?["email"]?.GetValue<string>()?.Equals(email, StringComparison.OrdinalIgnoreCase) == true)
                        {
                            targetId = item["id"]?.GetValue<string>() ?? "";
                            break;
                        }
                    }

                    long nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                    if (string.IsNullOrEmpty(targetId))
                    {
                        targetId = Guid.NewGuid().ToString();
                        var newAccObj = new System.Text.Json.Nodes.JsonObject
                        {
                            ["id"] = targetId,
                            ["email"] = email,
                            ["name"] = name,
                            ["disabled"] = false,
                            ["proxy_disabled"] = false,
                            ["created_at"] = nowSec,
                            ["last_used"] = nowSec
                        };
                        accsArray.Add(newAccObj);
                    }
                    else
                    {
                        foreach (var item in accsArray)
                        {
                            if (item?["id"]?.GetValue<string>() == targetId)
                            {
                                item["last_used"] = nowSec;
                                if (!string.IsNullOrEmpty(name)) item["name"] = name;
                                break;
                            }
                        }
                    }

                    var detailObj = new
                    {
                        id = targetId,
                        email = email,
                        name = name,
                        token = new
                        {
                            access_token = accessToken,
                            refresh_token = refreshToken,
                            expires_in = 3599,
                            expiry_timestamp = expiryTimestamp,
                            token_type = tokenType,
                            email = email,
                            project_id = "aicode-consumers",
                            oauth_client_key = "antigravity_enterprise",
                            is_gcp_tos = false,
                            id_token = idToken
                        }
                    };

                    string detailPath = DetailPath(targetId);
                    await CommitAccountMutationAsync(targetId, JsonSerializer.Serialize(detailObj, JsonOpts.Indented), node.ToJsonString(JsonOpts.Indented));
                }
                finally
                {
                    _accountsLock.Release();
                }

                return new OpResult { Success = true, Message = $"已成功导入当前账号: {email}" };
            }
            catch (Exception ex)
            {
                return new OpResult { Success = false, Message = $"导入异常: {ex.Message}" };
            }
        }

        public async Task<OpResult> ImportFromJsonFileAsync(string filePath)
        {
            if (!File.Exists(filePath))
            {
                return new OpResult { Success = false, Message = "选择的文件不存在" };
            }

            try
            {
                string content = await File.ReadAllTextAsync(filePath);
                using var doc = JsonDocument.Parse(content);
                var root = doc.RootElement;

                string email = "";
                string name = "";
                string id = Guid.NewGuid().ToString();

                if (root.TryGetProperty("email", out var eElem)) email = eElem.GetString() ?? "";
                if (root.TryGetProperty("name", out var nElem)) name = nElem.GetString() ?? name;
                if (root.TryGetProperty("id", out var iElem))
                {
                    string candidateId = iElem.GetString() ?? "";
                    if (!string.IsNullOrEmpty(candidateId)) id = candidateId;
                }

                if (!root.TryGetProperty("token", out var tokenElem) || !HasUsableToken(tokenElem))
                {
                    return new OpResult { Success = false, Message = "导入失败：JSON 文件中缺少 token 字段" };
                }

                DetailPath(id);

                if (string.IsNullOrEmpty(email) && tokenElem.TryGetProperty("email", out var teElem))
                {
                    email = teElem.GetString() ?? "";
                }

                if (string.IsNullOrEmpty(email) && tokenElem.TryGetProperty("id_token", out var idtElem))
                {
                    string idToken = idtElem.GetString() ?? "";
                    var parts = idToken.Split('.');
                    if (parts.Length > 1)
                    {
                        try
                        {
                            string b64 = parts[1];
                            b64 += new string('=', (4 - b64.Length % 4) % 4);
                            var payloadBytes = Convert.FromBase64String(b64.Replace('-', '+').Replace('_', '/'));
                            using var jwtDoc = JsonDocument.Parse(payloadBytes);
                            if (jwtDoc.RootElement.TryGetProperty("email", out var jwtEmail)) email = jwtEmail.GetString() ?? "";
                            if (jwtDoc.RootElement.TryGetProperty("name", out var jwtName)) name = jwtName.GetString() ?? name;
                        }
                        catch { }
                    }
                }

                if (!System.Net.Mail.MailAddress.TryCreate(email, out var parsedEmail) ||
                    !string.Equals(parsedEmail.Address, email, StringComparison.OrdinalIgnoreCase))
                    return new OpResult { Success = false, Message = "导入失败：邮箱地址无效。" };

                await _accountsLock.WaitAsync();
                try
                {
                    RecoverPendingMutation(); RecoverPendingSwitch();
                    if (!Directory.Exists(_accountsDetailDir)) Directory.CreateDirectory(_accountsDetailDir);

                    string accountsJsonContent = File.Exists(_accountsJsonPath) ? await File.ReadAllTextAsync(_accountsJsonPath) : "{\"version\":\"2.0\",\"accounts\":[],\"current_account_id\":\"\"}";
                    var node = System.Text.Json.Nodes.JsonNode.Parse(accountsJsonContent) ?? new System.Text.Json.Nodes.JsonObject();
                    var accsArray = node["accounts"]?.AsArray();
                    if (accsArray == null)
                    {
                        accsArray = new System.Text.Json.Nodes.JsonArray();
                        node["accounts"] = accsArray;
                    }

                    string existingId = "";
                    foreach (var item in accsArray)
                    {
                        if (item?["email"]?.GetValue<string>()?.Equals(email, StringComparison.OrdinalIgnoreCase) == true)
                        {
                            existingId = item["id"]?.GetValue<string>() ?? "";
                            break;
                        }
                    }

                    long nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                    if (string.IsNullOrEmpty(existingId) && (File.Exists(DetailPath(id)) || accsArray.Any(item => string.Equals(item?["id"]?.GetValue<string>(), id, StringComparison.OrdinalIgnoreCase))))
                        id = Guid.NewGuid().ToString();
                    string finalId = !string.IsNullOrEmpty(existingId) ? existingId : id;

                    if (string.IsNullOrEmpty(existingId))
                    {
                        var newAccObj = new System.Text.Json.Nodes.JsonObject
                        {
                            ["id"] = finalId,
                            ["email"] = email,
                            ["name"] = name,
                            ["disabled"] = false,
                            ["proxy_disabled"] = false,
                            ["created_at"] = nowSec,
                            ["last_used"] = nowSec
                        };
                        accsArray.Add(newAccObj);
                    }

                    string detailPath = DetailPath(finalId);
                    var importedNode = System.Text.Json.Nodes.JsonNode.Parse(content)!;
                    importedNode["id"] = finalId; importedNode["email"] = email; importedNode["name"] = name;
                    await CommitAccountMutationAsync(finalId, importedNode.ToJsonString(JsonOpts.Indented), node.ToJsonString(JsonOpts.Indented));
                }
                finally
                {
                    _accountsLock.Release();
                }

                return new OpResult { Success = true, Message = $"已成功导入账号: {email}" };
            }
            catch (Exception ex)
            {
                return new OpResult { Success = false, Message = $"导入失败: {ex.Message}" };
            }
        }

        public async Task<OpResult> DeleteAccountAsync(string accountId)
        {
            try
            {
                DetailPath(accountId);
                await _accountsLock.WaitAsync();
                try
                {
                    RecoverPendingMutation(); RecoverPendingSwitch();
                    if (!File.Exists(_accountsJsonPath))
                    {
                        return new OpResult { Success = false, Message = "账号配置文件不存在" };
                    }

                    string accountsJsonContent = await File.ReadAllTextAsync(_accountsJsonPath);
                    var node = System.Text.Json.Nodes.JsonNode.Parse(accountsJsonContent);
                    if (node == null) return new OpResult { Success = false, Message = "无法解析账号配置" };

                    string currentId = node["current_account_id"]?.GetValue<string>() ?? "";
                    if (currentId == accountId)
                    {
                        return new OpResult { Success = false, Message = "无法删除当前正在使用的活跃账号" };
                    }

                    var accsArray = node["accounts"]?.AsArray();
                    bool found = false;
                    if (accsArray != null)
                    {
                        for (int i = accsArray.Count - 1; i >= 0; i--)
                        {
                            if (accsArray[i]?["id"]?.GetValue<string>() == accountId)
                            { accsArray.RemoveAt(i); found = true; break; }
                        }
                    }
                    if (!found) return new OpResult { Success = false, Message = "账号不存在。" };
                    await CommitAccountMutationAsync(accountId, null, node.ToJsonString(JsonOpts.Indented));
                }
                finally
                {
                    _accountsLock.Release();
                }

                return new OpResult { Success = true, Message = "账号已成功删除" };
            }
            catch (Exception ex)
            {
                return new OpResult { Success = false, Message = $"删除失败: {ex.Message}" };
            }
        }

        private static bool HasUsableToken(JsonElement token)
        {
            if (token.ValueKind != JsonValueKind.Object) return false;
            return new[] { "access_token", "refresh_token" }.Any(key =>
                token.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()));
        }

        public OAuthStartResult PrepareGoogleOAuth()
        {
            CancelGoogleOAuth();
            try
            {
                var tcp = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
                tcp.Start();
                int port = ((System.Net.IPEndPoint)tcp.LocalEndpoint).Port;
                tcp.Stop();

                string listenerPrefix = $"http://127.0.0.1:{port}/";
                string redirectUri = $"http://127.0.0.1:{port}/oauth-callback";
                _currentOauthRedirectUri = redirectUri;

                _oauthListener = new System.Net.HttpListener();
                _oauthListener.Prefixes.Add(listenerPrefix);
                _oauthListener.Start();

                string state = Guid.NewGuid().ToString("N");
                _currentOauthState = state;
                _oauthExpiresAt = DateTimeOffset.UtcNow.AddSeconds(120);
                Interlocked.Exchange(ref _oauthClaimed, 0);
                string encodedRedirect = Uri.EscapeDataString(redirectUri);
                string scopes = Uri.EscapeDataString("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs");
                string authUrl = $"https://accounts.google.com/o/oauth2/v2/auth?client_id={OAUTH_CLIENT_ID}&redirect_uri={encodedRedirect}&response_type=code&scope={scopes}&access_type=offline&prompt=consent&include_granted_scopes=true&state={state}";

                _oauthCts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(120));

                _ = ListenForOAuthCallbackAsync(_oauthListener, _oauthCts.Token, port, state, redirectUri, _oauthGeneration);

                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = authUrl,
                        UseShellExecute = true
                    });
                }
                catch { }

                return new OAuthStartResult
                {
                    Success = true,
                    AuthUrl = authUrl,
                    Message = "已打开浏览器进行 Google 授权"
                };
            }
            catch (Exception ex)
            {
                CancelGoogleOAuth();
                return new OAuthStartResult
                {
                    Success = false,
                    Message = $"启动本地监听服务失败: {ex.Message}"
                };
            }
        }

        private async Task ListenForOAuthCallbackAsync(System.Net.HttpListener listener, CancellationToken token, int port, string state, string redirectUri, int generation)
        {
            try
            {
                while (!token.IsCancellationRequested)
                {
                    var context = await listener.GetContextAsync().WaitAsync(token);
                    string code;
                    try { code = OAuthCallback.Parse(context.Request.Url!.AbsoluteUri, redirectUri, state); }
                    catch (OAuthRejectedException ex)
                    {
                        await RespondToOAuthAsync(context.Response, ex.Message, 400);
                        if (generation == _oauthGeneration) OnOAuthCompleted?.Invoke(new OpResult { Success = false, Message = ex.Message });
                        return;
                    }
                    catch (ArgumentException ex)
                    {
                        await RespondToOAuthAsync(context.Response, ex.Message, 400);
                        // Invalid or unrelated requests cannot consume a pending authorization.
                        continue;
                    }
                    if (Interlocked.CompareExchange(ref _oauthClaimed, 1, 0) != 0)
                    {
                        await RespondToOAuthAsync(context.Response, "授权正在处理，请返回应用查看结果。", 409);
                        return;
                    }
                    await RespondToOAuthAsync(context.Response, "已收到授权回调，正在验证并保存账号。请返回 AntigravityHub 查看最终结果。", 200);
                    var result = await ExchangeCodeAndSaveAccountAsync(code, redirectUri, token);
                    if (generation == _oauthGeneration) OnOAuthCompleted?.Invoke(result);
                    return;
                }
            }
            catch (OperationCanceledException)
            {
                if (generation == _oauthGeneration)
                    OnOAuthCompleted?.Invoke(new OpResult { Success = false, Message = "授权已超时，请重新开始。" });
            }
            catch (Exception)
            {
                if (generation == _oauthGeneration && !token.IsCancellationRequested && Volatile.Read(ref _oauthClaimed) == 0)
                    OnOAuthCompleted?.Invoke(new OpResult { Success = false, Message = "本地授权监听未完成，请重试或粘贴本次回调链接。" });
            }
            finally { try { listener.Close(); } catch { } }
        }

        private static async Task RespondToOAuthAsync(System.Net.HttpListenerResponse response, string message, int status)
        {
            byte[] bytes = Encoding.UTF8.GetBytes("<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>AntigravityHub 授权</title><body><h2>AntigravityHub</h2><p>" + System.Net.WebUtility.HtmlEncode(message) + "</p></body></html>");
            response.StatusCode = status;
            response.ContentType = "text/html; charset=utf-8";
            response.Headers["Cache-Control"] = "no-store";
            response.Headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
            response.ContentLength64 = bytes.Length;
            try { await response.OutputStream.WriteAsync(bytes); } finally { response.Close(); }
        }

        public void CancelGoogleOAuth()
        {
            Interlocked.Increment(ref _oauthGeneration);
            _currentOauthState = null;
            _currentOauthRedirectUri = null;
            try
            {
                _oauthCts?.Cancel();
                _oauthCts?.Dispose();
                _oauthCts = null;
            }
            catch { }

            try
            {
                _oauthListener?.Stop();
                _oauthListener?.Close();
                _oauthListener = null;
            }
            catch { }
        }

        public async Task<OpResult> SubmitManualAuthCodeAsync(string codeOrUrl)
        {
            if (_currentOauthRedirectUri == null || _currentOauthState == null || _oauthCts == null || DateTimeOffset.UtcNow >= _oauthExpiresAt)
                return new OpResult { Success = false, Message = "请先开始新的 Google 授权，再粘贴本次回调链接或授权码。" };
            string code;
            try { code = OAuthCallback.Parse(codeOrUrl, _currentOauthRedirectUri, _currentOauthState); }
            catch (ArgumentException ex) { return new OpResult { Success = false, Message = ex.Message }; }
            if (Interlocked.CompareExchange(ref _oauthClaimed, 1, 0) != 0)
                return new OpResult { Success = false, Message = "本次授权已经在处理，请勿重复提交。" };
            // Closing the listener avoids a duplicate callback without cancelling token exchange.
            try { _oauthListener?.Close(); } catch { }
            return await ExchangeCodeAndSaveAccountAsync(code, _currentOauthRedirectUri, _oauthCts.Token);
        }

        public async Task<OpResult> ExchangeCodeAndSaveAccountAsync(string code, string redirectUri, CancellationToken cancellationToken = default)
        {
            try
            {
                using var tokenReq = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token")
                {
                    Content = new FormUrlEncodedContent(new Dictionary<string, string>
                    {
                        ["client_id"] = OAUTH_CLIENT_ID,
                        ["client_secret"] = OAUTH_CLIENT_SECRET,
                        ["code"] = code,
                        ["grant_type"] = "authorization_code",
                        ["redirect_uri"] = redirectUri
                    })
                };
                tokenReq.Headers.UserAgent.ParseAdd("AntigravityHub/1.0");

                using var tokenCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); tokenCts.CancelAfter(TimeSpan.FromSeconds(10));
                using var tokenResp = await _httpClient.SendAsync(tokenReq, tokenCts.Token);
                string tokenRespJson = await tokenResp.Content.ReadAsStringAsync(tokenCts.Token);
                if (!tokenResp.IsSuccessStatusCode)
                {
                    return new OpResult { Success = false, Message = $"换取授权凭据失败（HTTP {(int)tokenResp.StatusCode}），请重新授权。" };
                }

                using var tokenDoc = JsonDocument.Parse(tokenRespJson);
                var tRoot = tokenDoc.RootElement;
                string accessToken = tRoot.TryGetProperty("access_token", out var atElem) ? atElem.GetString() ?? "" : "";
                string refreshToken = tRoot.TryGetProperty("refresh_token", out var rtElem) ? rtElem.GetString() ?? "" : "";
                string idToken = tRoot.TryGetProperty("id_token", out var idtElem) ? idtElem.GetString() ?? "" : "";
                int expiresIn = tRoot.TryGetProperty("expires_in", out var expElem) ? expElem.GetInt32() : 3599;

                if (string.IsNullOrEmpty(refreshToken))
                {
                    return new OpResult { Success = false, Message = "Google 未返回 Refresh Token（该账号可能此前已授权，请在 Google 账号安全设置中撤销授权后重试）" };
                }

                string email = "";
                string name = "";

                if (!string.IsNullOrEmpty(idToken))
                {
                    var parts = idToken.Split('.');
                    if (parts.Length > 1)
                    {
                        try
                        {
                            string b64 = parts[1];
                            b64 += new string('=', (4 - b64.Length % 4) % 4);
                            var payloadBytes = Convert.FromBase64String(b64.Replace('-', '+').Replace('_', '/'));
                            using var jwtDoc = JsonDocument.Parse(payloadBytes);
                            if (jwtDoc.RootElement.TryGetProperty("email", out var eElem)) email = eElem.GetString() ?? "";
                            if (jwtDoc.RootElement.TryGetProperty("name", out var nElem)) name = nElem.GetString() ?? name;
                        }
                        catch { }
                    }
                }

                if (string.IsNullOrEmpty(email) && !string.IsNullOrEmpty(accessToken))
                {
                    try
                    {
                        using var userReq = new HttpRequestMessage(HttpMethod.Get, "https://www.googleapis.com/oauth2/v2/userinfo");
                        userReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                        using var userCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); userCts.CancelAfter(TimeSpan.FromSeconds(8));
                        using var userResp = await _httpClient.SendAsync(userReq, userCts.Token);
                        if (userResp.IsSuccessStatusCode)
                        {
                            using var uDoc = JsonDocument.Parse(await userResp.Content.ReadAsStringAsync(userCts.Token));
                            if (uDoc.RootElement.TryGetProperty("email", out var ueElem)) email = ueElem.GetString() ?? "";
                            if (uDoc.RootElement.TryGetProperty("name", out var unElem)) name = unElem.GetString() ?? name;
                        }
                    }
                    catch { }
                }

                if (string.IsNullOrEmpty(email))
                {
                    return new OpResult { Success = false, Message = "无法从 Google 凭据中解析出有效邮箱" };
                }

                cancellationToken.ThrowIfCancellationRequested();
                await _accountsLock.WaitAsync(cancellationToken);
                try
                {
                    RecoverPendingMutation(); RecoverPendingSwitch();
                    if (!Directory.Exists(_accountsDetailDir)) Directory.CreateDirectory(_accountsDetailDir);

                    string accountsJsonContent = File.Exists(_accountsJsonPath) ? await File.ReadAllTextAsync(_accountsJsonPath) : "{\"version\":\"2.0\",\"accounts\":[],\"current_account_id\":\"\"}";
                    var node = System.Text.Json.Nodes.JsonNode.Parse(accountsJsonContent) ?? new System.Text.Json.Nodes.JsonObject();
                    var accsArray = node["accounts"]?.AsArray();
                    if (accsArray == null)
                    {
                        accsArray = new System.Text.Json.Nodes.JsonArray();
                        node["accounts"] = accsArray;
                    }

                    string targetId = "";
                    foreach (var item in accsArray)
                    {
                        if (item?["email"]?.GetValue<string>()?.Equals(email, StringComparison.OrdinalIgnoreCase) == true)
                        {
                            targetId = item["id"]?.GetValue<string>() ?? "";
                            break;
                        }
                    }

                    long nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                    bool isNew = string.IsNullOrEmpty(targetId);
                    if (isNew)
                    {
                        targetId = Guid.NewGuid().ToString();
                        var newAccObj = new System.Text.Json.Nodes.JsonObject
                        {
                            ["id"] = targetId,
                            ["email"] = email,
                            ["name"] = name,
                            ["disabled"] = false,
                            ["proxy_disabled"] = false,
                            ["created_at"] = nowSec,
                            ["last_used"] = nowSec
                        };
                        accsArray.Add(newAccObj);
                    }
                    else
                    {
                        foreach (var item in accsArray)
                        {
                            if (item?["id"]?.GetValue<string>() == targetId)
                            {
                                item["last_used"] = nowSec;
                                if (!string.IsNullOrEmpty(name)) item["name"] = name;
                                break;
                            }
                        }
                    }

                    var detailObj = new
                    {
                        id = targetId,
                        email = email,
                        name = name,
                        token = new
                        {
                            access_token = accessToken,
                            refresh_token = refreshToken,
                            expires_in = expiresIn,
                            expiry_timestamp = nowSec + expiresIn,
                            token_type = "Bearer",
                            email = email,
                            project_id = "aicode-consumers",
                            oauth_client_key = "antigravity_enterprise",
                            is_gcp_tos = false,
                            id_token = idToken
                        }
                    };

                    string detailPath = DetailPath(targetId);
                    await CommitAccountMutationAsync(targetId, JsonSerializer.Serialize(detailObj, JsonOpts.Indented), node.ToJsonString(JsonOpts.Indented));

                    return new OpResult
                    {
                        Success = true,
                        Message = isNew ? $"已成功添加 Google 账号: {email}" : $"已成功更新 Google 账号凭据: {email}"
                    };
                }
                finally
                {
                    _accountsLock.Release();
                }
            }
            catch (OperationCanceledException)
            {
                return new OpResult { Success = false, Message = "授权已取消或超时，请重新开始。" };
            }
            catch (Exception)
            {
                return new OpResult { Success = false, Message = "授权处理失败，账号未添加，请重试。" };
            }
        }

        public ClientStatus GetClientStatus()
        {
            var status = new ClientStatus();
            try
            {
                var procs = Process.GetProcessesByName("Antigravity");
                if (procs.Length > 0)
                {
                    status.IsRunning = true;
                    status.Pid = procs[0].Id;
                    status.StatusText = $"Antigravity 客户端运行中 (PID: {status.Pid})";
                }
                else
                {
                    status.IsRunning = false;
                    status.StatusText = "未检测到运行中的 Antigravity 客户端";
                }
                var credentials = CurrentLoginCredentials.Read(_credentialStore, _geminiCredsPath, out string readError);
                status.CredsFound = credentials != null;
                status.StatusText += status.CredsFound ? " · 登录凭据可读取" : " · " + readError;
            }
            catch (Exception ex)
            {
                status.StatusText = $"检测失败: {ex.Message}";
            }
            return status;
        }
    }

    public class ClientStatus
    {
        public bool IsRunning { get; set; }
        public int Pid { get; set; }
        public bool CredsFound { get; set; }
        public string StatusText { get; set; } = "";
    }

    public class OAuthStartResult
    {
        public bool Success { get; set; }
        public string AuthUrl { get; set; } = "";
        public string Message { get; set; } = "";
    }
}

