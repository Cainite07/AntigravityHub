using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace AntigravityHub
{
    public class TrayService : IDisposable
    {
        private readonly NotifyIcon _notifyIcon;
        private readonly Action _onRestoreWindow;
        private readonly Action<Point> _onShowTrayPopup;
        private readonly bool _ownsIcon = false;
        private bool _disposed;

        private static void Log(string msg) => Logger.Log("TrayService", msg);

        public TrayService(
            Action onRestoreWindow,
            Action<Point> onShowTrayPopup)
        {
            _onRestoreWindow = onRestoreWindow;
            _onShowTrayPopup = onShowTrayPopup;

            _notifyIcon = new NotifyIcon
            {
                Text = "AntigravityHub",
                Visible = true
            };

            try
            {
                string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                if (File.Exists(iconPath))
                {
                    _notifyIcon.Icon = new Icon(iconPath);
                    _ownsIcon = true;
                }
                else
                {
                    var exePath = Process.GetCurrentProcess().MainModule?.FileName;
                    if (!string.IsNullOrEmpty(exePath) && File.Exists(exePath))
                    {
                        _notifyIcon.Icon = Icon.ExtractAssociatedIcon(exePath);
                        _ownsIcon = true;
                    }
                }
            }
            catch { }

            if (_notifyIcon.Icon == null)
            {
                _notifyIcon.Icon = SystemIcons.Application;
                _ownsIcon = false;
            }

            _notifyIcon.MouseDoubleClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    Log("NotifyIcon MouseDoubleClick (Left). Restoring window.");
                    _onRestoreWindow();
                }
            };

            _notifyIcon.MouseUp += (s, e) =>
            {
                if (e.Button == MouseButtons.Right)
                {
                    Log($"NotifyIcon MouseUp (Right). Cursor=({Cursor.Position.X},{Cursor.Position.Y}). Triggering popup.");
                    _onShowTrayPopup(Cursor.Position);
                }
            };
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                _notifyIcon.Visible = false;
                if (_ownsIcon)
                {
                    _notifyIcon.Icon?.Dispose();
                }
                _notifyIcon.Dispose();
            }
            catch { }
        }
    }
}
