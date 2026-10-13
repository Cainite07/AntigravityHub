using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using AntigravityHub;

if (args.Length == 3 && args[0] == "--verify-package")
{
    string checkRoot=Path.Combine(Path.GetTempPath(),"AntigravityHub-package-check-"+Guid.NewGuid().ToString("N"));
    try
    {
        var manifest=HubUpdatePackage.ExtractVerified(args[1],checkRoot,HubUpdatePackage.ParseVersion(args[2]),CancellationToken.None);
        HubUpdateInstaller.VerifyFiles(checkRoot,manifest);
        Console.WriteLine($"PASS: complete public update ZIP, version {manifest.Version}, {manifest.Files.Length} files and hashes.");
        return 0;
    }
    finally {if(Directory.Exists(checkRoot))Directory.Delete(checkRoot,true);}
}
if (args.Length == 2 && args[0] is "--apply-hub-update" or "--recover-hub-update") return await HubUpdateInstaller.RunAsync(args[1],args[0]=="--recover-hub-update");
if (args.Length == 2 && args[0] == "--recover-parent") return await HubUpdateInstaller.ResumeInterruptedAsync(args[1]) ? 0 : 10;
if (args.Length == 2 && args[0] is "--hub-updated" or "--hub-update-failed")
{
    string target = AppContext.BaseDirectory;
    if (args[0] == "--hub-updated" && File.Exists(Path.Combine(target, "fail-start"))) return 7;
    if (!HubUpdateInstaller.ConfigureStartup(args, target)) return 8;
    using var instance = new Mutex(false, HubUpdateInstaller.MutexName);
    bool owns;
    try { owns = instance.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
    if (!owns) return 11;
    File.WriteAllText(Path.Combine(target, args[0] == "--hub-updated" ? "relaunched-marker" : "rolledback-marker"), "ok");
    HubUpdateInstaller.MarkHealthy();
    await Task.Delay(2500);
    return 0;
}
if (args.Length == 3 && args[0] == "--parent")
{
    using var instance = new Mutex(true, HubUpdateInstaller.MutexName);
    byte[] zip = await File.ReadAllBytesAsync(args[2]);
    using var service = new HubUpdateService(args[1], new FakeGitHub(zip), new Version(1, 3, 9));
    await service.CheckAsync(CancellationToken.None);
    bool ready = await service.InstallAsync(CancellationToken.None);
    if (!ready) Console.Error.WriteLine(service.Status.Message);
    return ready ? 0 : 9;
}

string fixture = Path.Combine(Path.GetTempPath(), "AntigravityHub-test-" + Guid.NewGuid().ToString("N"));
Environment.SetEnvironmentVariable("HUB_UPDATE_TEST_ID",Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(fixture);
var passed = new List<string>();
void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
void Reject(Action operation) { try { operation(); } catch (InvalidDataException) { return; } catch (IOException) { return; } catch (UnauthorizedAccessException) { return; } catch (JsonException) { return; } throw new Exception("Expected rejection"); }
HubPackageManifest Manifest(string directory, string version)
{
    var files = Directory.GetFiles(directory, "*", SearchOption.AllDirectories)
        .Where(p => Path.GetFileName(p) != HubUpdatePackage.ManifestName)
        .Select(p => new HubPackageFile(Path.GetRelativePath(directory, p).Replace('\\', '/'), new FileInfo(p).Length, HubUpdatePackage.Hash(p))).ToArray();
    var manifest = new HubPackageManifest(1, version, files);
    HubUpdatePackage.ValidateManifest(manifest);
    HubUpdateInstaller.WriteJson(Path.Combine(directory, HubUpdatePackage.ManifestName), manifest);
    return manifest;
}
string TinyPackage(string name, string version)
{
    string root = Path.Combine(fixture, name); Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
    foreach (string file in new[] { "AntigravityHub.exe", "AntigravityHub.dll", "AntigravityHub.runtimeconfig.json", "wwwroot/index.html" })
        File.WriteAllText(Path.Combine(root, file), name + ":" + file);
    Manifest(root, version); return root;
}
string Zip(string source, string name)
{
    string archive = Path.Combine(fixture, name + ".zip");
    using var zip = ZipFile.Open(archive, ZipArchiveMode.Create);
    foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        zip.CreateEntryFromFile(file, "AntigravityHub/" + Path.GetRelativePath(source, file).Replace('\\','/'));
    return archive;
}
try
{
    Assert(HubUpdatePackage.ParseVersion("v1.10.0") > HubUpdatePackage.ParseVersion("1.9.9"), "numeric versions");
    Assert(HubUpdatePackage.ParseVersion("2.23.0") > HubUpdatePackage.ParseVersion("1.4.2"), "client-aligned version migration");
    Assert(HubUpdatePackage.ParseVersion("2.23.1") > HubUpdatePackage.ParseVersion("2.23.0"), "Hub patch increments");
    Assert(HubUpdatePackage.ParseVersion("2.24.0") > HubUpdatePackage.ParseVersion("2.23.9"), "next client version");
    foreach (string invalid in new[] { "1.4", "1.4.0-beta", "../../1.4.0", "1.65536.0" }) Reject(() => HubUpdatePackage.ParseVersion(invalid));
    foreach (string invalid in new[] { "../escape", "C:/x", "a\\b", "CON.txt", "x./file", "a/../b", "client/release/base/app.asar", "accounts.json", "app_settings.json", "a/b.dat" })
        Reject(() => HubUpdatePackage.ValidateRelative(invalid));
    Assert(!HubUpdateService.IsAllowedRedirect(new Uri("https://github.com.evil.test/Cainite07/AntigravityHub/releases/download/v1.4.0/x.zip")), "host boundary");
    Assert(!HubUpdateService.IsAllowedRedirect(new Uri("http://github.com/Cainite07/AntigravityHub/releases/download/v1.4.0/x.zip")), "HTTPS only");
    passed.Add("numeric versions, path containment, user-data exclusions and download origins");

    string next = TinyPackage("tiny", "1.4.0"), archive = Zip(next, "valid");
    HubUpdatePackage.ExtractVerified(archive, Path.Combine(fixture,"verified"), new Version(1,4,0), CancellationToken.None);
    Reject(() => HubUpdatePackage.ExtractVerified(archive, Path.Combine(fixture,"wrong-version"), new Version(1,5,0), CancellationToken.None));
    foreach (string attack in new[] { "traversal", "case-duplicate", "symlink", "extra-file", "broken-hash" })
    {
        string zipPath = Path.Combine(fixture, attack + ".zip"); File.Copy(archive,zipPath);
        using (var zip = ZipFile.Open(zipPath,ZipArchiveMode.Update))
        {
            if (attack == "broken-hash")
            {
                zip.GetEntry("AntigravityHub/wwwroot/index.html")!.Delete();
                using var writer = new StreamWriter(zip.CreateEntry("AntigravityHub/wwwroot/index.html").Open()); writer.Write("tampered");
            }
            else
            {
                var entry = zip.CreateEntry(attack == "traversal" ? "AntigravityHub/../escape" : attack == "case-duplicate" ? "AntigravityHub/antigravityhub.exe" : "AntigravityHub/unexpected.txt");
                if (attack == "symlink") entry.ExternalAttributes = (0xA000 | 0x1FF) << 16;
                using var writer = new StreamWriter(entry.Open()); writer.Write("bad");
            }
        }
        Reject(() => HubUpdatePackage.ExtractVerified(zipPath,Path.Combine(fixture,attack),new Version(1,4,0),CancellationToken.None));
    }
    passed.Add("valid ZIP extraction; wrong versions, traversal, duplicate names, links, extra files and corrupt files rejected");

    byte[] data = File.ReadAllBytes(archive);
    using (var handler = new FakeGitHub(data))
    using (var service = new HubUpdateService(fixture, handler, new Version(1,3,9)))
    {
        await service.CheckAsync(CancellationToken.None); Assert(service.Status.State=="available","release available");
        handler.Metadata = FakeGitHub.Release(data).Replace("\"prerelease\":false", "\"prerelease\":true");
        await service.CheckAsync(CancellationToken.None); Assert(service.Status.State=="current","prerelease ignored");
        handler.Metadata = FakeGitHub.Release(data).Replace("\"draft\":false", "\"draft\":true");
        await service.CheckAsync(CancellationToken.None); Assert(service.Status.State=="current","draft ignored");
        handler.Metadata = FakeGitHub.Release(data).Replace("v1.4.0", "v1.3.9");
        await service.CheckAsync(CancellationToken.None); Assert(service.Status.State=="current","same version ignored");
        handler.Metadata = FakeGitHub.Release(data).Replace("sha256:", "missing:");
        await service.CheckAsync(CancellationToken.None); Assert(service.Status.State=="error","missing digest blocked");
        handler.Status = HttpStatusCode.Forbidden;
        await service.CheckAsync(CancellationToken.None); Assert(service.Status.State=="error","rate limiting handled");
    }
    string installed = TinyPackage("current","1.3.9");
    using (var handler = new FakeGitHub(data) { CorruptDownload = true })
    using (var service = new HubUpdateService(installed,handler,new Version(1,3,9)))
    {
        await service.CheckAsync(CancellationToken.None);
        Assert(!await service.InstallAsync(CancellationToken.None),"corrupt archive blocked");
        Assert(service.Status.State=="error" && service.Status.Message.Contains("校验"),"checksum error visible");
        Assert(HubUpdatePackage.ReadManifest(Path.Combine(installed,HubUpdatePackage.ManifestName)).Version=="1.3.9","old installation kept");
    }
    passed.Add("stable GitHub release checks, draft/prerelease filtering, missing digest, rate limits and download checksum failure");
    using (var handler = new FakeGitHub(data) { MetadataGate = new(TaskCreationOptions.RunContinuationsAsynchronously) })
    using (var service = new HubUpdateService(installed,handler,new Version(1,3,9)))
    {
        int notifications=0;service.Changed+=_=>notifications++;
        var pendingCheck=service.CheckAsync(CancellationToken.None);
        Assert(service.Status.State=="checking","check started");
        Assert(!await service.InstallAsync(CancellationToken.None),"installation waits for a busy check");
        Assert(notifications==2 && service.Status.State=="checking","busy install returns current status to unlock UI");
        handler.MetadataGate.SetResult(true);await pendingCheck;
    }
    passed.Add("concurrent check/install requests return the active status instead of leaving the UI stuck");

    string target = TinyPackage("rollback-target","1.3.9"), stage = TinyPackage("rollback-stage","1.4.0");
    File.WriteAllText(Path.Combine(target,"obsolete.txt"),"old");
    var previous = Manifest(target,"1.3.9");
    var upcoming = HubUpdatePackage.ReadManifest(Path.Combine(stage,HubUpdatePackage.ManifestName));
    File.WriteAllText(Path.Combine(target,"accounts.json"),"private");
    Directory.CreateDirectory(Path.Combine(target,"client/release/base")); File.WriteAllText(Path.Combine(target,"client/release/base/app.asar"),"native");
    string backup = Path.Combine(fixture,"rollback-job"); Directory.CreateDirectory(backup);
    var journal = HubUpdateInstaller.Backup(backup,target,previous,upcoming,new("waiting",0,0,[]));
    using (var locked = new FileStream(Path.Combine(target,"AntigravityHub.runtimeconfig.json"),FileMode.Open,FileAccess.Read,FileShare.Read))
    {
        Reject(() => HubUpdateInstaller.ApplyFiles(stage,target,previous,upcoming));
        HubUpdateInstaller.Restore(backup,target,journal.Files);
    }
    Assert(File.ReadAllText(Path.Combine(target,"AntigravityHub.exe")).StartsWith("rollback-target"),"partial replacement rolled back");
    Assert(File.ReadAllText(Path.Combine(target,"accounts.json"))=="private","unowned data preserved");
    HubUpdateInstaller.ApplyFiles(stage,target,previous,upcoming);
    Assert(!File.Exists(Path.Combine(target,"obsolete.txt")),"old owned files removed");
    Assert(File.Exists(Path.Combine(target,"client/release/base/app.asar")),"native cache preserved");
    Assert(!Directory.GetFiles(target,"*.hub-update-*",SearchOption.AllDirectories).Any(),"no replacement temp leftovers");
    Assert(!HubUpdateInstaller.TryCleanJob(fixture),"cleanup stays in bounded job directory");
    passed.Add("partial replacement rollback, locked files, old-file removal, user data/base preservation and bounded cleanup");

    // Real processes exercise handoff, waiting for parent exit, mutex ownership, restart/health acknowledgement and cleanup.
    foreach (bool fail in new[] {false,true})
    {
        string e2e = Path.Combine(fixture,fail?"failed-start":"successful-start"), newRoot=Path.Combine(fixture,fail?"next-fail":"next-ok");
        Directory.CreateDirectory(e2e); Directory.CreateDirectory(newRoot);
        foreach (string file in Directory.GetFiles(AppContext.BaseDirectory))
        {
            if (Path.GetExtension(file)==".pdb") continue;
            File.Copy(file,Path.Combine(e2e,Path.GetFileName(file))); File.Copy(file,Path.Combine(newRoot,Path.GetFileName(file)));
        }
        foreach (string root in new[] {e2e,newRoot}) { Directory.CreateDirectory(Path.Combine(root,"wwwroot")); File.WriteAllText(Path.Combine(root,"wwwroot/index.html"),"test UI"); }
        File.WriteAllText(Path.Combine(e2e,"obsolete.txt"),"old"); Manifest(e2e,"1.3.9"); Manifest(newRoot,"1.4.0");
        File.WriteAllText(Path.Combine(e2e,"accounts.json"),"preserved");
        if(fail) File.WriteAllText(Path.Combine(e2e,"fail-start"),"fail");
        string zip = Zip(newRoot,fail?"process-fail":"process-ok");
        var start = new ProcessStartInfo(Path.Combine(e2e,"AntigravityHub.exe")) {UseShellExecute=false,CreateNoWindow=true};
        start.ArgumentList.Add("--parent");start.ArgumentList.Add(e2e);start.ArgumentList.Add(zip);
        using var parent=Process.Start(start)!;
        await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(25)); Assert(parent.ExitCode==0,"parent handoff succeeded");
        string marker=Path.Combine(e2e,fail?"rolledback-marker":"relaunched-marker");
        var timer=Stopwatch.StartNew();
        while(!File.Exists(marker) && timer.Elapsed<TimeSpan.FromSeconds(30)) await Task.Delay(100);
        Assert(File.Exists(marker),"replacement/rollback launched");
        Assert(HubUpdatePackage.ReadManifest(Path.Combine(e2e,HubUpdatePackage.ManifestName)).Version==(fail?"1.3.9":"1.4.0"),"final process version");
        Assert(File.ReadAllText(Path.Combine(e2e,"accounts.json"))=="preserved","restart preserves account file");
        await Task.Delay(4000);
        if(Directory.Exists(HubUpdateInstaller.JobsRoot))
            Assert(!Directory.EnumerateDirectories(HubUpdateInstaller.JobsRoot).Any(d=>File.Exists(Path.Combine(d,"job.json")) && File.ReadAllText(Path.Combine(d,"job.json")).Contains(e2e.Replace("\\","\\\\"))),"completed job removed");
    }
    passed.Add("real helper processes: exit/handoff, same-location overwrite, healthy restart, failed-start rollback, package/backup cleanup");
    string recoveryTarget=Path.Combine(fixture,"recovery-target"); Directory.CreateDirectory(recoveryTarget);
    foreach(string file in Directory.GetFiles(AppContext.BaseDirectory).Where(f=>Path.GetExtension(f)!=".pdb")) File.Copy(file,Path.Combine(recoveryTarget,Path.GetFileName(file)));
    Directory.CreateDirectory(Path.Combine(recoveryTarget,"wwwroot")); File.WriteAllText(Path.Combine(recoveryTarget,"wwwroot/index.html"),"old UI");
    var recoveryPrevious=Manifest(recoveryTarget,"1.3.9");
    string recoveryJob=HubUpdateInstaller.CreateJobDirectory(), recoveryStage=Path.Combine(recoveryJob,"stage");
    Directory.CreateDirectory(recoveryStage);
    foreach(string file in Directory.GetFiles(AppContext.BaseDirectory).Where(f=>Path.GetExtension(f)!=".pdb")) File.Copy(file,Path.Combine(recoveryStage,Path.GetFileName(file)));
    Directory.CreateDirectory(Path.Combine(recoveryStage,"wwwroot")); File.WriteAllText(Path.Combine(recoveryStage,"wwwroot/index.html"),"new UI");
    var recoveryNext=Manifest(recoveryStage,"1.4.0");
    var recoveryJournal=HubUpdateInstaller.Backup(recoveryJob,recoveryTarget,recoveryPrevious,recoveryNext,new("waiting",0,0,[]));
    HubUpdateInstaller.WriteJson(Path.Combine(recoveryJob,"journal.json"),recoveryJournal with {Phase="applying"});
    HubUpdateInstaller.WriteJson(Path.Combine(recoveryJob,"job.json"),new HubUpdateJob(recoveryTarget,"1.3.9","1.4.0",int.MaxValue,0));
    File.WriteAllText(Path.Combine(recoveryTarget,"wwwroot/index.html"),"interrupted partial copy");
    File.WriteAllText(Path.Combine(recoveryTarget,"wwwroot/index.html.hub-update-"+Guid.NewGuid().ToString("N")),"interrupted temporary file");
    var recoveringStart=new ProcessStartInfo(Path.Combine(recoveryTarget,"AntigravityHub.exe")) {UseShellExecute=false,CreateNoWindow=true};
    recoveringStart.ArgumentList.Add("--recover-parent"); recoveringStart.ArgumentList.Add(recoveryTarget);
    using(var recoveringParent=Process.Start(recoveringStart)!) {await recoveringParent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));Assert(recoveringParent.ExitCode==0,"interrupted job resumed");}
    var recoveryWait=Stopwatch.StartNew();
    while(!File.Exists(Path.Combine(recoveryTarget,"rolledback-marker")) && recoveryWait.Elapsed<TimeSpan.FromSeconds(25)) await Task.Delay(100);
    Assert(File.Exists(Path.Combine(recoveryTarget,"rolledback-marker")),"interrupted installation restarted old version");
    Assert(File.ReadAllText(Path.Combine(recoveryTarget,"wwwroot/index.html"))=="old UI","interrupted files recovered");
    Assert(!Directory.EnumerateFiles(Path.Combine(recoveryTarget,"wwwroot"),"*.hub-update-*").Any(),"interrupted replacement temporary files removed");
    await Task.Delay(4000); Assert(!Directory.Exists(recoveryJob),"interrupted-job backup cleaned after restart");
    passed.Add("interrupted replacement is recovered on the next startup, then backup files are removed");
    Console.WriteLine("PASS: " + string.Join("; ",passed));
    return 0;
}
finally
{
    // Fixtures are exclusively created by this harness. Never traverse a user directory during cleanup.
    if (Path.GetFileName(fixture).StartsWith("AntigravityHub-test-")) Directory.Delete(fixture,true);
}

sealed class FakeGitHub(byte[] archive) : HttpMessageHandler
{
    internal string Metadata {get;set;} = Release(archive);
    internal HttpStatusCode Status {get;set;} = HttpStatusCode.OK;
    internal bool CorruptDownload {get;set;}
    internal TaskCompletionSource<bool>? MetadataGate {get;set;}
    internal static string Release(byte[] archive) => JsonSerializer.Serialize(new {
        draft=false,prerelease=false,tag_name="v1.4.0",body="Fixture release",assets=new[]{new {
            name="AntigravityHub-1.4.0-Windows-x64.zip",state="uploaded",size=archive.Length,
            digest="sha256:"+Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(archive)).ToLowerInvariant(),
            browser_download_url="https://github.com/Cainite07/AntigravityHub/releases/download/v1.4.0/AntigravityHub-1.4.0-Windows-x64.zip"
        }}
    });
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)
    {
        bool metadata=request.RequestUri==HubUpdateService.LatestEndpoint;
        if(metadata && MetadataGate!=null) await MetadataGate.Task.WaitAsync(cancellation);
        byte[] bytes=archive.ToArray(); if(CorruptDownload && !metadata) bytes[0]^=1;
        return new HttpResponseMessage(Status) {Content=metadata?new StringContent(Metadata,Encoding.UTF8,"application/json"):new ByteArrayContent(bytes)};
    }
}
