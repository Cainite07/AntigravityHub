using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;

namespace AntigravityHub;

public enum IdeActivityState { Idle, Busy, Unknown }

public sealed record IdeActivity(IdeActivityState State, int TaskCount, string Fingerprint)
{
    public bool NeedsConfirmation => State != IdeActivityState.Idle;
    public string Description => State == IdeActivityState.Busy
        ? $"检测到 {TaskCount} 个 Antigravity 任务正在运行或等待操作。切换账号会重启客户端，可能中断这些任务。"
        : "Antigravity 正在运行，但无法确认当前任务状态。切换账号会重启客户端，可能中断正在执行的工作。";
    public static IdeActivity Idle => new(IdeActivityState.Idle, 0, "idle");
    public static IdeActivity Unknown => new(IdeActivityState.Unknown, 0, "unknown");

    internal static Task<IdeActivity> ReadAsync(string executable, CancellationToken cancellationToken) => Task.Run(() =>
    {
        bool running = false, unreadable = false;
        foreach (string name in new[] { "Antigravity", "language_server" })
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                using (process)
                {
                    try
                    {
                        string? processPath = process.MainModule?.FileName;
                        running |= name == "Antigravity" ? string.Equals(processPath, executable, StringComparison.OrdinalIgnoreCase)
                            : AccountSafety.IsOwnedProcess(processPath, Path.GetDirectoryName(executable)!);
                    }
                    catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { unreadable = true; }
                }
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (unreadable) return Unknown;
        if (!running) return Idle;
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "antigravity", "conversation_summaries.db");
        return ReadDatabase(path, cancellationToken);
    }, cancellationToken);

    // This is the client's persisted AI task state, not a claim about arbitrary terminal/background jobs.
    // Missing/changed schemas and read failures require confirmation, never an assumed idle state.
    internal static IdeActivity ReadDatabase(string path, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(path)) return Unknown;
        try
        {
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
                { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false, DefaultTimeout = 2 }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT conversation_id,status,not_fully_idle,killed FROM conversation_summaries";
            using var reader = command.ExecuteReader();
            var active = new System.Collections.Generic.List<string>();
            bool unknown = false;
            while (reader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (reader.IsDBNull(3) || reader.IsDBNull(2) || reader.IsDBNull(1) || reader.IsDBNull(0)) { unknown = true; continue; }
                if (reader.GetBoolean(3)) continue;
                string status = reader.GetString(1);
                bool busy = reader.GetBoolean(2) || status == "CASCADE_RUN_STATUS_RUNNING";
                if (busy) active.Add(reader.GetString(0));
                else if (status != "CASCADE_RUN_STATUS_IDLE") unknown = true;
            }
            if (active.Count == 0) return unknown ? Unknown : Idle;
            // Include uncertainty in the approval scope so a newly discovered task triggers a fresh request.
            string scope = string.Join("\n", active.OrderBy(id => id, StringComparer.Ordinal)) + (unknown ? "\nunknown" : "");
            return new(IdeActivityState.Busy, active.Count, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope))));
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidCastException or FormatException)
        { return Unknown; }
    }
}
