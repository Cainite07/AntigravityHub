using AntigravityHub;
using System.Diagnostics;
using System.Text.Json;
internal static class SnapshotCacheTests
{
    public static void Run()
    {
        HubStorage.HubDir = Path.Combine(Path.GetTempPath(), "agh-snapshot-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        var settings = new SettingsService(); var service = new TokenStatsService(settings);
        var repository = new UsageRepository(UsageRepository.DefaultPath);
        var bucket = new UsageBucket { model="gemini-3.8-flash-n", hour_start=DateTimeOffset.Now.ToString("o"), input_tokens=1_000_000,total_tokens=1_000_000,conversation_count=1 };
        repository.Commit(new[]{new UsageEvent("fixture",0,"first",bucket)},new CursorsState(),"");
        var first = service.GetStats();
        if(first.TotalTokens != 1_000_000) throw new Exception("Initial snapshot mismatch");
        var watch = Stopwatch.StartNew();
        for(int i=0;i<200;i++) if(!ReferenceEquals(first,service.GetStats()))throw new Exception("Unchanged data was recomputed");
        double cachedMs = watch.Elapsed.TotalMilliseconds / 200;
        bucket.total_tokens=bucket.input_tokens=2_000_000;
        repository.Commit(new[]{new UsageEvent("fixture",0,"updated",bucket)},new CursorsState(),"");
        var updated=service.GetStats();
        if(updated.TotalTokens!=2_000_000||ReferenceEquals(first,updated))throw new Exception("External SQLite/WAL write was ignored");
        File.WriteAllText(Path.Combine(HubStorage.HubDir,"model_pricing.json"),"{\"gemini-3.8-flash\":{\"Input\":2,\"CacheRead\":0,\"Output\":1,\"CacheWrite\":0}}");
        var priced=service.GetStats();
        if(Math.Abs(priced.TotalCostUsd-4)>1e-9)throw new Exception("Changed base price did not reprice the preserved variant");
        var s=settings.GetSettings();s.Currency="USD";settings.SaveSettings(s);
        if(!service.GetStats().TotalCostFormatted.StartsWith("$"))throw new Exception("Changed currency was ignored");
        s=settings.GetSettings();s.Currency="CNY";s.LiveUsdToCnyRate=2;settings.SaveSettings(s);
        if(Math.Abs(service.GetStats().TotalCostRmb-8)>1e-9)throw new Exception("Changed exchange rate was ignored");
        var current=service.GetStats();service.InvalidateCache();if(ReferenceEquals(current,service.GetStats()))throw new Exception("Explicit invalidation was ignored");
        var evidence=new{checks=7,cachedQueryMs=cachedMs,externalWrites=true,basePriceRepricing=true,variantPreserved=true};
        Directory.CreateDirectory("outputs/polish-1.2.2");File.WriteAllText("outputs/polish-1.2.2/snapshot-cache.json",JsonSerializer.Serialize(evidence,JsonOpts.Indented));
        Console.WriteLine("PASS: "+JsonSerializer.Serialize(evidence));
    }
}
