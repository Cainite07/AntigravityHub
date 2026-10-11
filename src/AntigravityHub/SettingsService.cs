using System;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;
using System.Text;
using Microsoft.Win32;

namespace AntigravityHub
{
    public class SettingsService
    {
        private readonly string _settingsPath;
        private AppSettings _settings;
        private readonly object _settingsLock = new();
        private static readonly HttpClient _httpClient = new() { Timeout = TimeSpan.FromSeconds(3.5) };

        public SettingsService()
        {
            HubStorage.EnsureInitialized();
            _settingsPath = Path.Combine(HubStorage.HubDir, "app_settings.json");
            _settings = LoadSettings();
        }

        public AppSettings GetSettings()
        {
            lock (_settingsLock) return Copy(_settings);
        }

        private AppSettings LoadSettings()
        {
            try
            {
                if (File.Exists(_settingsPath))
                {
                    string json = File.ReadAllText(_settingsPath);
                    var s = JsonSerializer.Deserialize<AppSettings>(json);
                    if (s != null)
                    {
                        Validate(s);
                        // Replace the previous trial's unused preset with the upstream default.
                        // Retain explicitly enabled custom dimensions and all existing tray choices.
                        if (!s.EnableClientWindowSize && s.ClientWindowWidth == 1475 && s.ClientWindowHeight == 875)
                        {
                            s.ClientWindowWidth = 1400;
                            s.ClientWindowHeight = 900;
                            SaveSettingsInternal(s);
                        }
                        return s;
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[SettingsService] Load error: {ex.Message}");
                if (File.Exists(_settingsPath)) File.Copy(_settingsPath, _settingsPath + ".invalid." + Guid.NewGuid().ToString("N") + ".bak");
            }

            var defaultSettings = new AppSettings();
            SaveSettingsInternal(defaultSettings);
            return defaultSettings;
        }

        private static AppSettings Copy(AppSettings settings) =>
            JsonSerializer.Deserialize<AppSettings>(JsonSerializer.Serialize(settings))!;

        private static void Validate(AppSettings settings)
        {
            if (settings.Theme is not ("system" or "light" or "dark")) throw new ArgumentException("无效主题。");
            if (settings.Currency != "USD" && settings.Currency != "CNY") throw new ArgumentException("仅支持 USD 或 CNY 币种。");
            if (!double.IsFinite(settings.LiveUsdToCnyRate) || settings.LiveUsdToCnyRate <= 0 || settings.LiveUsdToCnyRate > 1000)
                throw new ArgumentException("汇率必须是有效正数。");
            if (settings.ClientWindowWidth < 640 || settings.ClientWindowWidth > 7680 ||
                settings.ClientWindowHeight < 480 || settings.ClientWindowHeight > 4320)
                throw new ArgumentException("客户端窗口宽度须为 640–7680，高度须为 480–4320。");
            settings.PollIntervalSeconds = Math.Clamp(settings.PollIntervalSeconds, 10, 300);
            settings.GlobalHotkey ??= "";
            if (settings.GlobalHotkey.Length > 64) throw new ArgumentException("快捷键配置过长。");
        }

        public void SaveSettings(AppSettings newSettings)
        {
            var next = Copy(newSettings); Validate(next);
            lock (_settingsLock)
            {
                var previous = _settings;
                SaveSettingsInternal(next);
                try
                {
                    if (next.LaunchOnStartup != previous.LaunchOnStartup) ApplyStartupRegistry(next.LaunchOnStartup);
                }
                catch { SaveSettingsInternal(previous); throw; }
                _settings = next;
            }
        }

        private void SaveSettingsInternal(AppSettings settings) =>
            AtomicFile.WriteBytes(_settingsPath, Encoding.UTF8.GetBytes(JsonSerializer.Serialize(settings, JsonOpts.Indented)));

        public void ApplyStartupRegistry(bool enable)
        {
            try
            {
                const string runKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
                const string appName = "AntigravityHub";
                using var key = Registry.CurrentUser.CreateSubKey(runKey, true);
                if (key != null)
                {
                    if (enable)
                    {
                        string exePath = Environment.ProcessPath ?? "";
                        if (!string.IsNullOrEmpty(exePath))
                        {
                            key.SetValue(appName, $"\"{exePath}\"");
                        }
                    }
                    else
                    {
                        if (key.GetValue(appName) != null)
                        {
                            key.DeleteValue(appName, false);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                throw new IOException("无法更新开机启动配置。", ex);
            }
        }

        public async Task<double> FetchLiveRateAsync(CancellationToken cancellationToken = default)
        {
            var response = await _httpClient.GetStringAsync("https://open.er-api.com/v6/latest/USD", cancellationToken);
            using var doc = JsonDocument.Parse(response);
            if (!doc.RootElement.TryGetProperty("rates", out var rates) || !rates.TryGetProperty("CNY", out var cny) ||
                !cny.TryGetDouble(out double rate) || !double.IsFinite(rate) || rate <= 0 || rate > 1000)
                throw new InvalidDataException("汇率服务未返回有效的 CNY 汇率，已保留旧值。");
            lock (_settingsLock)
            {
                var next = Copy(_settings);
                next.LiveUsdToCnyRate = Math.Round(rate, 4);
                next.LastRateFetchTime = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                SaveSettingsInternal(next); _settings = next;
                return next.LiveUsdToCnyRate;
            }
        }
    }
}
