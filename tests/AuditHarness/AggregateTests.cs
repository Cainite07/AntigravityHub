using AntigravityHub;
using Microsoft.Data.Sqlite;
using System.Diagnostics;
using System.Text.Json;
internal static class AggregateTests
{
    public static void Run()
    {
        string dir=Path.Combine(Path.GetTempPath(),"agh-aggregate-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var path=Path.Combine(dir,"usage.sqlite3");
        using(var db=new SqliteConnection($"Data Source={path};Pooling=False"))
        {
            db.Open();using var t=db.BeginTransaction();using var c=db.CreateCommand();c.Transaction=t;
            c.CommandText="CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('ready','1'); CREATE TABLE events(source TEXT NOT NULL,idx INTEGER NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source,idx)); CREATE TABLE cursors(source TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE legacy_original(line INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE legacy_residual(key TEXT PRIMARY KEY,payload TEXT NOT NULL);";c.ExecuteNonQuery();
            c.CommandText="INSERT INTO events VALUES('fixture',$idx,'first',$payload)";c.Parameters.AddWithValue("$idx",0);c.Parameters.AddWithValue("$payload","");
            for(int i=0;i<60000;i++) { c.Parameters["$idx"].Value=i;c.Parameters["$payload"].Value=JsonSerializer.Serialize(new UsageBucket{model=i%2==0?"gemini-3.8-flash":"gemini-3.8-flash-n",hour_start=$"2026-09-{1+i%28:00}T12:00:00.000Z",input_tokens=10,cached_input_tokens=80,output_tokens=5,reasoning_output_tokens=5,total_tokens=100,conversation_count=1});c.ExecuteNonQuery(); }t.Commit();
        }
        var repository=new UsageRepository(path);var watch=Stopwatch.StartNew();var buckets=repository.ReadBuckets();long migrationMs=watch.ElapsedMilliseconds;
        long Total()=>repository.ReadBuckets().Sum(x=>JsonSerializer.Deserialize<UsageBucket>(x)!.total_tokens);
        if(Total()!=6000000||buckets.Count!=28)throw new Exception("Backfill parity/count");
        if(!buckets.Any(x=>x.Contains("flash-n")))throw new Exception("Derived model erased");
        var moved=new UsageBucket{model="claude-opus-4-6-thinking",hour_start="2026-10-01T14:00:00.000Z",input_tokens=10,total_tokens=10,conversation_count=1};
        repository.Commit(new[]{new UsageEvent("fixture",0,"changed",moved)},new CursorsState(),Path.Combine(dir,"absent.jsonl"));
        if(Total()!=5999910)throw new Exception("Correction did not subtract original bucket");
        repository.Commit(new[]{new UsageEvent("fixture",0,"changed",moved)},new CursorsState(),"");if(Total()!=5999910)throw new Exception("Repeat inflated aggregate");
        using(var db=new SqliteConnection($"Data Source={path};Pooling=False")){db.Open();using var c=db.CreateCommand();c.CommandText="CREATE TRIGGER fail_cursor BEFORE INSERT ON cursors BEGIN SELECT RAISE(ABORT,'fixture'); END;";c.ExecuteNonQuery();}
        var cursor=new CursorsState();cursor.Databases["fixture"]=new DbCursor();bool failed=false;moved.total_tokens=20;
        try{repository.Commit(new[]{new UsageEvent("fixture",0,"rollback",moved)},cursor,"");}catch(SqliteException){failed=true;}
        if(!failed||Total()!=5999910)throw new Exception("Aggregate escaped rollback");
        watch.Restart();for(int i=0;i<20;i++)repository.ReadBuckets();double aggregateMs=watch.Elapsed.TotalMilliseconds/20;
        var evidence=new{checks=6,events=60000,buckets=buckets.Count,migrationMs,averageQueryMs=aggregateMs,rawAndVariantRecordsPreserved=true};
        Directory.CreateDirectory("outputs/dark-hud-1.2.0");File.WriteAllText("outputs/dark-hud-1.2.0/aggregation-tests.json",JsonSerializer.Serialize(evidence,JsonOpts.Indented));Console.WriteLine("PASS: "+JsonSerializer.Serialize(evidence));
    }
}
