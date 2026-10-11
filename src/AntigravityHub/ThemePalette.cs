using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Interop;
using Microsoft.Win32;
namespace AntigravityHub;
internal static class ThemePalette
{
    public static bool IsDark(string theme) => theme == "dark" || theme == "system" && (int)(Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) ?? 1) == 0;
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    public static void Frame(Window window, bool dark)
    {
        int value = dark ? 1 : 0;
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd != IntPtr.Zero) { DwmSetWindowAttribute(hwnd, 20, ref value, 4); value = dark ? 0x001E1B19 : 0x00EEF5F7; DwmSetWindowAttribute(hwnd, 34, ref value, 4); }
    }
    private static readonly System.Collections.Generic.Dictionary<string,SolidColorBrush> Brushes = new();
    private static SolidColorBrush Brush(string color)
    {
        if(!Brushes.TryGetValue(color,out var brush)){brush=new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));brush.Freeze();Brushes[color]=brush;}
        return brush;
    }
    static readonly System.Runtime.CompilerServices.ConditionalWeakTable<DependencyObject, System.Collections.Generic.Dictionary<DependencyProperty, object>> Originals = new();
    public static void Tree(DependencyObject node, bool dark) => Walk(node,dark,new System.Collections.Generic.HashSet<DependencyObject>());
    private static void Walk(DependencyObject node, bool dark, System.Collections.Generic.HashSet<DependencyObject> visited)
    {
        if(!visited.Add(node)) return;
        var props = node is Control ? new[] {Control.BackgroundProperty, Control.ForegroundProperty, Control.BorderBrushProperty} : node is Border ? new[] {Border.BackgroundProperty, Border.BorderBrushProperty} : node is Panel ? new[] {Panel.BackgroundProperty} : node is TextBlock ? new[] {TextBlock.ForegroundProperty} : Array.Empty<DependencyProperty>();
        var originals = Originals.GetOrCreateValue(node);
        // Capture descendants before changing inherited parent foregrounds.
        foreach(var child in LogicalTreeHelper.GetChildren(node))
            if(child is DependencyObject dependency) Walk(dependency,dark,visited);
        if(node is Visual)
            for(int i=0;i<VisualTreeHelper.GetChildrenCount(node);i++) Walk(VisualTreeHelper.GetChild(node,i),dark,visited);
        foreach (var prop in props)
        {
            if (!originals.ContainsKey(prop)) originals[prop] = node.GetValue(prop);
            var original = originals[prop];
            if (dark && original is SolidColorBrush brush && brush.Color.A > 0)
            {
                var c = brush.Color;
                string color = prop.Name == "Foreground" ? (c.G > c.R * 1.15 ? "#9DC3A4" : c.R > c.G * 1.25 ? "#DAB779" : "#E8E5DE") : prop.Name == "BorderBrush" ? "#3B3E43" : c.R + c.G + c.B > 470 ? "#272A2E" : "#35383D";
                node.SetValue(prop, Brush(color));
            }
            else node.SetValue(prop, original);
        }
    }
}
