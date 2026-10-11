using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;

namespace AntigravityHub
{
    public partial class MainWindow : Window
    {
        private readonly AccountService _accountService;
        private readonly SettingsService _settingsService;
        private readonly HubUpdateService _hubUpdates;
        private bool _updateNotified;
        private readonly TokenStatsService _tokenStatsService;
        private readonly GlobalHotkeyService _hotkeyService;
        private TrayService? _trayService;
        private TrayPopupWindow? _trayPopupWindow;
        private bool _isExplicitExit = false;
        private readonly System.Threading.CancellationTokenSource _appCts = new();
        private readonly RefreshCoordinator _refreshCoordinator = new();
        private bool _switchRequestPending;
        private bool _clientRestartPending;
        private bool _webInitialized;
        private int _rendererVisibilityGeneration;
        private System.Windows.Threading.DispatcherTimer? _windowSaveTimer;
        private void ScheduleWindowSave()
        {
            if (!IsLoaded || WindowState != WindowState.Normal) return;
            if (_windowSaveTimer == null)
            {
                _windowSaveTimer = new() { Interval = TimeSpan.FromMilliseconds(350) };
                _windowSaveTimer.Tick += (_,_) => { _windowSaveTimer.Stop(); SaveWindowState(); };
            }
            _windowSaveTimer.Stop(); _windowSaveTimer.Start();
        }
        private async void UpdateRendererVisibility()
        {
            int generation = ++_rendererVisibilityGeneration;
            var core = webView.CoreWebView2;
            if (core == null || _isExplicitExit) return;
            bool visible = IsVisible && WindowState != WindowState.Minimized;
            try
            {
                if (visible) { core.Resume(); webView.Visibility = Visibility.Visible; Log("Renderer resumed"); return; }
                webView.Visibility = Visibility.Hidden;
                await Task.Delay(800, _appCts.Token);
                if (generation == _rendererVisibilityGeneration && (!IsVisible || WindowState == WindowState.Minimized))
                    Log($"Renderer suspended: {await core.TrySuspendAsync()}");
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log($"Renderer visibility: {ex.GetType().Name}"); }
        }
        private readonly HudPipeServer _hud = new();
        private TokenSummary? _latestHudStats;
        private void SystemThemeChanged(object sender, Microsoft.Win32.UserPreferenceChangedEventArgs e) => Dispatcher.BeginInvoke(new Action(ApplyTheme));
        public bool StartMinimized => _settingsService.GetSettings().StartMinimized;
        private void ApplyTheme()
        {
            bool dark = ThemePalette.IsDark(_settingsService.GetSettings().Theme);
            var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(dark ? "#191B1E" : "#F7F5EE");
            Background = rootGrid.Background = new System.Windows.Media.SolidColorBrush(color);
            webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(color.R,color.G,color.B);
            ThemePalette.Frame(this,dark);
            if (_trayPopupWindow != null) ThemePalette.Tree(_trayPopupWindow,dark);
        }
        public bool CloseToTray { get; set; } = true;

        private const int WM_SHOWWINDOW = 0x0018;

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern uint RegisterWindowMessage(string lpString);

        private static readonly uint WM_SHOW_ANTIGRAVITY_HUB = RegisterWindowMessage("AntigravityHub_Show_Instance");

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ChangeWindowMessageFilter(uint message, uint dwFlag);
        private const uint MSGFLT_ADD = 1;

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern IntPtr LoadImage(IntPtr hinst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        private const int GWL_STYLE = -16;
        private const int WS_MINIMIZEBOX = 0x00020000;
        private const int WS_MAXIMIZEBOX = 0x00010000;
        private const int WS_SYSMENU = 0x00080000;
        private const int WS_THICKFRAME = 0x00040000;
        private const int WM_SYSCOMMAND = 0x0112;
        private const int SC_MINIMIZE = 0xF020;
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HT_CAPTION = 0x2;
        private const int HTLEFT = 10;
        private const int HTRIGHT = 11;
        private const int HTTOP = 12;
        private const int HTTOPLEFT = 13;
        private const int HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15;
        private const int HTBOTTOMLEFT = 16;
        private const int HTBOTTOMRIGHT = 17;
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWCP_ROUND = 2;
        private const uint IMAGE_ICON = 1;
        private const uint LR_LOADFROMFILE = 0x0010;
        private const uint LR_DEFAULTSIZE = 0x0040;

        private static void Log(string msg) => Logger.Log("MainWindow", msg);

        private class WindowStateModel
        {
            public double Left { get; set; }
            public double Top { get; set; }
            public double Width { get; set; }
            public double Height { get; set; }
            public WindowState State { get; set; } = WindowState.Normal;
        }

        private static string WindowStateFilePath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AntigravityHub", "window_state.json");

        private void RestoreWindowState()
        {
            try
            {
                string path = WindowStateFilePath;
                if (File.Exists(path))
                {
                    string json = File.ReadAllText(path);
                    var state = JsonSerializer.Deserialize<WindowStateModel>(json);
                    if (state != null && state.Width >= MinWidth && state.Height >= MinHeight && state.Left > -10000 && state.Top > -10000)
                    {
                        double screenLeft = SystemParameters.VirtualScreenLeft;
                        double screenTop = SystemParameters.VirtualScreenTop;
                        double screenRight = screenLeft + SystemParameters.VirtualScreenWidth;
                        double screenBottom = screenTop + SystemParameters.VirtualScreenHeight;

                        if (state.Left >= screenLeft - 20 && state.Left + 100 < screenRight &&
                            state.Top >= screenTop - 20 && state.Top + 100 < screenBottom)
                        {
                            WindowStartupLocation = WindowStartupLocation.Manual;
                            Left = state.Left;
                            Top = state.Top;
                            Width = state.Width;
                            Height = state.Height;
                            Log($"WindowState restored: {Width}x{Height} at ({Left}, {Top}), State={state.State}");
                            if (state.State == WindowState.Maximized)
                            {
                                WindowState = WindowState.Maximized;
                            }
                            return;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"RestoreWindowState error: {ex.Message}");
            }

            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }

        private void SaveWindowState()
        {
            try
            {
                if (!IsLoaded) return;
                if (WindowState == WindowState.Minimized) return;

                var state = new WindowStateModel
                {
                    State = WindowState,
                    Left = WindowState == WindowState.Normal ? Left : RestoreBounds.Left,
                    Top = WindowState == WindowState.Normal ? Top : RestoreBounds.Top,
                    Width = WindowState == WindowState.Normal ? Width : RestoreBounds.Width,
                    Height = WindowState == WindowState.Normal ? Height : RestoreBounds.Height
                };

                if (state.Width < MinWidth || state.Height < MinHeight) return;
                if (double.IsNaN(state.Left) || double.IsNaN(state.Top) || state.Left < -10000 || state.Top < -10000) return;

                string dir = Path.GetDirectoryName(WindowStateFilePath)!;
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                File.WriteAllText(WindowStateFilePath, JsonSerializer.Serialize(state, JsonOpts.Indented));
                Log($"WindowState saved: {state.Width}x{state.Height} at ({state.Left}, {state.Top}), State={state.State}");
            }
            catch (Exception ex)
            {
                Log($"SaveWindowState error: {ex.Message}");
            }
        }

        public MainWindow()
        {
            InitializeComponent();
            RestoreWindowState();
            Log("Constructor initialized.");

            try
            {
                string icoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                if (File.Exists(icoPath))
                {
                    IntPtr hIcon = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
                    if (hIcon != IntPtr.Zero)
                    {
                        Icon = Imaging.CreateBitmapSourceFromHIcon(hIcon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                        if (Icon.CanFreeze) Icon.Freeze();
                        DestroyIcon(hIcon);
                        Log("Native Window Icon loaded successfully via Win32 LoadImage.");
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"Icon load ignored: {ex.Message}");
            }

            _accountService = new AccountService();
            _accountService.OnOAuthCompleted += (opResult) =>
            {
                Dispatcher.Invoke(async () =>
                {
                    var resp = new
                    {
                        type = "oauthCompleted",
                        data = opResult
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));
                    if (opResult.Success)
                    {
                        await SendHubDataAsync();
                    }
                });
            };
            _settingsService = new SettingsService();
            _hubUpdates = new HubUpdateService(AppContext.BaseDirectory);
            if (HubUpdateInstaller.StartupFailed) _hubUpdates.ReportRollback();
            _hubUpdates.Changed += status => Dispatcher.BeginInvoke(new Action(() =>
            {
                if (_isExplicitExit) return;
                SendHubUpdateStatus();
                if (status.State == "available" && !_updateNotified)
                {
                    _updateNotified = true;
                    if (!IsVisible || WindowState == WindowState.Minimized) _trayService?.ShowUpdateAvailable(status.LatestVersion);
                }
            }));
            _tokenStatsService = new TokenStatsService(_settingsService);
            _hotkeyService = new GlobalHotkeyService();
            var initialSettings = _settingsService.GetSettings();
            CloseToTray = initialSettings.CloseToTray;
            Loaded += MainWindow_Loaded;

            _trayPopupWindow = new TrayPopupWindow(this);
            _trayPopupWindow.Loaded += (_,_) => ApplyTheme();
            _trayService = new TrayService(
                onRestoreWindow: () => RestoreAndActivateWindow(),
                onShowTrayPopup: (pt) => Dispatcher.Invoke(() => _trayPopupWindow?.ShowNearCursor(pt))
            );

            Closing += MainWindow_Closing;
            LocationChanged += (s, e) => ScheduleWindowSave();
            SizeChanged += (s, e) => ScheduleWindowSave();
            IsVisibleChanged += (_,_) => UpdateRendererVisibility();
            StateChanged += (s, e) =>
            {
                UpdateRendererVisibility();
                if (_isModalOpen)
                {
                    UpdateWindowLayoutForModal(true);
                }
                else
                {
                    if (WindowState == WindowState.Maximized)
                    {
                        webView.Margin = new Thickness(0);
                        try
                        {
                            webView.CoreWebView2?.PostWebMessageAsJson("{\"type\":\"windowMaximized\"}");
                        }
                        catch { }
                    }
                    else if (WindowState == WindowState.Normal)
                    {
                        webView.Margin = new Thickness(0);
                        try
                        {
                            webView.CoreWebView2?.PostWebMessageAsJson("{\"type\":\"windowRestored\"}");
                        }
                        catch { }
                    }
                }
                if (IsLoaded && WindowState != WindowState.Minimized) SaveWindowState();
            };
            Closed += (s, e) => Log("MainWindow Closed event fired.");
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            try
            {
                var hwnd = new WindowInteropHelper(this).Handle;
                int style = GetWindowLong(hwnd, GWL_STYLE);
                SetWindowLong(hwnd, GWL_STYLE, style | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_THICKFRAME);
                Log("WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_SYSMENU, WS_THICKFRAME applied to GWL_STYLE.");

                int preference = DWMWCP_ROUND;
                DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
                Log("DWM rounded corners applied.");

                HwndSource.FromHwnd(hwnd)?.AddHook(WndProc);
                try
                {
                    ChangeWindowMessageFilter(WM_SHOW_ANTIGRAVITY_HUB, MSGFLT_ADD);
                }
                catch { }
            }
            catch (Exception ex)
            {
                Log($"DWM error: {ex.Message}");
            }

            ApplyTheme();
        }

        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
        {
            if (_webInitialized) return;
            _webInitialized = true;
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string baseDir = Path.Combine(localAppData, "AntigravityHub");
                if (!Directory.Exists(baseDir)) Directory.CreateDirectory(baseDir);

                CleanOrphanedWebViewSessions(baseDir);

                string primaryFolder = Path.Combine(baseDir, "WebView2Data");
                bool initialized = false;

                // 第一梯队：尝试共享主目录
                try
                {
                    Log($"Attempting primary userDataFolder: {primaryFolder}");
                    var env = await CoreWebView2Environment.CreateAsync(null, primaryFolder);
                    await webView.EnsureCoreWebView2Async(env);
                    initialized = true;
                    Log("EnsureCoreWebView2Async succeeded on primary folder.");
                }
                catch (Exception pEx)
                {
                    Log($"Primary EnsureCoreWebView2Async failed (e.g. 0x800700AA in use): {pEx.Message}. Seamlessly falling back to session folder...");
                }

                // 第二梯队：若主目录被其它实例/残留进程独占锁定，无缝自动降级到当前 PID 专属目录，彻底杜绝弹窗
                if (!initialized)
                {
                    try
                    {
                        string fallbackFolder = Path.Combine(baseDir, $"WebView2_Session_{Process.GetCurrentProcess().Id}");
                        Log($"Attempting fallback userDataFolder: {fallbackFolder}");
                        var fallbackEnv = await CoreWebView2Environment.CreateAsync(null, fallbackFolder);
                        await webView.EnsureCoreWebView2Async(fallbackEnv);
                        initialized = true;
                        Log("EnsureCoreWebView2Async succeeded on fallback folder.");
                    }
                    catch (Exception fbEx)
                    {
                        Log($"Fallback EnsureCoreWebView2Async failed: {fbEx.Message}. Falling back to default environment...");
                        // 第三梯队：系统默认环境保底
                        await webView.EnsureCoreWebView2Async(null);
                        initialized = true;
                        Log("EnsureCoreWebView2Async succeeded on default env.");
                    }
                }

                try
                {
                    ApplyTheme();
                    Log("Set DefaultBackgroundColor to Transparent.");
                }
                catch (Exception bgEx)
                {
                    Log($"Failed setting DefaultBackgroundColor: {bgEx.Message}");
                }

                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;

                string wwwroot = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot");
                Log($"wwwroot path: {wwwroot}");
                if (!Directory.Exists(wwwroot))
                {
                    Directory.CreateDirectory(wwwroot);
                }

                webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "app.local", 
                    wwwroot, 
                    CoreWebView2HostResourceAccessKind.DenyCors);

                webView.CoreWebView2.NavigationStarting += (sender, args) =>
                {
                    if (!BrowserPolicy.IsTrustedDocument(args.Uri)) args.Cancel = true;
                };
                webView.CoreWebView2.FrameNavigationStarting += (sender, args) => args.Cancel = true;
                webView.CoreWebView2.NewWindowRequested += (sender, args) =>
                {
                    args.Handled = true;
                    if (BrowserPolicy.CanOpenExternal(args.Uri))
                    {
                        try { Process.Start(new ProcessStartInfo { FileName = args.Uri, UseShellExecute = true }); }
                        catch { SafePostWebMessage(JsonSerializer.Serialize(new { type = "operationError", message = "浏览器启动失败，请复制授权链接后打开。" })); }
                    }
                };
                webView.CoreWebView2.PermissionRequested += (sender, args) => args.State = CoreWebView2PermissionState.Deny;
                webView.CoreWebView2.DownloadStarting += (sender, args) => args.Cancel = true;
                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                webView.CoreWebView2.ProcessFailed += (s, args) => Log($"WebView2 ProcessFailed: {args.ProcessFailedKind}, {args.Reason}");

                webView.NavigationCompleted += async (s, args) =>
                {
                    Log($"NavigationCompleted: IsSuccess={args.IsSuccess}, WebErrorStatus={args.WebErrorStatus}");
                    if (args.IsSuccess)
                    {
                        UpdateRendererVisibility();
                        await SendHubDataAsync(triggerScan: false, refreshQuotas: false);
                    }
                };

                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.__hubTheme=" + JsonSerializer.Serialize(_settingsService.GetSettings().Theme) + ";");
                Log("Navigating to index.html...");
                webView.CoreWebView2?.Navigate("https://app.local/index.html");
                Log("Navigate called successfully.");

            }
            catch (Exception ex)
            {
                Log($"MainWindow_Loaded EXCEPTION: {ex}");
                MessageBox.Show($"WebView2 初始化失败:\n{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private async Task PrepareClientComponentsAsync()
        {
            var status = await ClientEnhancementService.EnsureReadyAsync();
            Log("Client components: " + status);
            SafePostWebMessage(JsonSerializer.Serialize(new { type = "clientEnhancementStatus", message = status }, JsonOpts.CamelCase));
        }

        public async Task StartServicesAsync()
        {
            _ = PrepareClientComponentsAsync();
            if (_settingsService.GetSettings().CheckUpdatesOnStartup && !HubUpdateInstaller.StartupFailed) _ = _hubUpdates.CheckAsync(_appCts.Token);
            Microsoft.Win32.SystemEvents.UserPreferenceChanged += SystemThemeChanged;
            ApplyTheme();
            PublishHudSnapshot();
            _hud.Start(async (action,id) =>
            {
                return await Dispatcher.InvokeAsync(async () =>
                {
                    if(action == "open") { RestoreAndActivateWindow(); return true; }
                    if (_settingsService.GetSettings().EnableClientHud && _accountService.GetAccounts().Exists(a => a.Id == id)) return (await RunAccountSwitchAsync(id)).Success;
                    return false;
                }).Task.Unwrap();
            }, _appCts.Token);
                var curSettings = _settingsService.GetSettings();
                try
                {
                    _hotkeyService.Initialize(this, () =>
                    {
                        Log("Global hotkey triggered, toggling window...");
                        Dispatcher.Invoke(() =>
                        {
                            if (IsVisible && WindowState != WindowState.Minimized && IsActive)
                            {
                                if (CloseToTray)
                                {
                                    SaveWindowState();
                                    Hide();
                                }
                                else
                                {
                                    WindowState = WindowState.Minimized;
                                }
                            }
                            else
                            {
                                RestoreAndActivateWindow();
                            }
                        });
                    });

                    if (curSettings.EnableGlobalHotkey && !string.IsNullOrWhiteSpace(curSettings.GlobalHotkey))
                    {
                        bool hkOk = _hotkeyService.Register(curSettings.GlobalHotkey);
                        Log($"Global hotkey '{curSettings.GlobalHotkey}' registered: {hkOk}");
                        if (!hkOk) SafePostWebMessage(JsonSerializer.Serialize(new { type = "operationError", message = "全局快捷键注册失败，请在设置中更换组合。" }));
                    }
                }
                catch (Exception hkEx)
                {
                    Log($"Global hotkey init error: {hkEx.Message}");
                }

                // 启动时自动静默联网获取一次当日最新美元汇率
                _ = Task.Run(async () =>
                {
                    try
                    {
                        double rate = await _settingsService.FetchLiveRateAsync(_appCts.Token);
                        Log($"Auto live exchange rate fetched on startup: {rate}");
                        _tokenStatsService.InvalidateCache();
                        await Dispatcher.InvokeAsync(async () =>
                        {
                            await SendHubDataAsync(triggerScan: false, refreshQuotas: false);
                        });
                    }
                    catch (Exception rateEx)
                    {
                        Log($"Auto rate fetch error: {rateEx.Message}");
                    }
                });

            InitAutoSyncTimer();
            await SendHubDataAsync(triggerScan:true,refreshQuotas:true);
        }

        private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string action = "";
            string? settingsRequestId = null;
            try
            {
                if (!BrowserPolicy.IsTrustedDocument(e.Source)) return;
                string json = e.WebMessageAsJson;
                if (json.Length > 262144) return;
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                action = root.TryGetProperty("action", out var a) ? a.GetString() ?? "" : "";
                if (!BrowserPolicy.Actions.Contains(action)) return;
                Log($"OnWebMessageReceived action: {action}");

                if (action == "windowDrag")
                {
                    Dispatcher.Invoke(() =>
                    {
                        var helper = new WindowInteropHelper(this);
                        ReleaseCapture();
                        SendMessage(helper.Handle, WM_NCLBUTTONDOWN, (IntPtr)HT_CAPTION, IntPtr.Zero);
                    });
                }

                else if (action == "windowMin")
                {
                    Dispatcher.Invoke(() =>
                    {
                        SystemCommands.MinimizeWindow(this);
                    });
                }
                else if (action == "windowToggleMax")
                {
                    Dispatcher.Invoke(() =>
                    {
                        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                    });
                }
                else if (action == "windowClose")
                {
                    Dispatcher.Invoke(() =>
                    {
                        if (CloseToTray)
                        {
                            SaveWindowState();
                            Hide();
                        }
                        else
                        {
                            _isExplicitExit = true;
                            Microsoft.Win32.SystemEvents.UserPreferenceChanged -= SystemThemeChanged;
                            SystemCommands.CloseWindow(this);
                        }
                    });
                }
                else if (action == "setCloseToTray")
                {
                    bool enabled = !root.TryGetProperty("closeToTray", out var ctElem) || ctElem.GetBoolean();
                    SetCloseToTray(enabled, syncFrontend: false);
                }
                else if (action == "getClientEnhancementStatus")
                {
                    var result = await ClientEnhancementService.EnsureReadyAsync();
                    SafePostWebMessage(JsonSerializer.Serialize(new { type = "clientEnhancementStatus", message = result }, JsonOpts.CamelCase));
                }
                else if (action == "restartAntigravityClient")
                {
                    if (_clientRestartPending || _switchRequestPending || _hubUpdates.IsInstalling)
                    {
                        SafePostWebMessage(JsonSerializer.Serialize(new {type="clientRestartResult",success=false,message="客户端正在处理其他操作，请稍后重试"}));
                        return;
                    }
                    _clientRestartPending = true;
                    try
                    {
                        var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","antigravity","Antigravity.exe");
                        await Task.Run(async () => {
                            using var host = new WindowsClientRestartHost(executable, ClientEnhancementService.LaunchAsync);
                            await ClientRestartService.RestartAsync(host, _appCts.Token);
                        });
                        SafePostWebMessage(JsonSerializer.Serialize(new {type="clientRestartResult",success=true}));
                    }
                    catch (Exception error)
                    {
                        Logger.Log("Client restart",error.ToString());
                        SafePostWebMessage(JsonSerializer.Serialize(new {type="clientRestartResult",success=false,
                            message=error is IOException ? error.Message : "重启未完成，请稍后重试"}));
                    }
                    finally { _clientRestartPending = false; }
                }
                else if (action == "getHubUpdateStatus") SendHubUpdateStatus();
                else if (action == "checkHubUpdate") await _hubUpdates.CheckAsync(_appCts.Token);
                else if (action == "installHubUpdate")
                {
                    if (_switchRequestPending || _clientRestartPending)
                        _hubUpdates.ReportBusy();
                    else if (await _hubUpdates.InstallAsync(_appCts.Token)) ExitApplication();
                }
                else if (action == "hubUpdateReady") HubUpdateInstaller.MarkHealthy();
                else if (action == "getSettings")
                {
                    var s = _settingsService.GetSettings();
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(new { type = "settingsData", data = s }, jsonOpts));
                }
                else if (action == "setTheme")
                {
                    var settings = _settingsService.GetSettings();
                    settings.Theme = root.GetProperty("theme").GetString() ?? "system";
                    _settingsService.SaveSettings(settings); ApplyTheme();
                }
                else if (action == "saveSettings")
                {
                    settingsRequestId = root.TryGetProperty("requestId",out var saveRequest) ? saveRequest.GetString() : null;
                    if (root.TryGetProperty("settings", out var sElem))
                    {
                        var jsonOpts = JsonOpts.CamelCase;
                        var newSettings = JsonSerializer.Deserialize<AppSettings>(sElem.GetRawText(), jsonOpts);
                        if (newSettings != null)
                        {
                            var live = _settingsService.GetSettings();
                            newSettings.LiveUsdToCnyRate = live.LiveUsdToCnyRate;
                            newSettings.LastRateFetchTime = live.LastRateFetchTime;
                            _settingsService.SaveSettings(newSettings);
                            PublishHudSnapshot();
                            ApplyTheme();
                            CloseToTray = newSettings.CloseToTray;

                            if (newSettings.EnableGlobalHotkey && !string.IsNullOrWhiteSpace(newSettings.GlobalHotkey))
                            {
                                if (!_hotkeyService.Register(newSettings.GlobalHotkey))
                                    SafePostWebMessage(JsonSerializer.Serialize(new { type = "operationError", message = "快捷键注册失败，可能已被其他程序占用。" }));
                            }
                            else
                            {
                                _hotkeyService.Unregister();
                            }

                            if (_autoSyncTimer != null)
                            {
                                _autoSyncTimer.Interval = TimeSpan.FromSeconds(Math.Max(10, newSettings.PollIntervalSeconds));
                            }

                            _tokenStatsService.InvalidateCache();

                            SafePostWebMessage(JsonSerializer.Serialize(new { type = "settingsSaved", data = newSettings, requestId = settingsRequestId }, jsonOpts));
                            SafePostWebMessage(JsonSerializer.Serialize(new { type = "settingsData", data = newSettings }, jsonOpts));

                            await SendHubDataAsync(triggerScan: false, refreshQuotas: false);
                        }
                    }
                }
                else if (action == "openDataFolder")
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = HubStorage.HubDir,
                            UseShellExecute = true
                        });
                    }
                    catch (Exception ex)
                    {
                        Log($"openDataFolder error: {ex.Message}");
                    }
                }
                else if (action == "fetchLiveRate")
                {
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            double rate = await _settingsService.FetchLiveRateAsync(_appCts.Token);
                            _tokenStatsService.InvalidateCache();
                            var curS = _settingsService.GetSettings();
                            var jsonOpts = JsonOpts.CamelCase;
                            SafePostWebMessage(JsonSerializer.Serialize(new { type = "settingsData", data = curS }, jsonOpts));
                            await SendHubDataAsync(triggerScan: false, refreshQuotas: false);
                        }
                        catch (Exception ex)
                        {
                            Log($"fetchLiveRate error: {ex.GetType().Name}");
                            SafePostWebMessage(JsonSerializer.Serialize(new { type = "operationError", message = "汇率获取失败，已保留旧值。" }));
                        }
                    });
                }
                else if (action == "windowResize")
                {
                    Dispatcher.Invoke(() =>
                    {
                        try
                        {
                            if (WindowState == WindowState.Maximized) return;

                            string dir = root.TryGetProperty("direction", out var dElem) ? dElem.GetString() ?? "" : "";
                            int hitCode = 0;
                            switch (dir.ToLowerInvariant())
                            {
                                case "left": hitCode = HTLEFT; break;
                                case "right": hitCode = HTRIGHT; break;
                                case "top": hitCode = HTTOP; break;
                                case "topleft": case "top-left": hitCode = HTTOPLEFT; break;
                                case "topright": case "top-right": hitCode = HTTOPRIGHT; break;
                                case "bottom": hitCode = HTBOTTOM; break;
                                case "bottomleft": case "bottom-left": hitCode = HTBOTTOMLEFT; break;
                                case "bottomright": case "bottom-right": hitCode = HTBOTTOMRIGHT; break;
                            }
                            if (hitCode != 0)
                            {
                                var hwnd = new WindowInteropHelper(this).Handle;
                                GetCursorPos(out POINT pt);
                                IntPtr lParam = (IntPtr)(((pt.Y & 0xFFFF) << 16) | (pt.X & 0xFFFF));
                                ReleaseCapture();
                                SendMessage(hwnd, WM_NCLBUTTONDOWN, (IntPtr)hitCode, lParam);
                                Log($"windowResize triggered: dir={dir}, hitCode={hitCode}, pt=({pt.X},{pt.Y})");
                            }
                        }
                        catch (Exception ex)
                        {
                            Log($"windowResize error: {ex.Message}");
                        }
                    });
                }
                else if (action == "modalStateChanged")
                {
                    bool isOpen = root.TryGetProperty("isOpen", out var io) && io.GetBoolean();
                    Dispatcher.Invoke(() =>
                    {
                        _isModalOpen = isOpen;
                        UpdateWindowLayoutForModal(isOpen);
                    });
                }
                else if (action == "getInitialData" || action == "refresh")
                {
                    string? requestId = root.TryGetProperty("requestId", out var request) ? request.GetString() : null;
                    await SendHubDataAsync(triggerScan: true, refreshQuotas: true, requestId: requestId);
                }
                else if (action == "switchAccount")
                {
                    string accountId = root.TryGetProperty("accountId", out var idElem) ? idElem.GetString() ?? "" : "";
                    await RunAccountSwitchAsync(accountId);
                }
                else if (action == "importCurrentAccount")
                {
                    var result = await _accountService.ImportFromCurrentLoginAsync();
                    var resp = new
                    {
                        type = "importResult",
                        data = result
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));

                    await SendHubDataAsync();
                }
                else if (action == "importAccountFile")
                {
                    string? selectedFile = null;
                    Dispatcher.Invoke(() =>
                    {
                        var dlg = new Microsoft.Win32.OpenFileDialog
                        {
                            Filter = "JSON 账号文件 (*.json)|*.json|所有文件 (*.*)|*.*",
                            Title = "选择要导入的账号 JSON 文件"
                        };
                        if (dlg.ShowDialog(this) == true)
                        {
                            selectedFile = dlg.FileName;
                        }
                    });

                    if (!string.IsNullOrEmpty(selectedFile))
                    {
                        var result = await _accountService.ImportFromJsonFileAsync(selectedFile);
                        var resp = new
                        {
                            type = "importResult",
                            data = result
                        };
                        var jsonOpts = JsonOpts.CamelCase;
                        SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));

                        await SendHubDataAsync();
                    }
                }
                else if (action == "startGoogleOAuth")
                {
                    var prepareResult = _accountService.PrepareGoogleOAuth();
                    var resp = new
                    {
                        type = "oauthStarted",
                        data = prepareResult
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));
                }
                else if (action == "cancelGoogleOAuth")
                {
                    _accountService.CancelGoogleOAuth();
                    var resp = new
                    {
                        type = "oauthCancelled",
                        data = new { message = "已取消授权" }
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));
                }
                else if (action == "submitManualAuthCode")
                {
                    string code = root.TryGetProperty("code", out var cElem) ? cElem.GetString() ?? "" : "";
                    var result = await _accountService.SubmitManualAuthCodeAsync(code);
                    var resp = new
                    {
                        type = "oauthCompleted",
                        data = result
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));

                    if (result.Success)
                    {
                        await SendHubDataAsync();
                    }
                }
                else if (action == "getAntigravityClientStatus")
                {
                    var status = _accountService.GetClientStatus();
                    var resp = new
                    {
                        type = "clientStatus",
                        data = status
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));
                }
                else if (action == "deleteAccount")
                {
                    string accountId = root.TryGetProperty("accountId", out var idElem) ? idElem.GetString() ?? "" : "";
                    var result = await _accountService.DeleteAccountAsync(accountId);
                    var resp = new
                    {
                        type = "deleteResult",
                        data = result
                    };
                    var jsonOpts = JsonOpts.CamelCase;
                    SafePostWebMessage(JsonSerializer.Serialize(resp, jsonOpts));

                    await SendHubDataAsync();
                }
            }
            catch (Exception ex)
            {
                Log($"Web message failed: {ex.GetType().Name}");
                if (action == "saveSettings") SafePostWebMessage(JsonSerializer.Serialize(new {type="settingsSaveFailed",requestId=settingsRequestId}));
                SafePostWebMessage(JsonSerializer.Serialize(new { type="settingsData",data=_settingsService.GetSettings() },JsonOpts.CamelCase));
                ApplyTheme();
                SafePostWebMessage(JsonSerializer.Serialize(new { type = "operationError", message = "操作未完成，请重试或检查文件权限。" }));
            }
        }

        private System.Windows.Threading.DispatcherTimer? _autoSyncTimer;

        private void InitAutoSyncTimer()
        {
            if (_autoSyncTimer != null) return;
            var s = _settingsService.GetSettings();
            int interval = Math.Max(10, s.PollIntervalSeconds);
            _autoSyncTimer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(interval)
            };
            _autoSyncTimer.Tick += async (s, e) =>
            {
                Log("AutoSyncTimer tick: running background quota and token sync...");
                await SendHubDataAsync(triggerScan: true, refreshQuotas: true);
            };
            _autoSyncTimer.Start();
            Log($"AutoSyncTimer started ({interval}s interval).");
        }


        private void SendHubUpdateStatus() => SafePostWebMessage(JsonSerializer.Serialize(new {type="hubUpdateStatus",data=_hubUpdates.Status}, JsonOpts.CamelCase));

        private void SafePostWebMessage(string json)
        {
            try
            {
                Dispatcher.Invoke(() =>
                {
                    try
                    {
                        if (webView?.CoreWebView2 != null)
                        {
                            webView.CoreWebView2.PostWebMessageAsJson(json);
                        }
                    }
                    catch (Exception ex)
                    {
                        Log($"Inner PostWebMessageAsJson error: {ex.Message}");
                    }
                });
            }
            catch (Exception ex)
            {
                Log($"SafePostWebMessage Dispatcher error: {ex.Message}");
            }
        }

        private static void CleanOrphanedWebViewSessions(string baseDir)
        {
            try
            {
                if (!Directory.Exists(baseDir)) return;
                int currentPid = Process.GetCurrentProcess().Id;
                var sessionDirs = Directory.GetDirectories(baseDir, "WebView2_Session_*");
                foreach (var dir in sessionDirs)
                {
                    string folderName = Path.GetFileName(dir);
                    string pidStr = folderName.Replace("WebView2_Session_", "");
                    if (int.TryParse(pidStr, out int pid))
                    {
                        if (pid == currentPid) continue;
                        bool isAlive = false;
                        try
                        {
                            var proc = Process.GetProcessById(pid);
                            isAlive = !proc.HasExited;
                        }
                        catch
                        {
                            isAlive = false;
                        }

                        if (!isAlive)
                        {
                            try
                            {
                                Directory.Delete(dir, recursive: true);
                                Log($"Cleaned orphaned session folder: {dir}");
                            }
                            catch (Exception ex)
                            {
                                Log($"Failed to delete orphaned session folder {dir}: {ex.Message}");
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"CleanOrphanedWebViewSessions error: {ex.Message}");
            }
        }

        private async Task SendHubDataAsync(bool triggerScan = true, bool refreshQuotas = true, string? requestId = null)
        {
            var options = JsonOpts.CamelCase;
            try
            {
                // Load persisted local usage before the initial push; never overwrite a real snapshot with startup zeros.
                var localStats = await _tokenStatsService.GetStatsAsync(triggerScan: false, cancellationToken: _appCts.Token);
                PushLatestHubData(localStats);
                if (triggerScan || refreshQuotas)
                {
                    var result = await _refreshCoordinator.RunAsync(async () =>
                    {
                        var errors = new System.Collections.Generic.List<string>();
                        // Every shared refresh covers both sources, including a manual request joining a tray refresh.
                        int failed = await _accountService.RefreshAllQuotasAsync(_accountService.GetAccounts(), _appCts.Token);
                        if (failed > 0) errors.Add($"{failed} 个账号配额查询失败，已保留缓存");
                        try { await _tokenStatsService.GetStatsAsync(triggerScan: true, cancellationToken: _appCts.Token); }
                        catch (OperationCanceledException) { throw; }
                        catch (Exception ex) { errors.Add(ex.Message); }
                        return new RefreshOutcome(errors.Count == 0, string.Join("；", errors));
                    });
                    // Re-read current account and settings after await. An older request cannot resurrect a deleted or switched account.
                    var latestStats = await _tokenStatsService.GetStatsAsync(triggerScan: false, cancellationToken: _appCts.Token);
                    PushLatestHubData(latestStats);
                    if (requestId != null) SafePostWebMessage(JsonSerializer.Serialize(new
                    { type = "refreshCompleted", requestId, success = result.Success, message = result.Message }, options));
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                Log($"Refresh failed: {ex.GetType().Name}");
                SafePostWebMessage(JsonSerializer.Serialize(new { type = "refreshCompleted", requestId, success = false, message = ex.Message }, options));
            }
        }

        private void PushLatestHubData(TokenSummary stats)
        {
            var accounts = _accountService.GetAccounts();
            var settings = _settingsService.GetSettings();
            var data = new HubDataResponse { Accounts = accounts, CurrentAccount = accounts.Find(a => a.IsCurrent), Stats = stats, Settings = settings };
            if (IsVisible && WindowState != WindowState.Minimized && webView.CoreWebView2 != null)
            {
                SafePostWebMessage(JsonSerializer.Serialize(new { type = "hubData", data }, JsonOpts.CamelCase));
                SafePostWebMessage(JsonSerializer.Serialize(new { type = "settingsData", data = settings }, JsonOpts.CamelCase));
            }
            _trayPopupWindow?.UpdateHubData(accounts, stats);
            ApplyTheme();
            _latestHudStats = stats;
            PublishHudSnapshot();
        }

        private void PublishHudSnapshot()
        {
            var accounts = _accountService.GetAccounts();
            _hud.Publish(new { available = true, enabled = _settingsService.GetSettings().EnableClientHud,
                today = _latestHudStats?.TodayFormatted ?? "—", todayCost = _latestHudStats?.TodayCostFormatted ?? "",
                accounts = accounts.ConvertAll(a => new { a.Id, a.Name, a.Email, a.IsCurrent, a.IdeRestartPending, a.AvatarDataUrl, a.Tier,
                    a.Gemini5hQuota, a.GeminiWeeklyQuota, a.Claude5hQuota, a.ClaudeWeeklyQuota,
                    a.ResetTime5h, a.ResetTimeWeekly, a.ClaudeResetTime5h, a.ClaudeResetTimeWeekly, a.LastQuotaRefreshTime, a.QuotaStatus }) });
        }

        private bool _isModalOpen = false;

        private void UpdateWindowLayoutForModal(bool isOpen)
        {
            webView.Margin = new Thickness(0);
            ApplyTheme();
        }

        public void RestoreAndActivate()
        {
            RestoreAndActivateWindow();
        }

        public void RestoreAndActivateWindow()
        {
            Dispatcher.Invoke(() =>
            {
                if (!IsVisible)
                {
                    Show();
                }
                if (WindowState == WindowState.Minimized)
                {
                    WindowState = WindowState.Normal;
                }
                Activate();
                Topmost = true;
                Topmost = false;
                Focus();

                var hwnd = new WindowInteropHelper(this).Handle;
                SetForegroundWindow(hwnd);

                _ = SendHubDataAsync(triggerScan: false, refreshQuotas: false);
            });
        }

        public void ExplicitExit()
        {
            ExitApplication();
        }

        public void ExitApplication()
        {
            Dispatcher.Invoke(() =>
            {
                _isExplicitExit = true;
                Microsoft.Win32.SystemEvents.UserPreferenceChanged -= SystemThemeChanged;
                try { _appCts.Cancel(); _accountService.CancelGoogleOAuth(); } catch { }
                try { _autoSyncTimer?.Stop(); } catch { }
                try { _windowSaveTimer?.Stop(); SaveWindowState(); } catch { }
                try { _trayPopupWindow?.Close(); } catch { }
                try { webView?.Dispose(); } catch { }
                _trayService?.Dispose();
                _hubUpdates.Dispose();
                System.Windows.Application.Current.Shutdown();
            });
        }

        public Task SwitchAccountFromTrayAsync(string targetAccountId) => RunAccountSwitchAsync(targetAccountId);

        private async Task<SwitchResult> RunAccountSwitchAsync(string targetAccountId)
        {
            if (_switchRequestPending || _clientRestartPending || _hubUpdates.IsInstalling) return new SwitchResult { Message = "客户端正在处理其他操作，请稍后重试" };
            _switchRequestPending = true;
            SwitchResult result;
            try
            {
                result = await _accountService.SwitchAccountAsync(targetAccountId, async activity =>
                {
                    return await Dispatcher.InvokeAsync(() =>
                    {
                        _trayPopupWindow?.Hide();
                        var targetAcc = _accountService.GetAccounts().Find(item => item.Id == targetAccountId);
                        string account = targetAcc?.Email ?? targetAccountId;
                        string? displayName = targetAcc?.Name;
                        string? tier = targetAcc?.Tier;
                        string? avatarDataUrl = targetAcc?.AvatarDataUrl;
                        var dialog = new SwitchConfirmationWindow(account, activity.Description, displayName, tier, avatarDataUrl);
                        ThemePalette.Tree(dialog, ThemePalette.IsDark(_settingsService.GetSettings().Theme));
                        if (IsVisible) { dialog.Owner = this; dialog.WindowStartupLocation = WindowStartupLocation.CenterOwner; }
                        using var cancelled = _appCts.Token.Register(() => Dispatcher.BeginInvoke(new Action(dialog.Close)));
                        return dialog.ShowDialog() == true;
                    });
                }, _appCts.Token);
            }
            catch (Exception ex)
            {
                Log($"Account switch error: {ex.Message}");
                result = new SwitchResult { Message = $"切换异常: {ex.Message}" };
            }
            finally { _switchRequestPending = false; }
            SafePostWebMessage(JsonSerializer.Serialize(new { type = "switchResult", data = result }, JsonOpts.CamelCase));
            await SendHubDataAsync(triggerScan: false, refreshQuotas: result.Success);
            return result;
        }

        public void SetCloseToTray(bool enabled, bool syncFrontend = false)
        {
            CloseToTray = enabled;
            var s = _settingsService.GetSettings();
            s.CloseToTray = enabled;
            _settingsService.SaveSettings(s);
            if (syncFrontend)
            {
                SafePostWebMessage(JsonSerializer.Serialize(new { type = "closeToTrayChanged", data = new { closeToTray = enabled } }));
            }
        }

        private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
        {
            SaveWindowState();
            if (!_isExplicitExit && CloseToTray)
            {
                e.Cancel = true;
                Hide();
                return;
            }

            try { _appCts.Cancel(); } catch { }
            try { _accountService.CancelGoogleOAuth(); } catch { }
            try { _autoSyncTimer?.Stop(); } catch { }
            try { _trayPopupWindow?.Close(); } catch { }
            try { webView?.Dispose(); } catch { }
            _trayService?.Dispose();
            _hubUpdates.Dispose();
            _hotkeyService?.Dispose();
            System.Windows.Application.Current.Shutdown();
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == (int)WM_SHOW_ANTIGRAVITY_HUB)
            {
                Log("WndProc: Received WM_SHOW_ANTIGRAVITY_HUB broadcast, restoring and activating window.");
                RestoreAndActivateWindow();
                handled = true;
                return IntPtr.Zero;
            }
            if (msg == WM_SHOWWINDOW && wParam != IntPtr.Zero)
            {
                Dispatcher.Invoke(() =>
                {
                    if (!IsVisible) Show();
                    if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
                    Activate();
                });
            }
            return IntPtr.Zero;
        }
    }
}
