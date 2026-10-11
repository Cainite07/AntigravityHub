using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;

namespace AntigravityHub
{
    public partial class App : Application
    {
        private static Mutex? _mutex;
        private static bool _ownsMutex = false;
        private const int SW_RESTORE = 9;
        private const int HWND_BROADCAST = 0xffff;
        public const string WM_SHOW_ANTIGRAVITY_HUB_MSG = "AntigravityHub_Show_Instance";

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(string? lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private static void Log(string msg) => Logger.Log("App", msg);

        protected override void OnStartup(StartupEventArgs e)
        {
            Log($"App OnStartup called. PID: {Process.GetCurrentProcess().Id}");
            const string mutexName = "Local\\AntigravityHub_SingleInstance_Mutex";
            _mutex = new Mutex(true, mutexName, out bool isNewInstance);
            _ownsMutex = isNewInstance;

            if (!isNewInstance)
            {
                Log("App OnStartup: Existing instance detected. Broadcasting wake-up signal...");
                uint msgId = RegisterWindowMessage(WM_SHOW_ANTIGRAVITY_HUB_MSG);
                PostMessage((IntPtr)HWND_BROADCAST, msgId, IntPtr.Zero, IntPtr.Zero);

                IntPtr hWnd = FindWindow(null, "AntigravityHub");
                if (hWnd != IntPtr.Zero)
                {
                    Log($"App OnStartup: Found active window 0x{hWnd:X}. Bringing to foreground.");
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                }

                Log("App OnStartup: Gracefully shutting down duplicate instance.");
                Shutdown();
                return;
            }

            Log("App OnStartup: Mutex acquired successfully.");

            AppDomain.CurrentDomain.UnhandledException += (s, args) =>
            {
                try
                {
                    string err = args.ExceptionObject?.ToString() ?? "Unknown unhandled exception";
                    Log($"UnhandledException: {err}");
                    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log"), err);
                }
                catch { }
            };
            DispatcherUnhandledException += (s, args) =>
            {
                try
                {
                    string err = args.Exception.ToString();
                    Log($"DispatcherUnhandledException: {err}");
                    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log"), err);
                }
                catch { }
            };

            base.OnStartup(e);
            var window = new MainWindow();
            MainWindow = window;
            new System.Windows.Interop.WindowInteropHelper(window).EnsureHandle();
            if (!window.StartMinimized) window.Show();
            _ = window.StartServicesAsync();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            Log($"App OnExit called with exit code: {e.ApplicationExitCode}");
            if (_ownsMutex && _mutex != null)
            {
                try
                {
                    _mutex.ReleaseMutex();
                }
                catch (Exception ex)
                {
                    Log($"OnExit ReleaseMutex exception: {ex.Message}");
                }
                finally
                {
                    try { _mutex.Dispose(); } catch { }
                    _mutex = null;
                }
            }
            base.OnExit(e);
        }
    }
}
