using AntigravityHub;
using Microsoft.Data.Sqlite;
using System.Text.Json;

internal static class HistorySafetyTests
{
    internal static void Run()
    {
        string root=Path.Combine(HubStorage.HubDir,"history-safety-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        string database=Path.Combine(root,"usage.sqlite3"),legacy=Path.Combine(root,"tokens.jsonl");
        UsageEvent Event(int id,long tokens)=>new("test",id,"hash-"+tokens,new UsageBucket {model="test",hour_start="2026-10-01T00:00:00.000Z",total_tokens=tokens,input_tokens=tokens,conversation_count=1});
        var original=new UsageBucket{model="legacy",hour_start="2026-08-01T00:00:00.000Z",total_tokens=7,input_tokens=7};
        File.WriteAllText(legacy,JsonSerializer.Serialize(original));
        var repo=new UsageRepository(database);repo.Commit(new[]{Event(0,10),Event(1,20)},new CursorsState(),legacy);
        UsageHistorySafety.Protect(database,new DateTime(2026,10,1));
        string directory=UsageHistorySafety.BackupDirectory(database);
        if(!File.Exists(Path.Combine(directory,"usage-2026-10-01.sqlite3")))throw new Exception("Backup missing");
        File.Delete(database);File.Delete(legacy);
        // Simulate a rebuilt ledger with the same row count but different identity,
        // plus a newer revision of an overlapping event. Restore missing rows only.
        original.model="other-legacy";original.total_tokens=9;original.input_tokens=9;
        File.WriteAllText(legacy,JsonSerializer.Serialize(original));
        repo=new UsageRepository(database);repo.Commit(new[]{Event(0,99),Event(2,5)},new CursorsState(),legacy);
        UsageHistorySafety.Protect(database,new DateTime(2026,10,2));
        long Total()=>repo.ReadBuckets().Sum(s=>JsonDocument.Parse(s).RootElement.GetProperty("total_tokens").GetInt64());
        if(Total()!=140)throw new Exception("Merge lost new revisions, history or legacy residual");
        UsageHistorySafety.Protect(database,new DateTime(2026,10,2));if(Total()!=140)throw new Exception("Recovery duplicated tokens");
        File.Delete(database);UsageHistorySafety.RestoreMissing(database);
        if(Total()!=140)throw new Exception("Missing DB recovery failed");
        for(int d=3;d<=11;d++)UsageHistorySafety.Protect(database,new DateTime(2026,10,d));
        if(Directory.GetFiles(directory,"*.sqlite3").Length!=7)throw new Exception("Backup retention is unbounded");
        // A corrupt newest backup must not hide older valid recovery points.
        File.WriteAllText(Path.Combine(directory,"usage-2026-10-12.sqlite3"),"broken");
        File.Delete(database);UsageHistorySafety.RestoreMissing(database);if(Total()!=140)throw new Exception("Corrupt backup fallback failed");
        using var c=new SqliteConnection("Data Source="+database+";Pooling=False");c.Open();using var q=c.CreateCommand();q.CommandText="PRAGMA integrity_check";if((string?)q.ExecuteScalar()!="ok")throw new Exception("Recovery corrupted DB");
        Console.WriteLine("PASS: independent backup, equal-count missing history, newest events preserved, legacy recovery, idempotence, missing-ledger restore, seven-day retention and corrupt-backup fallback.");
    }
}
