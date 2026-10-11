using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace AntigravityHub
{
    public class DbCursor
    {
        public long Size { get; set; }
        public long MtimeMs { get; set; }
        public int LastIdx { get; set; }
        public long WalSize { get; set; }
        public long WalMtimeMs { get; set; }
    }

    public class FileCursor
    {
        public long Size { get; set; }
        public long MtimeMs { get; set; }
        public int LastLine { get; set; }
        public long ContextTokens { get; set; }
        public long PrevContextTokens { get; set; }
        public string? CurrentModel { get; set; }
        public string? LastPlannerModel { get; set; }
    }

    public class CursorsState
    {
        public Dictionary<string, DbCursor> Databases { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, FileCursor> Files { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, (long tokens, int reqs)> ProcessedBuckets { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }



    public class NativeTokenTracker
    {


        private static readonly object _syncLock = new object();
        private readonly string _geminiHome;
        private readonly string _tokensPath;

        public NativeTokenTracker()
        {
            HubStorage.EnsureInitialized();
            _geminiHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini");
            _tokensPath = HubStorage.TokensJsonl;
        }

        public async Task<int> ScanAndAggregateAsync(bool forceRebuild = false, CancellationToken cancellationToken = default)
        {
            return await Task.Run(() =>
            {
                lock (_syncLock)
                {
                    var repository = new UsageRepository(UsageRepository.DefaultPath);
                    bool initialized = repository.IsInitialized();
                    var cursors = repository.LoadCursors();
                    var knownHours = repository.LoadEventHours();
                    var events = new List<UsageEvent>();
                    var failures = new List<string>();
                    var databases = FindDatabaseFiles();
                    if (!initialized && databases.Count == 0) return 0;
                    foreach (string dbPath in databases)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        try
                        {
                            var file = new FileInfo(dbPath);
                            var wal = new FileInfo(dbPath + "-wal");
                            var cursor = new DbCursor { Size = file.Length,
                                MtimeMs = new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                                WalSize = wal.Exists ? wal.Length : 0,
                                WalMtimeMs = wal.Exists ? new DateTimeOffset(wal.LastWriteTimeUtc).ToUnixTimeMilliseconds() : 0 };
                            string source = (Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(dbPath))) + ":" + Path.GetFileName(dbPath)).ToLowerInvariant();
                            cursors.Databases.TryGetValue(source, out var previous);
                            if (initialized && !forceRebuild && previous != null && previous.Size == cursor.Size &&
                                previous.MtimeMs == cursor.MtimeMs && previous.WalSize == cursor.WalSize && previous.WalMtimeMs == cursor.WalMtimeMs)
                                continue;
                            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
                            { DataSource = dbPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false, DefaultTimeout = 3 }.ToString());
                            connection.Open();
                            // A read transaction ensures steps and usage belong to the same source snapshot.
                            using var snapshot = connection.BeginTransaction(deferred: true);
                            var stepTimes = ReadStepTimestamps(connection);
                            var transcriptTimes = ReadTranscriptTimestamps(ResolveTranscriptPath(dbPath));
                            // Re-read changed databases, not just idx > LastIdx: old rows can be completed in place.
                            var usages = ReadDbServerUsages(connection, -1, out int highestIdx);
                            foreach (var item in usages)
                            {
                                cancellationToken.ThrowIfCancellationRequested();
                                var usage = item.usage;
                                DateTime eventTime = file.LastWriteTimeUtc;
                                bool located = false;
                                if (usage.LastStepIndex is int step)
                                {
                                    if (transcriptTimes.TryGetValue(step + 1, out var t1)) { eventTime = t1; located = true; }
                                    else if (stepTimes.TryGetValue(step + 1, out var s1)) { eventTime = s1; located = true; }
                                    else if (stepTimes.TryGetValue(step, out var s0)) { eventTime = s0; located = true; }
                                    else if (transcriptTimes.TryGetValue(step, out var t0)) { eventTime = t0; located = true; }
                                }
                                string hour = !located && knownHours.TryGetValue((source, item.idx), out var oldHour)
                                    ? oldHour : ToUtcHalfHourStart(eventTime);
                                var bucket = new UsageBucket { model = usage.Model, hour_start = hour,
                                    input_tokens = usage.InputTokens, cached_input_tokens = usage.CacheReadTokens,
                                    cache_creation_input_tokens = usage.CacheWriteTokens, output_tokens = usage.ResponseOutputTokens,
                                    reasoning_output_tokens = usage.ThinkingOutputTokens, total_tokens = usage.TotalTokens, conversation_count = 1 };
                                // Include time in the identity of a revision, so a later exact timestamp replaces a fallback.
                                events.Add(new UsageEvent(source, item.idx, item.fingerprint + "|" + hour, bucket));
                            }
                            snapshot.Commit();
                            cursor.LastIdx = highestIdx;
                            cursors.Databases[source] = cursor;
                        }
                        catch (OperationCanceledException) { throw; }
                        catch (Exception ex)
                        {
                            failures.Add(Path.GetFileName(dbPath));
                            System.Diagnostics.Debug.WriteLine($"[NativeTokenTracker] Source read failed: {ex.Message}");
                        }
                    }
                    cancellationToken.ThrowIfCancellationRequested();
                    // Never baseline a partial first scan: a retry could count unseen historical events twice.
                    if (!initialized && failures.Count > 0) throw new IOException("历史迁移未提交：部分会话数据库暂时无法读取，请重试。");
                    int changed = repository.Commit(events, cursors, _tokensPath);
                    if (failures.Count > 0) throw new IOException($"部分用量已更新，{failures.Count} 个会话读取失败，下次将重试。");
                    return changed;
                }
            }, cancellationToken);
        }

        private List<string> FindDatabaseFiles()
        {
            var list = new List<string>();
            string[] dirs = new[]
            {
                Path.Combine(_geminiHome, "antigravity", "conversations"),
                Path.Combine(_geminiHome, "antigravity-ide", "conversations")
            };

            foreach (var dir in dirs)
            {
                if (!Directory.Exists(dir)) continue;
                try
                {
                    foreach (var dbFile in Directory.GetFiles(dir, "*.db"))
                    {
                        list.Add(dbFile);
                    }
                }
                catch (Exception ex) { throw new IOException("无法读取会话目录，请检查权限后重试。", ex); }
            }
            return list;
        }

        private static string ResolveTranscriptPath(string dbPath)
        {
            try
            {
                string convId = Path.GetFileNameWithoutExtension(dbPath);
                string? convDir = Path.GetDirectoryName(dbPath);
                string? rootDir = Path.GetDirectoryName(convDir);
                if (rootDir == null) return "";
                return Path.Combine(rootDir, "brain", convId, ".system_generated", "logs", "transcript.jsonl");
            }
            catch
            {
                return "";
            }
        }

        private static Dictionary<int, DateTime> ReadTranscriptTimestamps(string transPath)
        {
            var map = new Dictionary<int, DateTime>();
            if (!File.Exists(transPath)) return map;
            try
            {
                using var fs = new FileStream(transPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var sr = new StreamReader(fs);
                string? line;
                while ((line = sr.ReadLine()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        using var doc = JsonDocument.Parse(line);
                        var root = doc.RootElement;
                        int si = root.TryGetProperty("step_index", out var siElem) ? siElem.GetInt32() : -1;
                        string? ca = root.TryGetProperty("created_at", out var caElem) ? caElem.GetString() : null;
                        if (si >= 0 && !string.IsNullOrEmpty(ca) && DateTimeOffset.TryParse(ca, out var dto))
                        {
                            map[si] = dto.UtcDateTime;
                        }
                    }
                    catch { }
                }
            }
            catch { }
            return map;
        }

        private static Dictionary<int, DateTime> ReadStepTimestamps(SqliteConnection conn)
        {
            var map = new Dictionary<int, DateTime>();
            try
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL";
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    int idx = reader.GetInt32(0);
                    if (reader.IsDBNull(1)) continue;

                    if (reader.GetValue(1) is byte[] data)
                    {
                        if (UsageDecoder.TryReadTimestamp(data, out var timestamp)) map[idx] = timestamp;
                    }
                }
            }
            catch { }
            return map;
        }

        private static List<(int idx, ServerUsage usage, string fingerprint)> ReadDbServerUsages(SqliteConnection conn, int minIdx, out int highestIdx)
        {
            var list = new List<(int idx, ServerUsage usage, string fingerprint)>();
            highestIdx = minIdx;

            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT idx, data FROM gen_metadata WHERE idx > @minIdx ORDER BY idx";
                cmd.Parameters.AddWithValue("@minIdx", minIdx);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    int idx = reader.GetInt32(0);
                    if (idx > highestIdx) highestIdx = idx;
                    if (reader.IsDBNull(1)) continue;

                    if (reader.GetValue(1) is byte[] data)
                    {
                        var usage = ExtractServerUsage(data);
                        if (usage != null)
                        {
                            list.Add((idx, usage, Convert.ToHexString(SHA256.HashData(data))));
                        }
                    }
                }
            }

            return list;
        }

        private static ServerUsage? ExtractServerUsage(byte[] data) => UsageDecoder.Decode(data);

        public static int EstimateTokens(string? text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            int cjk = 0;
            int other = 0;
            foreach (char ch in text)
            {
                int code = (int)ch;
                if ((code >= 0x3400 && code <= 0x4dbf) ||
                    (code >= 0x4e00 && code <= 0x9fff) ||
                    (code >= 0x3040 && code <= 0x30ff))
                {
                    cjk++;
                }
                else
                {
                    other++;
                }
            }
            return cjk + (int)Math.Ceiling(other / 4.0);
        }



        private static string ToUtcHalfHourStart(DateTime dt)
        {
            var utc = dt.ToUniversalTime();
            int minute = utc.Minute < 30 ? 0 : 30;
            var floored = new DateTime(utc.Year, utc.Month, utc.Day, utc.Hour, minute, 0, DateTimeKind.Utc);
            return floored.ToString("yyyy-MM-ddTHH:mm:ss.000Z");
        }

    }
}
