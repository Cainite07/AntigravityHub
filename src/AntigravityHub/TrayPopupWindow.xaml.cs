using System;

using System.Collections.Generic;

using System.Diagnostics;

using System.IO;

using System.Text.Json;

using System.Runtime.InteropServices;

using System.Windows;

using System.Windows.Controls;

using System.Windows.Documents;

using System.Windows.Interop;

using System.Windows.Media;

using System.Windows.Media.Imaging;



namespace AntigravityHub

{

    public partial class TrayPopupWindow : Window

    {

        [DllImport("user32.dll")]

        private static extern bool SetForegroundWindow(IntPtr hWnd);



        [DllImport("user32.dll")]

        private static extern uint GetDpiForWindow(IntPtr hWnd);



        [DllImport("user32.dll", SetLastError = true)]

        private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);



        private static void Log(string msg) => Logger.Log("TrayPopupWindow", msg);



        // Pre-allocated frozen brushes for RenderAccounts performance

        private static readonly SolidColorBrush BrushCardActive = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#EDE4D4")));

        private static readonly SolidColorBrush BrushCardInactive = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#F4EFE4")));

        private static readonly SolidColorBrush BrushBorderActive = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#C6B9A2")));

        private static readonly SolidColorBrush BrushAvatarBorder = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#D5CBB8")));

        private static readonly SolidColorBrush BrushAvatarFallbackBg = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#2B2721")));

        private static readonly SolidColorBrush BrushNameText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E1D1A")));

        private static readonly SolidColorBrush BrushProTagBg = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#241F19")));

        private static readonly SolidColorBrush BrushProTagBorder = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#C9A44B")));

        private static readonly SolidColorBrush BrushProTagText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#EED28B")));

        private static readonly SolidColorBrush BrushUltraTagBg = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#182230")));

        private static readonly SolidColorBrush BrushUltraTagBorder = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#4D73AA")));

        private static readonly SolidColorBrush BrushUltraTagText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#9EC7FF")));

        private static readonly SolidColorBrush BrushFreeTagBg = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#E4D9C8")));

        private static readonly SolidColorBrush BrushFreeTagBorder = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#CFC1AB")));

        private static readonly SolidColorBrush BrushFreeTagText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#7B705F")));

        private static readonly SolidColorBrush BrushQuotaText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#787061")));

        private static readonly SolidColorBrush BrushQuotaBold = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#2B2721")));

        private static readonly SolidColorBrush BrushBadgeBg = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#D4ECD8")));

        private static readonly SolidColorBrush BrushBadgeBorder = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#B4DFBC")));

        private static readonly SolidColorBrush BrushBadgeText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#235F33")));

        private static readonly SolidColorBrush BrushSwitchBtnBg = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E1D1A")));

        private static readonly SolidColorBrush BrushEmptyText = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#8C8372")));



        private static SolidColorBrush Freeze(SolidColorBrush brush) { brush.Freeze(); return brush; }



        private readonly MainWindow _mainWindow;
        private readonly double _preferredWidth;

        private List<AccountItem> _accounts = new();

        private TokenSummary? _stats;

        private bool _isOpening = false;

        private bool _isDataDirty = true;

        private string? _renderedAccounts;

        private static readonly Dictionary<string, ImageSource> _avatarCache = new();



        public new void Hide()

        {

            base.Hide();

        }



        public TrayPopupWindow(MainWindow mainWindow)

        {

            InitializeComponent();
            _preferredWidth = Width;

            _mainWindow = mainWindow;

            Deactivated += (s, e) =>

            {

                Log($"Deactivated event fired. _isOpening={_isOpening}, IsVisible={IsVisible}");

                if (_isOpening)

                {

                    Log("Deactivated suppressed during opening sequence.");

                    return;

                }

                try { base.Hide(); } catch { }

            };

        }



        public void UpdateHubData(List<AccountItem> accounts, TokenSummary stats)

        {

            Dispatcher.Invoke(() =>

            {

                _accounts = accounts ?? new List<AccountItem>();

                _stats = stats;

                _isDataDirty = true;



                // 悬浮窗未处于显示状态时直接跳过渲染，极大节约后台 CPU 与 UIElement 分配

                if (IsVisible)

                {

                    RenderUI();

                    _isDataDirty = false;

                }

            });

        }



        private void RenderUI()

        {

            if (_stats != null)

            {

                TxtTodayTokens.Text = _stats.TodayFormatted ?? "0";

                TxtTodayRounds.Text = $"{_stats.TodayRequests:N0} 轮交互";

                TxtTodayCost.Text = string.IsNullOrEmpty(_stats.TodayCostFormatted) ? "¥0.00" : _stats.TodayCostFormatted;

            }



            RenderAccounts(_accounts);

        }



        private void RenderAccounts(List<AccountItem> accounts)

        {

            string signature = JsonSerializer.Serialize(accounts, JsonOpts.CamelCase);

            if (signature == _renderedAccounts) return;

            _renderedAccounts = signature;

            AccountsPanel.Children.Clear();

            if (accounts == null || accounts.Count == 0)

            {

                var emptyText = new TextBlock

                {

                    Text = "暂无已导入账号",

                    FontSize = 10,

                    Foreground = BrushEmptyText,

                    HorizontalAlignment = HorizontalAlignment.Center,

                    Margin = new Thickness(0, 4, 0, 4)

                };

                AccountsPanel.Children.Add(emptyText);

                return;

            }



            foreach (var acc in accounts)

            {

                bool isCurrent = acc.IsCurrent;

                var card = new Border

                {

                    CornerRadius = new CornerRadius(9),

                    Padding = new Thickness(8, 6, 8, 6),

                    Margin = new Thickness(0, 0, 0, 5),

                    Background = isCurrent ? BrushCardActive : BrushCardInactive,

                    BorderBrush = isCurrent ? BrushBorderActive : Brushes.Transparent,

                    BorderThickness = new Thickness(1)

                };



                var rowGrid = new Grid();

                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });



                // Avatar

                var avatarBorder = new Border

                {

                    Width = 28,

                    Height = 28,

                    CornerRadius = new CornerRadius(14),

                    BorderBrush = BrushAvatarBorder,

                    BorderThickness = new Thickness(1),

                    Margin = new Thickness(0, 0, 8, 0),

                    VerticalAlignment = VerticalAlignment.Center

                };



                Action showFallback = () =>

                {

                    string initial = "\uE77B";

                    avatarBorder.Background = BrushAvatarFallbackBg;

                    avatarBorder.Child = new TextBlock

                    {

                        Text = initial,

                        Foreground = Brushes.White,

                        FontWeight = FontWeights.Bold,

                        FontSize = 18,

                        FontFamily = new FontFamily("Segoe MDL2 Assets"),

                        HorizontalAlignment = HorizontalAlignment.Center,

                        VerticalAlignment = VerticalAlignment.Center

                    };

                };



                try

                {

                    string data = acc.AvatarDataUrl;

                    if (string.IsNullOrEmpty(data)) data = AvatarCache.Read(acc.AvatarUrl);

                    if (!_avatarCache.TryGetValue(data, out var image) && data.StartsWith("data:image/", StringComparison.Ordinal))

                    {

                        using var stream = new MemoryStream(Convert.FromBase64String(data[(data.IndexOf(',') + 1)..]));

                        var bitmap = new BitmapImage();

                        bitmap.BeginInit(); bitmap.StreamSource = stream; bitmap.DecodePixelWidth = 56;

                        bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.EndInit(); bitmap.Freeze();

                        image = bitmap;

                        if (_avatarCache.Count >= 64) _avatarCache.Clear();

                        _avatarCache[data] = image;

                    }

                    if (image != null) avatarBorder.Child = new Image { Source = image, Stretch = Stretch.UniformToFill, Clip = new EllipseGeometry(new Point(14, 14), 14, 14) };

                    else showFallback();

                }

                catch (Exception ex) when (ex is FormatException or IOException or NotSupportedException or ArgumentException)

                {

                    showFallback();

                }

                Grid.SetColumn(avatarBorder, 0);

                rowGrid.Children.Add(avatarBorder);



                // Info

                var infoStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };

                var nameRow = new StackPanel { Orientation = Orientation.Horizontal };

                string emailName = acc.Email.Contains("@") ? acc.Email.Split("@")[0] : acc.Email;

                nameRow.Children.Add(new TextBlock

                {

                    Text = string.IsNullOrWhiteSpace(acc.Name) ? emailName : acc.Name,

                    FontWeight = FontWeights.Bold,

                    FontSize = 11.5,

                    Foreground = BrushNameText,

                    MaxWidth = 115,

                    TextTrimming = TextTrimming.CharacterEllipsis

                });



                string normTier = AccountMetadata.NormalizeTier(acc.Tier);

                if (!string.IsNullOrWhiteSpace(normTier))

                {

                    bool isUltra = normTier == "ULTRA";

                    bool isFree = normTier == "FREE";

                    var proTag = new Border

                    {

                        Background = isUltra ? BrushUltraTagBg : isFree ? BrushFreeTagBg : BrushProTagBg,

                        BorderBrush = isUltra ? BrushUltraTagBorder : isFree ? BrushFreeTagBorder : BrushProTagBorder,

                        BorderThickness = new Thickness(1),

                        CornerRadius = new CornerRadius(3.5),

                        Padding = new Thickness(4, 0.5, 4, 0.5),

                        Margin = new Thickness(5, 0, 0, 0),

                        VerticalAlignment = VerticalAlignment.Center,

                        Child = new TextBlock

                        {

                            Text = normTier,

                            FontSize = 8.5,

                            FontWeight = FontWeights.Bold,

                            Foreground = isUltra ? BrushUltraTagText : isFree ? BrushFreeTagText : BrushProTagText

                        }

                    };

                    nameRow.Children.Add(proTag);

                }

                infoStack.Children.Add(nameRow);



                // Quota: Only Gemini 5h & Weekly (No Claude!)

                var quotaText = new TextBlock

                {

                    Margin = new Thickness(0, 1.5, 0, 0),

                    FontSize = 9.5,

                    Foreground = BrushQuotaText

                };

                quotaText.Inlines.Add("5h: ");

                quotaText.Inlines.Add(new Bold(new Run(acc.Gemini5hQuota >= 0 ? $"{acc.Gemini5hQuota}%" : "未知")) { Foreground = BrushQuotaBold });

                quotaText.Inlines.Add(" · 周: ");

                quotaText.Inlines.Add(new Bold(new Run(acc.GeminiWeeklyQuota >= 0 ? $"{acc.GeminiWeeklyQuota}%" : "未知")) { Foreground = BrushQuotaBold });

                infoStack.Children.Add(quotaText);



                Grid.SetColumn(infoStack, 1);

                rowGrid.Children.Add(infoStack);



                // Action (Active tag or Switch button)

                if (isCurrent)

                {

                    var activeBadge = new Border

                    {

                        Background = BrushBadgeBg,

                        BorderBrush = BrushBadgeBorder,

                        BorderThickness = new Thickness(1),

                        CornerRadius = new CornerRadius(5),

                        Padding = new Thickness(6, 2.5, 6, 2.5),

                        VerticalAlignment = VerticalAlignment.Center,

                        Child = new TextBlock

                        {

                            Text = acc.IdeRestartPending ? "待重启" : "✔ 使用中",

                            FontSize = 9.5,

                            FontWeight = FontWeights.Bold,

                            Foreground = BrushBadgeText

                        }

                    };

                    Grid.SetColumn(activeBadge, 2);

                    rowGrid.Children.Add(activeBadge);

                }

                else

                {

                    var switchBtn = new Button

                    {

                        Style = (Style)FindResource("FlatButton"),

                        Background = BrushSwitchBtnBg,

                        Foreground = Brushes.White,

                        Padding = new Thickness(8, 3, 8, 3),

                        VerticalAlignment = VerticalAlignment.Center,

                        Tag = acc.Id,

                        Content = new TextBlock

                        {

                            Text = "切换",

                            FontSize = 10,

                            FontWeight = FontWeights.Bold

                        }

                    };

                    string targetId = acc.Id;

                    switchBtn.Click += async (s, ev) =>

                    {

                        Hide();

                        await _mainWindow.SwitchAccountFromTrayAsync(targetId);

                    };

                    Grid.SetColumn(switchBtn, 2);

                    rowGrid.Children.Add(switchBtn);

                }



                card.Child = rowGrid;

                AccountsPanel.Children.Add(card);

            }

        }



        private Size MeasurePopup(double availableWidth, double availableHeight)

        {

            MaxWidth = Math.Max(1, availableWidth);

            MaxHeight = Math.Max(1, availableHeight);

            Width = Math.Min(_preferredWidth, MaxWidth);

            AccountsScroll.MaxHeight = Math.Max(1, MaxHeight - 175);

            // A hidden Window can report zero DesiredSize.Width. Measure its content and

            // retain the explicit window width rather than shrinking the HWND to one pixel.

            var content = (FrameworkElement)Content;

            content.Measure(new Size(Width, MaxHeight));

            return new Size(Width, Math.Clamp(content.DesiredSize.Height, 1, MaxHeight));

        }



        public void ShowNearCursor(System.Drawing.Point cursorPoint)

        {

            Log($"ShowNearCursor called. IsVisible={IsVisible}, Pos=({cursorPoint.X},{cursorPoint.Y})");



            if (IsVisible)

            {

                Log("ShowNearCursor: Window is already visible, hiding.");

                Hide();

                return;

            }



            _isOpening = true;

            try

            {

                if (_isDataDirty)

                {

                    RenderUI();

                    _isDataDirty = false;

                }



                var screen = System.Windows.Forms.Screen.FromPoint(cursorPoint);

                var workingArea = screen.WorkingArea;



                var hwnd = new WindowInteropHelper(this).EnsureHandle();



                // Move the hidden HWND onto the target monitor before reading its DPI.

                SetWindowPos(hwnd, IntPtr.Zero, cursorPoint.X, cursorPoint.Y, 0, 0, 0x0015);

                uint dpi = GetDpiForWindow(hwnd);

                double scale = dpi > 0 ? dpi / 96.0 : 1.0;

                var layoutSize = MeasurePopup((workingArea.Width - 16) / scale, (workingArea.Height - 16) / scale);

                int width = (int)Math.Ceiling(layoutSize.Width * scale);

                int height = (int)Math.Ceiling(layoutSize.Height * scale);

                var bounds = TrayPlacement.Calculate(cursorPoint, workingArea, width, height);



                // 1. Establish foreground token first so Windows grants focus immediately

                SetForegroundWindow(hwnd);



                // 2. Show the window

                Show();

                // Physical coordinates preserve negative monitor origins and mixed DPI placement.

                SetWindowPos(hwnd, IntPtr.Zero, bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x0014);



                // 3. Activate and Focus

                Activate();

                Focus();



                // 4. Reinforce foreground

                SetForegroundWindow(hwnd);

                Log($"ShowNearCursor shown at ({bounds.X},{bounds.Y}), size={bounds.Width}x{bounds.Height}, dpi={dpi}");

            }

            catch (Exception ex)

            {

                Log($"ShowNearCursor error: {ex.Message}");

                Show();

            }

            finally

            {

                Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Input, new Action(() =>

                {

                    _isOpening = false;

                    Log("_isOpening reset to false.");

                }));

            }

        }



        private void OpenDashboard_Click(object sender, RoutedEventArgs e)

        {

            Hide();

            _mainWindow.RestoreAndActivate();

        }



        private void Exit_Click(object sender, RoutedEventArgs e)

        {

            Hide();

            _mainWindow.ExplicitExit();

        }

    }

}

