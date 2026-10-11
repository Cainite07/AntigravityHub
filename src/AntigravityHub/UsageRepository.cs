using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace AntigravityHub
{
    internal sealed class UsageBucket
    {
        public string model { get; set; } = "unknown";
        public string hour_start { get; set; } = "";
        public long input_tokens { get; set; }
        public long cached_input_tokens { get; set; }
        public long cache_creation_input_tokens { get; set; }
        public long output_tokens { get; set; }
        public long reasoning_output_tokens { get; set; }
        public long total_tokens { get; set; }
        public int conversation_count { get; set; }
        public string usage_source { get; set; } = "server_model_usage_stats";
        public string Key => model.ToLowerInvariant() + "|" + hour_start;
        public void Add(UsageBucket b)
        {
            input_tokens += b.input_tokens; cached_input_tokens += b.cached_input_tokens;
            cache_creation_input_tokens += b.cache_creation_input_tokens; output_tokens += b.output_tokens;
            reasoning_output_tokens += b.reasoning_output_tokens; total_tokens += b.total_tokens;
            conversation_count += b.conversation_count;
        }
    }

    internal sealed record UsageEvent(string Source, int Index, string Fingerprint, UsageBucket Bucket);

    // The authoritative store commits events and source cursors in the same transaction.
    // tokens.jsonl is an immutable migration input, never the second half of a commit.
    internal sealed class UsageRepository
    {
        private readonly string _path;
        private static readonly object SchemaGate = new();
        public UsageRepository(string path) { _path = path; }
        public static string DefaultPath => Path.Combine(HubStorage.HubDir, "usage.sqlite3");

        private SqliteConnection Open()
        {
            var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = _path, Pooling = false, DefaultTimeout = 10 }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = @"
                PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (source TEXT NOT NULL, idx INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source,idx));
                CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS legacy_original (line INTEGER PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS legacy_residual (key TEXT PRIMARY KEY, payload TEXT NOT NULL);";
            command.ExecuteNonQuery();
            EnsureAggregates(connection);
            return connection;
        }

        // Model/hour buckets retain the original model identifier and local-day attribution.
        // SQLite triggers maintain signed deltas in the same event/cursor transaction.
        private static readonly string[] AggregateFields = { "input_tokens", "cached_input_tokens",
            "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "conversation_count" };
        private static string JsonValue(string row, string field, string fallback = "0") =>
            $"COALESCE(json_extract({row},'$.{field}'),{fallback})";

        private void EnsureAggregates(SqliteConnection connection)
        {
            lock (SchemaGate)
            {
                using var check = connection.CreateCommand();
                check.CommandText = "SELECT value FROM meta WHERE key='aggregate_schema'";
                if (check.ExecuteScalar() as string == "1") return;
                check.CommandText = "SELECT value FROM meta WHERE key='ready'";
                if (check.ExecuteScalar() as string == "1")
                {
                    string directory = Path.Combine(Path.GetDirectoryName(_path)!, "backups");
                    Directory.CreateDirectory(directory);
                    using var backup = new SqliteConnection(new SqliteConnectionStringBuilder {
                        DataSource=Path.Combine(directory,"usage.before-aggregates."+Guid.NewGuid().ToString("N")+".sqlite3"),Pooling=false }.ToString());
                    backup.Open(); connection.BackupDatabase(backup);
                }
                using var transaction = connection.BeginTransaction();
                using var setup = connection.CreateCommand(); setup.Transaction = transaction;
                var sql = new System.Text.StringBuilder("CREATE TABLE IF NOT EXISTS bucket_aggregates (model_key TEXT NOT NULL,hour_start TEXT NOT NULL,model TEXT NOT NULL,");
                sql.Append(string.Join(",",AggregateFields.Select(f=>f+" INTEGER NOT NULL")));
                sql.Append(",PRIMARY KEY(model_key,hour_start));");
                foreach(string table in new[] {"events","legacy_residual"})
                foreach(string operation in new[] {"INSERT","UPDATE","DELETE"})
                {
                    sql.Append($"CREATE TRIGGER IF NOT EXISTS aggregate_{table}_{operation.ToLowerInvariant()} AFTER {operation} ON {table} BEGIN ");
                    if(operation != "INSERT")
                    {
                        sql.Append("UPDATE bucket_aggregates SET ");
                        sql.Append(string.Join(",",AggregateFields.Select(f=>$"{f}={f}-"+JsonValue("OLD.payload",f))));
                        sql.Append($" WHERE model_key=lower({JsonValue("OLD.payload","model","'unknown'")}) AND hour_start={JsonValue("OLD.payload","hour_start","''")};");
                    }
                    if(operation != "DELETE")
                    {
                        sql.Append($"INSERT INTO bucket_aggregates VALUES(lower({JsonValue("NEW.payload","model","'unknown'")}),{JsonValue("NEW.payload","hour_start","''")},{JsonValue("NEW.payload","model","'unknown'")},");
                        sql.Append(string.Join(",",AggregateFields.Select(f=>JsonValue("NEW.payload",f))));
                        sql.Append(") ON CONFLICT(model_key,hour_start) DO UPDATE SET ");
                        sql.Append(string.Join(",",AggregateFields.Select(f=>$"{f}={f}+excluded.{f}"))); sql.Append(';');
                    }
                    sql.Append("END;");
                }
                sql.Append("DELETE FROM bucket_aggregates;");
                sql.Append($"INSERT INTO bucket_aggregates SELECT lower({JsonValue("payload","model","'unknown'")}),{JsonValue("payload","hour_start","''")},{JsonValue("payload","model","'unknown'")},");
                sql.Append(string.Join(",",AggregateFields.Select(f=>"SUM("+JsonValue("payload",f)+")")));
                sql.Append($" FROM (SELECT payload FROM events UNION ALL SELECT payload FROM legacy_residual) GROUP BY lower({JsonValue("payload","model","'unknown'")}),{JsonValue("payload","hour_start","''")};");
                sql.Append("INSERT INTO meta VALUES('aggregate_schema','1');");
                setup.CommandText = sql.ToString(); setup.ExecuteNonQuery(); transaction.Commit();
            }
        }

        public bool IsInitialized()
        {
            if (!File.Exists(_path)) return false;
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key='ready'";
            return command.ExecuteScalar() as string == "1";
        }

        public CursorsState LoadCursors()
        {
            var state = new CursorsState();
            if (!IsInitialized()) return state;
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT source,payload FROM cursors";
            using var reader = command.ExecuteReader();
            while (reader.Read()) state.Databases[reader.GetString(0)] =
                JsonSerializer.Deserialize<DbCursor>(reader.GetString(1)) ?? throw new InvalidDataException("Invalid usage cursor");
            return state;
        }

        public Dictionary<(string source, int index), string> LoadEventHours()
        {
            var hours = new Dictionary<(string, int), string>();
            if (!IsInitialized()) return hours;
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT source,idx,COALESCE(json_extract(payload,'$.hour_start'),'') FROM events";
            using var reader = command.ExecuteReader();
            while (reader.Read()) hours[(reader.GetString(0), reader.GetInt32(1))] = reader.GetString(2);
            return hours;
        }

        public int Commit(IReadOnlyList<UsageEvent> events, CursorsState cursors, string legacyPath)
        {
            bool initialized = IsInitialized();
            var originals = !initialized && File.Exists(legacyPath)
                ? File.ReadAllLines(legacyPath).Where(s => !string.IsNullOrWhiteSpace(s)).ToArray()
                : Array.Empty<string>();
            var residual = new Dictionary<string, UsageBucket>();
            if (!initialized)
            {
                // Parse before modifying the store; malformed history must not be silently dropped.
                foreach (string json in originals)
                {
                    var bucket = JsonSerializer.Deserialize<UsageBucket>(json) ?? throw new InvalidDataException("Invalid historical usage");
                    if (bucket.total_tokens < 0 || bucket.input_tokens < 0 || bucket.cached_input_tokens < 0 ||
                        bucket.cache_creation_input_tokens < 0 || bucket.output_tokens < 0 || bucket.reasoning_output_tokens < 0)
                        throw new InvalidDataException("Negative historical usage");
                    if (DateTimeOffset.TryParse(bucket.hour_start, out var date))
                        bucket.hour_start = date.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.000Z");
                    if (!residual.TryGetValue(bucket.Key, out var aggregate))
                        residual[bucket.Key] = aggregate = new UsageBucket { model = bucket.model, hour_start = bucket.hour_start };
                    aggregate.Add(bucket);
                }
                // Match only the same model/hour. Unmatched legacy history is retained.
                foreach (var group in events.GroupBy(e => e.Bucket.Key))
                {
                    if (!residual.TryGetValue(group.Key, out var old)) continue;
                    var current = new UsageBucket();
                    foreach (var item in group) current.Add(item.Bucket);
                    old.input_tokens = Math.Max(0, old.input_tokens - current.input_tokens);
                    old.cached_input_tokens = Math.Max(0, old.cached_input_tokens - current.cached_input_tokens);
                    old.cache_creation_input_tokens = Math.Max(0, old.cache_creation_input_tokens - current.cache_creation_input_tokens);
                    old.output_tokens = Math.Max(0, old.output_tokens - current.output_tokens);
                    old.reasoning_output_tokens = Math.Max(0, old.reasoning_output_tokens - current.reasoning_output_tokens);
                    old.total_tokens = Math.Max(Math.Max(0, old.total_tokens - current.total_tokens),
                        old.input_tokens + old.cached_input_tokens + old.cache_creation_input_tokens + old.output_tokens + old.reasoning_output_tokens);
                    old.conversation_count = Math.Max(0, old.conversation_count - current.conversation_count);
                    old.usage_source = "unattributed_legacy_history";
                }
                if (File.Exists(legacyPath))
                {
                    string backupDir = Path.Combine(Path.GetDirectoryName(_path)!, "backups");
                    Directory.CreateDirectory(backupDir);
                    File.Copy(legacyPath, Path.Combine(backupDir, "tokens.before-ledger." + Guid.NewGuid().ToString("N") + ".jsonl"));
                }
            }
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            int changed = 0;
            foreach (var item in events)
            {
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = @"INSERT INTO events VALUES ($source,$idx,$hash,$payload)
                    ON CONFLICT(source,idx) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload
                    WHERE events.fingerprint != excluded.fingerprint";
                command.Parameters.AddWithValue("$source", item.Source);
                command.Parameters.AddWithValue("$idx", item.Index);
                command.Parameters.AddWithValue("$hash", item.Fingerprint);
                command.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(item.Bucket));
                changed += command.ExecuteNonQuery();
            }
            foreach (var entry in cursors.Databases)
                Execute(connection, transaction, "INSERT INTO cursors VALUES ($key,$value) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload",
                    entry.Key, JsonSerializer.Serialize(entry.Value));
            if (!initialized)
            {
                for (int i = 0; i < originals.Length; i++)
                    Execute(connection, transaction, "INSERT INTO legacy_original VALUES ($key,$value)", i.ToString(), originals[i]);
                foreach (var item in residual)
                    Execute(connection, transaction, "INSERT INTO legacy_residual VALUES ($key,$value)", item.Key, JsonSerializer.Serialize(item.Value));
                var report = new { migratedAt = DateTimeOffset.UtcNow, legacyRows = originals.Length,
                    observedEvents = events.Count, retainedLegacyTokens = residual.Values.Sum(x => x.total_tokens),
                    policy = "Retain unmatched model/hour history. Existing unidentifiable duplication cannot be proven or removed." };
                Execute(connection, transaction, "INSERT INTO meta VALUES ($key,$value)", "migration", JsonSerializer.Serialize(report));
                Execute(connection, transaction, "INSERT INTO meta VALUES ($key,$value)", "ready", "1");
            }
            transaction.Commit();
            return changed;
        }

        private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql, string key, string value)
        {
            using var command = connection.CreateCommand(); command.Transaction = transaction;
            command.CommandText = sql; command.Parameters.AddWithValue("$key", key); command.Parameters.AddWithValue("$value", value);
            command.ExecuteNonQuery();
        }

        public IReadOnlyList<string> ReadBuckets()
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT json_object('model',model,'hour_start',hour_start,'input_tokens',input_tokens,'cached_input_tokens',cached_input_tokens,'cache_creation_input_tokens',cache_creation_input_tokens,'output_tokens',output_tokens,'reasoning_output_tokens',reasoning_output_tokens,'total_tokens',total_tokens,'conversation_count',conversation_count) FROM bucket_aggregates WHERE total_tokens>0 OR conversation_count>0 OR input_tokens>0 OR cached_input_tokens>0 OR cache_creation_input_tokens>0 OR output_tokens>0 OR reasoning_output_tokens>0";
            var buckets = new List<string>();
            using var reader = command.ExecuteReader();
            while(reader.Read()) buckets.Add(reader.GetString(0));
            return buckets;
        }
    }
}
