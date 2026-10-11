using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;

namespace AntigravityHub;

public sealed class SwitchConfirmationWindow : Window
{
    private static SolidColorBrush Freeze(SolidColorBrush brush) { brush.Freeze(); return brush; }

    public Button CancelButton { get; }
    public Button ProceedButton { get; }
    public string TargetAccount { get; }

    public SwitchConfirmationWindow(
        string account, 
        string description, 
        string? displayName = null, 
        string? tier = null, 
        string? avatarDataUrl = null)
    {
        Title = "切换账号 · 任务提醒";
        Width = 490;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ShowInTaskbar = false;

        var rootGrid = new Grid { Margin = new Thickness(16) };

        var cardBorder = new Border
        {
            Background = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#FAF8F2"))),
            BorderBrush = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#D5CBB8"))),
            BorderThickness = new Thickness(1.5),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(24, 22, 24, 22),
            Effect = new DropShadowEffect
            {
                BlurRadius = 24,
                ShadowDepth = 6,
                Color = Color.FromArgb(40, 25, 20, 15),
                Direction = 270,
                Opacity = 0.35
            }
        };

        cardBorder.MouseLeftButtonDown += (s, e) =>
        {
            if (e.LeftButton == MouseButtonState.Pressed) DragMove();
        };

        var mainStack = new StackPanel();

        // 1. Header (Amber warning icon + Title + Close button)
        var headerDock = new DockPanel { LastChildFill = true };

        var closeBtn = CreateCloseButton();
        closeBtn.Click += (_, _) => DialogResult = false;
        DockPanel.SetDock(closeBtn, Dock.Right);
        headerDock.Children.Add(closeBtn);

        var headerLeft = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        
        var iconBadge = new Border
        {
            Width = 36,
            Height = 36,
            CornerRadius = new CornerRadius(10),
            Background = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#FDF3DE"))),
            BorderBrush = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#EED39E"))),
            BorderThickness = new Thickness(1),
            Child = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse("M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10h2v4h-2zm0 6h2v2h-2z"),
                Width = 18,
                Height = 18,
                Stretch = Stretch.Uniform,
                Fill = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#A86E18")))
            }
        };
        headerLeft.Children.Add(iconBadge);

        var titleBlock = new TextBlock
        {
            Text = "切换账号 · 任务提醒",
            FontSize = 17,
            FontWeight = FontWeights.Bold,
            Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E1D1A"))),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(12, 0, 0, 0)
        };
        headerLeft.Children.Add(titleBlock);

        headerDock.Children.Add(headerLeft);
        mainStack.Children.Add(headerDock);

        // 2. Description
        var descBlock = new TextBlock
        {
            Text = description,
            FontSize = 13,
            Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#5A5348"))),
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 20,
            Margin = new Thickness(0, 14, 0, 14)
        };
        mainStack.Children.Add(descBlock);

        // 3. Target Account Profile Card (Avatar + Email + Tier)
        var targetCard = new Border
        {
            Background = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#F0EAE0"))),
            BorderBrush = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#DFD6C5"))),
            BorderThickness = new Thickness(1.5),
            CornerRadius = new CornerRadius(13),
            Padding = new Thickness(14, 12, 14, 12)
        };

        var targetDock = new DockPanel { LastChildFill = true };

        // Right side: Tier badge (Restrained: PRO, ULTRA, FREE)
        string normTier = AccountMetadata.NormalizeTier(tier);
        if (!string.IsNullOrWhiteSpace(normTier))
        {
            string bgHex = normTier == "PRO" ? "#241F19" : normTier == "ULTRA" ? "#182230" : "#E4D9C8";
            string borderHex = normTier == "PRO" ? "#C9A44B" : normTier == "ULTRA" ? "#4D73AA" : "#CFC1AB";
            string textHex = normTier == "PRO" ? "#EED28B" : normTier == "ULTRA" ? "#9EC7FF" : "#7B705F";

            var tierBadge = new Border
            {
                Background = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(bgHex))),
                BorderBrush = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(borderHex))),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(5),
                Padding = new Thickness(8, 3.5, 8, 3.5),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(10, 0, 0, 0),
                Child = new TextBlock
                {
                    Text = normTier,
                    FontSize = 10.5,
                    FontWeight = FontWeights.ExtraBold,
                    Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(textHex)))
                }
            };
            DockPanel.SetDock(tierBadge, Dock.Right);
            targetDock.Children.Add(tierBadge);
        }

        // Left side: Circular Avatar with delicate gold ring
        var avatarContainer = new Grid
        {
            Width = 44,
            Height = 44,
            Margin = new Thickness(0, 0, 14, 0),
            VerticalAlignment = VerticalAlignment.Center
        };
        DockPanel.SetDock(avatarContainer, Dock.Left);

        var bitmap = LoadBitmapFromDataUrl(avatarDataUrl);
        var avatarEllipse = new Ellipse
        {
            Width = 44,
            Height = 44,
            Stroke = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#C9A44B"))),
            StrokeThickness = 2
        };

        if (bitmap != null)
        {
            avatarEllipse.Fill = new ImageBrush(bitmap) { Stretch = Stretch.UniformToFill };
            avatarContainer.Children.Add(avatarEllipse);
        }
        else
        {
            avatarEllipse.Fill = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#2B2721")));
            avatarContainer.Children.Add(avatarEllipse);
            string initial = string.IsNullOrWhiteSpace(account) ? "A" : account.Trim().Substring(0, 1).ToUpperInvariant();
            avatarContainer.Children.Add(new TextBlock
            {
                Text = initial,
                FontSize = 18,
                FontWeight = FontWeights.Bold,
                Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#EED28B"))),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            });
        }
        targetDock.Children.Add(avatarContainer);

        // Center: Details (Meta tag, Email, Name)
        var detailsStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        detailsStack.Children.Add(new TextBlock
        {
            Text = "目标切换账号",
            FontSize = 9.5,
            FontWeight = FontWeights.Bold,
            Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#8C8372"))),
            Margin = new Thickness(0, 0, 0, 2)
        });
        detailsStack.Children.Add(new TextBlock
        {
            Text = account,
            FontSize = 13.5,
            FontWeight = FontWeights.Bold,
            Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E1D1A"))),
            TextTrimming = TextTrimming.CharacterEllipsis
        });
        if (!string.IsNullOrWhiteSpace(displayName) && displayName != account)
        {
            detailsStack.Children.Add(new TextBlock
            {
                Text = displayName,
                FontSize = 11.5,
                FontWeight = FontWeights.Medium,
                Foreground = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#736B5C"))),
                Margin = new Thickness(0, 1, 0, 0)
            });
        }
        targetDock.Children.Add(detailsStack);

        targetCard.Child = targetDock;
        mainStack.Children.Add(targetCard);

        // 4. Buttons (Cancel + Proceed)
        var buttonsRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 18, 0, 0)
        };

        TargetAccount = account;
        var cancelBtn = CreateStyledButton("取消", "#EFE9DE", "#D8CFBE", "#423D34", 96, 38);
        cancelBtn.IsCancel = true;
        cancelBtn.Margin = new Thickness(0, 0, 12, 0);
        cancelBtn.Click += (_, _) => DialogResult = false;
        buttonsRow.Children.Add(cancelBtn);
        CancelButton = cancelBtn;

        var proceedBtn = CreateStyledButton("仍要切换并重启", "#1E1D1A", "#38342E", "#FAF8F3", 150, 38);
        proceedBtn.Click += (_, _) => DialogResult = true;
        buttonsRow.Children.Add(proceedBtn);
        ProceedButton = proceedBtn;

        mainStack.Children.Add(buttonsRow);
        cardBorder.Child = mainStack;
        rootGrid.Children.Add(cardBorder);

        Content = rootGrid;
        Loaded += (_, _) => cancelBtn.Focus();
    }

    private static BitmapImage? LoadBitmapFromDataUrl(string? dataUrl)
    {
        if (string.IsNullOrWhiteSpace(dataUrl)) return null;
        int commaIdx = dataUrl.IndexOf(',');
        if (commaIdx < 0) return null;
        string base64 = dataUrl.Substring(commaIdx + 1);
        try
        {
            byte[] bytes = Convert.FromBase64String(base64);
            using var stream = new MemoryStream(bytes);
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.StreamSource = stream;
            bitmap.EndInit();
            bitmap.Freeze();
            return bitmap;
        }
        catch
        {
            return null;
        }
    }

    private static Button CreateStyledButton(string text, string bgHex, string borderHex, string fgHex, double minWidth, double height)
    {
        var btn = new Button
        {
            Content = text,
            MinWidth = minWidth,
            Height = height,
            Cursor = Cursors.Hand,
            FocusVisualStyle = null,
            FontSize = 13,
            FontWeight = FontWeights.Bold
        };

        var template = new ControlTemplate(typeof(Button));
        var borderFactory = new FrameworkElementFactory(typeof(Border));
        borderFactory.Name = "btnBorder";
        borderFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(10));
        borderFactory.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        borderFactory.SetValue(Border.BackgroundProperty, Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(bgHex))));
        borderFactory.SetValue(Border.BorderBrushProperty, Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(borderHex))));

        var presenterFactory = new FrameworkElementFactory(typeof(ContentPresenter));
        presenterFactory.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenterFactory.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        presenterFactory.SetValue(TextBlock.ForegroundProperty, Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(fgHex))));

        borderFactory.AppendChild(presenterFactory);
        template.VisualTree = borderFactory;

        var hoverTrigger = new Trigger { Property = Button.IsMouseOverProperty, Value = true };
        hoverTrigger.Setters.Add(new Setter(Border.OpacityProperty, 0.88, "btnBorder"));
        template.Triggers.Add(hoverTrigger);

        var pressTrigger = new Trigger { Property = Button.IsPressedProperty, Value = true };
        pressTrigger.Setters.Add(new Setter(Border.OpacityProperty, 0.75, "btnBorder"));
        template.Triggers.Add(pressTrigger);

        btn.Template = template;
        return btn;
    }

    private static Button CreateCloseButton()
    {
        var btn = new Button
        {
            Content = "✕",
            Width = 28,
            Height = 28,
            Cursor = Cursors.Hand,
            FocusVisualStyle = null,
            FontSize = 13,
            FontWeight = FontWeights.Normal
        };

        var template = new ControlTemplate(typeof(Button));
        var borderFactory = new FrameworkElementFactory(typeof(Border));
        borderFactory.Name = "closeBorder";
        borderFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(8));
        borderFactory.SetValue(Border.BackgroundProperty, Brushes.Transparent);

        var presenterFactory = new FrameworkElementFactory(typeof(ContentPresenter));
        presenterFactory.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenterFactory.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        presenterFactory.SetValue(TextBlock.ForegroundProperty, Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#8C8372"))));

        borderFactory.AppendChild(presenterFactory);
        template.VisualTree = borderFactory;

        var hoverTrigger = new Trigger { Property = Button.IsMouseOverProperty, Value = true };
        hoverTrigger.Setters.Add(new Setter(Border.BackgroundProperty, Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#EAE2D3"))), "closeBorder"));
        hoverTrigger.Setters.Add(new Setter(TextBlock.ForegroundProperty, Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E1D1A"))), "closeBorder"));
        template.Triggers.Add(hoverTrigger);

        btn.Template = template;
        return btn;
    }
}
