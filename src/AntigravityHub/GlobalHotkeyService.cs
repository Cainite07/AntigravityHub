using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;

namespace AntigravityHub
{
    public class GlobalHotkeyService : IDisposable
    {
        private const int HOTKEY_ID = 9001;
        private const int WM_HOTKEY = 0x0312;

        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_SHIFT = 0x0004;
        private const uint MOD_WIN = 0x0008;
        private const uint MOD_NOREPEAT = 0x4000;

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        private IntPtr _hWnd;
        private HwndSource? _source;
        private Action? _onHotkeyPressed;
        private bool _isRegistered;

        public void Initialize(Window window, Action onHotkeyPressed)
        {
            _onHotkeyPressed = onHotkeyPressed;
            _hWnd = new WindowInteropHelper(window).Handle;
            _source = HwndSource.FromHwnd(_hWnd);
            _source?.AddHook(HwndHook);
        }

        public bool Register(string hotkeyStr)
        {
            Unregister();
            if (_hWnd == IntPtr.Zero || string.IsNullOrWhiteSpace(hotkeyStr)) return false;

            try
            {
                if (!ParseHotkey(hotkeyStr, out uint modifiers, out uint vk))
                {
                    return false;
                }

                _isRegistered = RegisterHotKey(_hWnd, HOTKEY_ID, modifiers | MOD_NOREPEAT, vk);
                return _isRegistered;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[HotkeyService] Register error: {ex.Message}");
                return false;
            }
        }

        public void Unregister()
        {
            if (_isRegistered && _hWnd != IntPtr.Zero)
            {
                try
                {
                    UnregisterHotKey(_hWnd, HOTKEY_ID);
                }
                catch { }
                _isRegistered = false;
            }
        }

        private IntPtr HwndHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WM_HOTKEY && wParam.ToInt32() == HOTKEY_ID)
            {
                _onHotkeyPressed?.Invoke();
                handled = true;
            }
            return IntPtr.Zero;
        }

        private static bool ParseHotkey(string text, out uint modifiers, out uint vk)
        {
            modifiers = 0;
            vk = 0;

            if (string.IsNullOrWhiteSpace(text)) return false;

            string normalized = text.Trim();
            // Handle cases where the hotkey itself is the '+' character (e.g. "Ctrl + +" or "+")
            if (normalized.EndsWith("++") || normalized.EndsWith("+ +") || (normalized.EndsWith("+") && normalized.Length > 1))
            {
                int lastPlus = normalized.LastIndexOf('+');
                normalized = normalized.Substring(0, lastPlus) + "+ PLUS";
            }
            else if (normalized == "+")
            {
                normalized = "PLUS";
            }

            var parts = normalized.Split(new[] { '+', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return false;

            string keyName = "";
            foreach (var p in parts)
            {
                string upper = p.Trim().ToUpperInvariant();
                if (upper is "CTRL" or "CONTROL")
                    modifiers |= MOD_CONTROL;
                else if (upper is "ALT")
                    modifiers |= MOD_ALT;
                else if (upper is "SHIFT")
                    modifiers |= MOD_SHIFT;
                else if (upper is "WIN" or "WINDOWS")
                    modifiers |= MOD_WIN;
                else
                {
                    if (!string.IsNullOrEmpty(keyName)) return false;
                    keyName = p.Trim();
                }
            }

            if (string.IsNullOrEmpty(keyName)) return false;

            // Try standard WPF Key parse
            if (Enum.TryParse<Key>(keyName, true, out var wpfKey))
            {
                vk = (uint)KeyInterop.VirtualKeyFromKey(wpfKey);
                if (vk > 0) return true;
            }

            // OEM symbols and common key mappings
            switch (keyName.ToUpperInvariant())
            {
                case "~":
                case "`":
                case "TILDE":
                case "BACKQUOTE":
                case "GRAVE":
                    vk = 0xC0; // VK_OEM_3
                    return true;
                case "-":
                case "_":
                case "MINUS":
                case "SUBTRACT":
                    vk = 0xBD; // VK_OEM_MINUS
                    return true;
                case "=":
                case "+":
                case "EQUALS":
                case "PLUS":
                    vk = 0xBB; // VK_OEM_PLUS
                    return true;
                case "[":
                case "{":
                case "OPENBRACKET":
                case "BRACKETLEFT":
                    vk = 0xDB; // VK_OEM_4
                    return true;
                case "]":
                case "}":
                case "CLOSEBRACKET":
                case "BRACKETRIGHT":
                    vk = 0xDD; // VK_OEM_6
                    return true;
                case "\\":
                case "|":
                case "BACKSLASH":
                    vk = 0xDC; // VK_OEM_5
                    return true;
                case ";":
                case ":":
                case "SEMICOLON":
                    vk = 0xBA; // VK_OEM_1
                    return true;
                case "'":
                case "\"":
                case "QUOTE":
                case "QUOTES":
                    vk = 0xDE; // VK_OEM_7
                    return true;
                case ",":
                case "<":
                case "COMMA":
                    vk = 0xBC; // VK_OEM_COMMA
                    return true;
                case ".":
                case ">":
                case "PERIOD":
                case "DOT":
                    vk = 0xBE; // VK_OEM_PERIOD
                    return true;
                case "/":
                case "?":
                case "SLASH":
                case "QUESTION":
                    vk = 0xBF; // VK_OEM_2
                    return true;
                case "ESC":
                case "ESCAPE":
                    vk = 0x1B; // VK_ESCAPE
                    return true;
                case "TAB":
                    vk = 0x09; // VK_TAB
                    return true;
                case "SPACE":
                    vk = 0x20; // VK_SPACE
                    return true;
                case "ENTER":
                case "RETURN":
                    vk = 0x0D; // VK_RETURN
                    return true;
                case "BACKSPACE":
                case "BACK":
                    vk = 0x08; // VK_BACK
                    return true;
            }

            // Fallback for single char
            if (keyName.Length == 1)
            {
                char c = char.ToUpperInvariant(keyName[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
                {
                    vk = (uint)c;
                    return true;
                }
            }

            return false;
        }

        public void Dispose()
        {
            Unregister();
            if (_source != null && _hWnd != IntPtr.Zero)
            {
                _source.RemoveHook(HwndHook);
                // HwndSource belongs to the window; only remove our hook.
                _source = null;
            }
        }
    }
}
