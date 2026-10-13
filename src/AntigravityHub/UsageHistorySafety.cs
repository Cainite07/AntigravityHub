using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace AntigravityHub;

// Usage only: no account credentials or conversation text. Backups live outside
// both the installation and .antigravity_hub, so removing either keeps history.
internal static class UsageHistorySafety
{
    private static readonly object Gate = new();
    private sealed record State(long Events, long Originals, long Residuals, long Tokens, string ContentHash);
    internal static string BackupDirectory(string database)
    {
        string production = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".antigravity_hub", "usage.sqlite3");
        return string.Equals(Path.GetFullPath(database), production, StringComparison.OrdinalIgnoreCase)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "AntigravityHub", "历史备份")
            : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(database))!, "history-backups");
    }
    private static SqliteConnection Connect(string file, bool readOnly = true)
    {
        var c = new SqliteConnection(new SqliteConnectionStringBuilder {
            DataSource = file, Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate,
            Pooling = false, DefaultTimeout = 15 }.ToString());
        c.Open(); return c;
    }
    private static State Inspect(string file)
    {
        using var c = Connect(file); using var q = c.CreateCommand();
        q.CommandText = "PRAGMA quick_check";
        if ((string?)q.ExecuteScalar() != "ok") throw new InvalidDataException("Invalid usage backup");
        q.CommandText = "SELECT value FROM meta WHERE key='ready'";
        if ((string?)q.ExecuteScalar() != "1") throw new InvalidDataException("Incomplete usage backup");
        q.CommandText = "SELECT (SELECT count(*) FROM events),(SELECT count(*) FROM legacy_original),(SELECT count(*) FROM legacy_residual),COALESCE((SELECT sum(total_tokens) FROM bucket_aggregates),0)";
        long events, originals, residuals, tokens;
        using (var r = q.ExecuteReader()) { r.Read(); events=r.GetInt64(0); originals=r.GetInt64(1); residuals=r.GetInt64(2); tokens=r.GetInt64(3); }
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        q.CommandText="SELECT json_array(model_key,hour_start,model,input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,conversation_count) FROM bucket_aggregates ORDER BY model_key,hour_start";
        using (var r=q.ExecuteReader()) while(r.Read()) hash.AppendData(Encoding.UTF8.GetBytes(r.GetString(0)+"\n"));
        return new State(events, originals, residuals, tokens, Convert.ToHexString(hash.GetHashAndReset()));
    }
    private static string? Latest(string directory)
    {
        if (!Directory.Exists(directory)) return null;
        foreach (string file in Directory.GetFiles(directory, "usage-????-??-??.sqlite3").OrderByDescending(Path.GetFileName))
            try { if (Inspect(file).Tokens > 0) return file; } catch { }
        return null;
    }
    private static void Snapshot(string source, string target)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        string temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var input = Connect(source)) using (var output = Connect(temporary, false)) input.BackupDatabase(output);
            Inspect(temporary);
            File.Move(temporary, target, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    internal static void RestoreMissing(string database)
    {
        lock (Gate)
        {
            if (File.Exists(database)) return;
            string? source = Latest(BackupDirectory(database));
            if (source == null) return;
            Snapshot(source, database);
            Logger.Log("History protection", "Restored missing usage ledger from independent backup.");
        }
    }
    internal static void Protect(string database, DateTime? day = null)
    {
        lock (Gate)
        {
            RestoreMissing(database);
            if (!File.Exists(database)) return;
            State current = Inspect(database);
            if (current.Tokens <= 0) return;
            string directory = BackupDirectory(database);
            string? previous = Latest(directory);
            if (previous != null)
            {
                State old = Inspect(previous);
                if (new UsageRepository(database).HasMissingHistory(previous))
                {
                    new UsageRepository(database).MergeMissingHistory(previous);
                    current = Inspect(database);
                    if (current.Events < old.Events || current.Originals < old.Originals || current.Residuals < old.Residuals)
                        throw new InvalidDataException("Historical recovery did not retain all records");
                    Logger.Log("History protection", "Merged missing historical rows; current rows and cursors retained.");
                }
            }
            string target = Path.Combine(directory, "usage-" + (day ?? DateTime.Today).ToString("yyyy-MM-dd") + ".sqlite3");
            bool unchanged=false;
            if(File.Exists(target)) try { unchanged=Inspect(target)==current; } catch { }
            if (!unchanged) Snapshot(database, target);
            // Retain seven daily complete snapshots; never prune other file types.
            foreach (string file in Directory.GetFiles(directory, "usage-????-??-??.sqlite3").OrderByDescending(Path.GetFileName).Skip(7))
                File.Delete(file);
        }
    }
}
