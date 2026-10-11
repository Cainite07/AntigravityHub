using System.IO;
using System.Reflection;

using System.Windows;

using System.Windows.Controls;

using AntigravityHub;



internal static class Program

{

    [STAThread]

    private static void Main()

    {

        if (Environment.GetCommandLineArgs().Contains("--show-confirmation"))

        {

            // Optional UI probe: only this isolated dialog is shown. No account service or real IDE is used.

            var confirmation = new SwitchConfirmationWindow("界面验收测试账号", "检测到 1 个 Antigravity 任务正在运行或等待操作。切换账号会重启客户端，可能中断这些任务。");

            bool accepted = confirmation.ShowDialog() == true;

            Console.WriteLine(accepted ? "UI probe: continued (fixture only)." : "PASS: UI probe cancelled; no account or IDE operation exists in this fixture.");

            return;

        }

        // Build and measure the isolated native popup; never construct MainWindow, show an HWND or touch real accounts.

        var popup = new TrayPopupWindow(null!);

        var accounts = Enumerable.Range(0, 100).Select(i => new AccountItem { Id = "fixture-" + i, Email = $"test{i}@example.invalid", Name = "测试账号 " + i }).ToList();

        accounts[0].AvatarDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA3sAAAAASUVORK5CYII=";

        var render = typeof(TrayPopupWindow).GetMethod("RenderUI", BindingFlags.NonPublic | BindingFlags.Instance)!;

        popup.UpdateHubData(accounts, new TokenSummary { TodayFormatted = "100" }); render.Invoke(popup, null);

        popup.Measure(new Size(278, 650));

        Console.WriteLine($"Diagnostic: hidden Window DesiredSize={popup.DesiredSize}; explicit width={popup.Width}.");

        var measure = typeof(TrayPopupWindow).GetMethod("MeasurePopup", BindingFlags.NonPublic | BindingFlags.Instance)!;

        Size Measure(double width, double height) => (Size)measure.Invoke(popup, new object[] { width, height })!;

        var layout = Measure(1200, 650);

        if (layout.Height > 650 || layout.Height < 100) throw new Exception("Account list size is empty or grows beyond the popup bound.");

        if (layout.Width != 278 || Math.Ceiling(layout.Width * 1.5) != 417) throw new Exception("Hidden popup is squeezed to a zero/one-pixel width at 150% DPI.");

        layout = Measure(220, 300);

        if (layout.Width != 220 || layout.Height > 300 || layout.Height < 100) throw new Exception("Popup exceeds a small monitor's working area.");

        if (Measure(1200, 650).Width != 278) throw new Exception("Popup width fails to recover after leaving a narrow monitor.");

        var panel = (StackPanel)popup.FindName("AccountsPanel"); var first = panel.Children[0];

        Border AvatarAt(int index) => (Border)((Grid)((Border)panel.Children[index]).Child).Children[0];

        if (AvatarAt(0).Child is not Image cachedImage || cachedImage.Source == null) throw new Exception("Tray failed to render a cached avatar without network access.");

        if (AvatarAt(1).Child is not TextBlock fallback || fallback.Text != "\uE77B") throw new Exception("Missing avatar falls back to a misleading email initial.");

        using (var icon = Application.GetResourceStream(new Uri("pack://application:,,,/AntigravityHub;component/app.ico"))!.Stream)

        {

            var decoded = System.Windows.Media.Imaging.BitmapDecoder.Create(icon, System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);

            if (!decoded.Frames.Any(frame => frame.PixelWidth >= 32)) throw new Exception("Application icon resource is invalid.");

        }

        popup.UpdateHubData(accounts, new TokenSummary { TodayFormatted = "200" }); render.Invoke(popup, null);

        if (!ReferenceEquals(first, panel.Children[0])) throw new Exception("Unchanged accounts recreated their native controls.");

        if (((TextBlock)popup.FindName("TxtTodayTokens")).Text != "200") throw new Exception("Token summary did not refresh.");

        popup.UpdateHubData(new List<AccountItem>(), new TokenSummary()); render.Invoke(popup, null);

        if (panel.Children.Count != 1 || panel.Children[0] is not TextBlock) throw new Exception("Empty native account state is missing.");

        popup.Close();

        var dialog = new SwitchConfirmationWindow("fixture@example.invalid", "检测到 1 个任务正在运行，继续会重启客户端。");

        var root = (FrameworkElement)dialog.Content;

        root.Measure(new Size(500, double.PositiveInfinity));

        if (root.DesiredSize.Height < 120 || root.DesiredSize.Height > 500) throw new Exception("Task confirmation content is empty or clipped.");

        var cancel = dialog.CancelButton;

        var proceed = dialog.ProceedButton;

        if (cancel == null || !cancel.IsCancel || proceed == null || proceed.IsDefault)

            throw new Exception("Task confirmation does not default to a safe cancellation.");

        if (dialog.TargetAccount != "fixture@example.invalid") throw new Exception("Confirmation omits the target account.");

        dialog.Close();

        var nativeTheme = typeof(MainWindow).Assembly.GetType("AntigravityHub.ThemePalette")!.GetMethod("Tree",BindingFlags.Public|BindingFlags.Static)!;
        var paperBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(250,248,242));
        var inkBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30,29,26));
        var themeText = new TextBlock {Text="fixture"};
        var themeCard = new Border {Background=paperBrush,Child=themeText};
        var hidden = new Window {AllowsTransparency=true,WindowStyle=WindowStyle.None,Background=System.Windows.Media.Brushes.Transparent,Content=themeCard};
        var inheritedInk = themeText.Foreground;
        nativeTheme.Invoke(null,new object[]{hidden,true});
        if(ReferenceEquals(themeCard.Background,paperBrush) || ReferenceEquals(themeText.Foreground,inheritedInk))throw new Exception("Unloaded logical controls missed dark theme");
        if(((System.Windows.Media.SolidColorBrush)hidden.Background).Color.A!=0)throw new Exception("Dark theme made transparent window corners opaque");
        nativeTheme.Invoke(null,new object[]{hidden,false});
        if(!ReferenceEquals(themeCard.Background,paperBrush)||!ReferenceEquals(themeText.Foreground,inheritedInk))throw new Exception("Light theme did not restore original brushes");
        hidden.Close();
        Console.WriteLine("PASS: 17 native WPF checks, including unloaded theme application, transparent corners, and light restoration.");

    }

}

