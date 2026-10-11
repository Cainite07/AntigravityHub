using System;
using System.IO;

namespace AntigravityHub
{
    internal static class Logger
    {
        private static readonly object _lock = new();
        private static readonly string _logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.log");
        private const long MaxLogSizeBytes = 5 * 1024 * 1024; // 5 MB

        public static void Log(string source, string msg)
        {
            lock (_lock)
            {
                try
                {
                    if (File.Exists(_logPath))
                    {
                        var fi = new FileInfo(_logPath);
                        if (fi.Length >= MaxLogSizeBytes)
                        {
                            string backupPath = _logPath + ".old";
                            if (File.Exists(backupPath))
                            {
                                File.Delete(backupPath);
                            }
                            File.Move(_logPath, backupPath);
                        }
                    }

                    File.AppendAllText(_logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{source}] {msg}\n");
                }
                catch { }
            }
        }
    }
}
