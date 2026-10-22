using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AntigravityHub;

internal sealed record HubUpdateJob(string Target, string CurrentVersion, string TargetVersion, int ParentPid, long ParentStartTicks);
internal sealed record HubBackupFile(string Path, bool Existed, string Sha256);
internal sealed record HubUpdateJournal(string Phase, int HelperPid, long HelperStartTicks, HubBackupFile[] Files, string Error = "");

internal static class HubUpdateInstaller
{
#if HUB_UPDATE_TESTS
    // The process harness has its own mutex, so it never interrupts a user's running Hub.
    internal static string MutexName => "Local\\AntigravityHub_Test_" + Environment.GetEnvironmentVariable("HUB_UPDATE_TEST_ID");
#else
    internal const string MutexName = "Local\\AntigravityHub_SingleInstance_Mutex";
#endif
    internal static string JobsRoot => Path.Combine(Path.GetTempPath(), "AntigravityHub-updates");
    internal static string? StartupJob { get; private set; }
    internal static bool StartupFailed { get; private set; }
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, WriteIndented = true };

    internal static string CreateJobDirectory()
    {
        HubUpdatePackage.RejectLinks(JobsRoot);
        string path = Path.Combine(JobsRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    internal static string ValidateJobDirectory(string directory)
    {
        string full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        if (!Guid.TryParseExact(Path.GetFileName(full), "N", out _) ||
            !string.Equals(Path.GetDirectoryName(full), Path.GetFullPath(JobsRoot), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("更新目录无效。");
        HubUpdatePackage.RejectLinks(full);
        return full;
    }

    internal static void WriteJson<T>(string path, T value)
    {
        string temporary = path + ".new";
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(output, value, Json);
            output.Flush(true);
        }
        File.Move(temporary, path, true);
    }

    private static T ReadJson<T>(string path)
    {
        if (new FileInfo(path).Length > 4 * 1024 * 1024) throw new InvalidDataException("更新记录无效。");
        return JsonSerializer.Deserialize<T>(File.ReadAllText(path), Json) ?? throw new InvalidDataException("更新记录无效。");
    }

    private static HubUpdateJob ReadJob(string directory)
    {
        var job = ReadJson<HubUpdateJob>(Path.Combine(directory, "job.json"));
        string target = Path.GetFullPath(job.Target).TrimEnd(Path.DirectorySeparatorChar);
        if (target.Length <= Path.GetPathRoot(target)!.Length || !Directory.Exists(target) ||
            !string.Equals(job.Target, target, StringComparison.OrdinalIgnoreCase) ||
            target.StartsWith(Path.GetFullPath(JobsRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            HubUpdatePackage.ParseVersion(job.TargetVersion) <= HubUpdatePackage.ParseVersion(job.CurrentVersion) || job.ParentPid <= 0)
            throw new InvalidDataException("更新目标无效。");
        HubUpdatePackage.RejectLinks(target);
        return job;
    }

    internal static bool IsProcessAlive(int pid, long startTicks)
    {
        if (pid <= 0 || startTicks <= 0) return false;
        try { using var process = Process.GetProcessById(pid); return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == startTicks; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return true; }
    }

    internal static Task<int> RunAsync(string jobPath, bool recovery = false) => Task.Run(() => RunCore(jobPath, recovery));

    private static int RunCore(string jobPath, bool recovery)
    {
        string? directory = null;
        HubUpdateJob? job = null;
        HubUpdateJournal? journal = null;
        Process? replacement = null;
        Mutex? mutex = null;
        bool ownsMutex = false, changed = false;
        try
        {
            directory = ValidateJobDirectory(Path.GetDirectoryName(Path.GetFullPath(jobPath))!);
            if (Path.GetFileName(jobPath) != "job.json" || !string.Equals(Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar),
                Path.Combine(directory, "stage"), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新助手位置无效。");
            job = ReadJob(directory);
            string journalPath = Path.Combine(directory, "journal.json");
            HubUpdateJournal? interrupted = recovery ? ReadJson<HubUpdateJournal>(journalPath) : null;
            if (recovery ? interrupted!.Phase is not ("applying" or "starting" or "recovering" or "recovery-needed") || interrupted.Files.Length == 0 || IsProcessAlive(interrupted.HelperPid, interrupted.HelperStartTicks)
                : File.Exists(journalPath)) throw new InvalidDataException("此更新不能执行。");
            using var self = Process.GetCurrentProcess();
            journal = new(recovery ? "recovering" : "waiting", self.Id, self.StartTime.ToUniversalTime().Ticks, interrupted?.Files ?? []);
            WriteJson(Path.Combine(directory, "journal.json"), journal);
            File.WriteAllText(Path.Combine(directory, "helper-ready"), "ready");
            // The parent confirms handoff before exiting. A cancelled download never mutates the installation.
            var wait = Stopwatch.StartNew();
            while (!File.Exists(Path.Combine(directory, "proceed")) || IsProcessAlive(job.ParentPid, job.ParentStartTicks))
            {
                if (File.Exists(Path.Combine(directory, "abort"))) throw new IOException("更新已取消。");
                if (wait.Elapsed > TimeSpan.FromSeconds(60)) throw new IOException("Hub 未能退出，更新已取消。");
                Thread.Sleep(100);
            }
            mutex = new Mutex(false, MutexName);
            try { ownsMutex = mutex.WaitOne(TimeSpan.FromSeconds(10)); }
            catch (AbandonedMutexException) { ownsMutex = true; }
            if (!ownsMutex) throw new IOException("另一个 Hub 实例正在运行，更新已取消。");
            if (recovery)
            {
                changed = true;
                Restore(directory, job.Target, journal.Files);
                WriteJson(journalPath, journal with { Phase = "rolledback", Error = "上次更新意外中断，已恢复原版本。" });
                mutex.ReleaseMutex(); ownsMutex = false;
                using (Launch(job.Target, "--hub-update-failed", Path.GetFileName(directory))) { }
                return 0;
            }
            string stage = Path.Combine(directory, "stage");
            var next = HubUpdatePackage.ReadManifest(Path.Combine(stage, HubUpdatePackage.ManifestName));
            var previous = HubUpdatePackage.ReadManifest(Path.Combine(job.Target, HubUpdatePackage.ManifestName));
            if (next.Version != job.TargetVersion || previous.Version != job.CurrentVersion) throw new InvalidDataException("程序版本已改变，更新已取消。");
            VerifyFiles(stage, next);
            journal = Backup(directory, job.Target, previous, next, journal);
            WriteJson(Path.Combine(directory, "journal.json"), journal with { Phase = "applying" });
            changed = true;
            ApplyFiles(stage, job.Target, previous, next);
            journal = journal with { Phase = "starting" };
            WriteJson(Path.Combine(directory, "journal.json"), journal);
            mutex.ReleaseMutex(); ownsMutex = false;
            replacement = Launch(job.Target, "--hub-updated", Path.GetFileName(directory));
            wait.Restart();
            while (!File.Exists(Path.Combine(directory, "healthy")))
            {
                if (replacement.HasExited || wait.Elapsed > TimeSpan.FromSeconds(75)) throw new IOException("新版本未能正常启动，已恢复原版本。");
                Thread.Sleep(150);
            }
            if (File.ReadAllText(Path.Combine(directory, "healthy")) != job.TargetVersion || replacement.HasExited)
                throw new IOException("新版本启动校验失败，已恢复原版本。");
            WriteJson(Path.Combine(directory, "journal.json"), journal with { Phase = "complete" });
            return 0;
        }
        catch (Exception ex)
        {
            if (directory == null || journal == null) return 1;
            try
            {
                if (replacement != null && !replacement.HasExited) { replacement.Kill(true); replacement.WaitForExit(10000); }
                if (changed && job != null)
                {
                    if (!ownsMutex && mutex != null)
                    {
                        try { ownsMutex = mutex.WaitOne(TimeSpan.FromSeconds(15)); }
                        catch (AbandonedMutexException) { ownsMutex = true; }
                        if (!ownsMutex) throw new IOException("无法恢复文件：Hub 仍在运行。");
                    }
                    Restore(directory, job.Target, journal.Files);
                }
                WriteJson(Path.Combine(directory, "journal.json"), journal with { Phase = changed ? "rolledback" : recovery ? "recovery-needed" : "aborted", Error = ex.Message });
                if (ownsMutex) { mutex!.ReleaseMutex(); ownsMutex = false; }
                if (job != null && !IsProcessAlive(job.ParentPid, job.ParentStartTicks))
                    using (Launch(job.Target, "--hub-update-failed", Path.GetFileName(directory))) { }
            }
            catch (Exception rollback)
            {
                WriteJson(Path.Combine(directory, "journal.json"), journal with { Phase = "recovery-needed", Error = rollback.Message });
            }
            return 1;
        }
        finally
        {
            if (ownsMutex) mutex!.ReleaseMutex();
            mutex?.Dispose(); replacement?.Dispose();
        }
    }

    private static Process Launch(string target, string argument, string id)
    {
        var start = new ProcessStartInfo(Path.Combine(target, "AntigravityHub.exe")) { WorkingDirectory = target, UseShellExecute = false };
        start.ArgumentList.Add(argument); start.ArgumentList.Add(id);
        return Process.Start(start) ?? throw new IOException("无法启动 Hub。");
    }

    internal static void VerifyFiles(string root, HubPackageManifest manifest)
    {
        foreach (var file in manifest.Files)
        {
            string path = HubUpdatePackage.Resolve(root, file.Path);
            if (!File.Exists(path) || new FileInfo(path).Length != file.Size || HubUpdatePackage.Hash(path) != file.Sha256.ToLowerInvariant())
                throw new InvalidDataException("更新包中的文件校验失败。");
        }
    }

    internal static HubUpdateJournal Backup(string directory, string target, HubPackageManifest previous, HubPackageManifest next, HubUpdateJournal journal)
    {
        var files = new List<HubBackupFile>();
        foreach (string relative in previous.Files.Select(f => f.Path).Union(next.Files.Select(f => f.Path), StringComparer.OrdinalIgnoreCase).Append(HubUpdatePackage.ManifestName))
        {
            string original = HubUpdatePackage.Resolve(target, relative);
            bool existed = File.Exists(original);
            string digest = "";
            if (existed)
            {
                string saved = HubUpdatePackage.Resolve(Path.Combine(directory, "backup"), relative);
                Directory.CreateDirectory(Path.GetDirectoryName(saved)!);
                File.Copy(original, saved, false);
                digest = HubUpdatePackage.Hash(saved);
            }
            files.Add(new(relative, existed, digest));
        }
        return journal with { Files = files.ToArray(), Phase = "backed-up" };
    }

    private static void ReplaceFile(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        string temporary = destination + ".hub-update-" + Guid.NewGuid().ToString("N");
        try
        {
            Retry(() => File.Copy(source, temporary, true));
            Retry(() => File.Move(temporary, destination, true));
        }
        finally { if (File.Exists(temporary)) Retry(() => File.Delete(temporary)); }
    }

    private static void Retry(Action action)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { action(); return; }
            catch (Exception ex) when (attempt < 15 && ex is IOException or UnauthorizedAccessException) { Thread.Sleep(200); }
        }
    }

    internal static void ApplyFiles(string stage, string target, HubPackageManifest previous, HubPackageManifest next)
    {
        foreach (var file in next.Files)
            ReplaceFile(HubUpdatePackage.Resolve(stage, file.Path), HubUpdatePackage.Resolve(target, file.Path));
        var names = next.Files.Select(f => f.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var obsolete in previous.Files.Where(f => !names.Contains(f.Path)))
        {
            string path = HubUpdatePackage.Resolve(target, obsolete.Path);
            Retry(() => File.Delete(path));
            RemoveEmptyParents(Path.GetDirectoryName(path)!, target);
        }
        ReplaceFile(Path.Combine(stage, HubUpdatePackage.ManifestName), Path.Combine(target, HubUpdatePackage.ManifestName));
        RemoveReplacementTemps(target, previous.Files.Select(f => f.Path).Union(next.Files.Select(f => f.Path)).Append(HubUpdatePackage.ManifestName));
    }

    internal static void Restore(string directory, string target, HubBackupFile[] files)
    {
        foreach (var file in files)
        {
            string destination = HubUpdatePackage.Resolve(target, file.Path);
            if (file.Existed)
            {
                string saved = HubUpdatePackage.Resolve(Path.Combine(directory, "backup"), file.Path);
                if (HubUpdatePackage.Hash(saved) != file.Sha256) throw new InvalidDataException("恢复文件校验失败。");
                // Unchanged locked files need no replacement during rollback.
                if (File.Exists(destination) && HubUpdatePackage.Hash(destination) == file.Sha256) continue;
                ReplaceFile(saved, destination);
            }
            else { Retry(() => File.Delete(destination)); RemoveEmptyParents(Path.GetDirectoryName(destination)!, target); }
        }
        RemoveReplacementTemps(target, files.Select(f => f.Path));
    }

    private static void RemoveReplacementTemps(string target, IEnumerable<string> paths)
    {
        foreach (string relative in paths)
        {
            string original = HubUpdatePackage.Resolve(target, relative), parent = Path.GetDirectoryName(original)!;
            if (!Directory.Exists(parent)) continue;
            string prefix = Path.GetFileName(original) + ".hub-update-";
            foreach (string file in Directory.EnumerateFiles(parent, prefix + "*"))
                if (Guid.TryParseExact(Path.GetFileName(file)[prefix.Length..], "N", out _))
                { HubUpdatePackage.RejectLinks(file); Retry(() => File.Delete(file)); }
        }
    }

    private static void RemoveEmptyParents(string directory, string root)
    {
        while (directory.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any())
        { Directory.Delete(directory); directory = Path.GetDirectoryName(directory)!; }
    }

    internal static bool ConfigureStartup(string[] args, string target)
    {
        if (args.Length != 2 || args[0] is not ("--hub-updated" or "--hub-update-failed")) return false;
        try
        {
            string directory = ValidateJobDirectory(Path.Combine(JobsRoot, args[1]));
            var job = ReadJob(directory);
            var journal = ReadJson<HubUpdateJournal>(Path.Combine(directory, "journal.json"));
            bool failed = args[0] == "--hub-update-failed";
            if (!string.Equals(job.Target, Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
                (failed ? journal.Phase is not ("rolledback" or "aborted") : journal.Phase != "starting")) return false;
            StartupJob = directory; StartupFailed = failed;
            return true;
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or JsonException or UnauthorizedAccessException or ArgumentException) { return false; }
    }

    internal static void MarkHealthy()
    {
        if (StartupJob == null) return;
        try
        {
            if (!StartupFailed)
            {
                var job = ReadJob(StartupJob);
                if (HubUpdatePackage.InstalledVersion(AppContext.BaseDirectory) != HubUpdatePackage.ParseVersion(job.TargetVersion)) return;
                File.WriteAllText(Path.Combine(StartupJob, "healthy"), job.TargetVersion);
            }
            string directory = StartupJob;
            StartupJob = null;
            _ = Task.Run(async () =>
            {
                for (int i = 0; i < 100; i++) { if (TryCleanJob(directory)) return; await Task.Delay(300); }
            });
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or JsonException or UnauthorizedAccessException) { }
    }

    internal static bool TryCleanJob(string directory)
    {
        try
        {
            directory = ValidateJobDirectory(directory);
            if (!Directory.Exists(directory)) return true;
            string journalPath = Path.Combine(directory, "journal.json");
            if (File.Exists(journalPath))
            {
                var journal = ReadJson<HubUpdateJournal>(journalPath);
                if (IsProcessAlive(journal.HelperPid, journal.HelperStartTicks) || journal.Phase is not ("complete" or "rolledback" or "aborted")) return false;
            }
            RejectTreeLinks(directory);
            Directory.Delete(directory, true);
            if (Directory.Exists(JobsRoot) && !Directory.EnumerateFileSystemEntries(JobsRoot).Any()) Directory.Delete(JobsRoot);
            return true;
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or JsonException or UnauthorizedAccessException or ArgumentException) { return false; }
    }

    private static void RejectTreeLinks(string root)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(root))
        {
            HubUpdatePackage.RejectLinks(entry);
            if (Directory.Exists(entry)) RejectTreeLinks(entry);
        }
    }

    internal static void CleanCompletedJobs()
    {
        try
        {
            HubUpdatePackage.RejectLinks(JobsRoot);
            if (!Directory.Exists(JobsRoot)) return;
            foreach (string directory in Directory.EnumerateDirectories(JobsRoot).ToArray())
            {
                if (!File.Exists(Path.Combine(directory, "journal.json")) && DateTime.UtcNow - Directory.GetLastWriteTimeUtc(directory) < TimeSpan.FromHours(6)) continue;
                TryCleanJob(directory);
            }
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException) { }
    }

    internal static async Task<bool> ResumeInterruptedAsync(string target)
    {
        HubUpdatePackage.RejectLinks(JobsRoot);
        if (!Directory.Exists(JobsRoot)) return false;
        foreach (string directory in Directory.EnumerateDirectories(JobsRoot).ToArray())
        {
            try
            {
                ValidateJobDirectory(directory);
                if (!File.Exists(Path.Combine(directory, "job.json")) || !File.Exists(Path.Combine(directory, "journal.json"))) continue;
                var job = ReadJob(directory);
                var journal = ReadJson<HubUpdateJournal>(Path.Combine(directory, "journal.json"));
                if (!string.Equals(job.Target, Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
                    IsProcessAlive(journal.HelperPid, journal.HelperStartTicks)) continue;
                if (journal.Phase is "waiting" or "backed-up")
                {
                    WriteJson(Path.Combine(directory, "journal.json"), journal with { Phase = "aborted" });
                    TryCleanJob(directory); continue;
                }
                if (journal.Phase is not ("applying" or "starting" or "recovering" or "recovery-needed")) continue;
                if (journal.Phase == "starting" && File.Exists(Path.Combine(directory, "healthy")) && File.ReadAllText(Path.Combine(directory, "healthy")) == job.TargetVersion)
                {
                    var manifest = HubUpdatePackage.ReadManifest(Path.Combine(target, HubUpdatePackage.ManifestName));
                    if (manifest.Version == job.TargetVersion)
                    {
                        VerifyFiles(target, manifest);
                        WriteJson(Path.Combine(directory, "journal.json"), journal with { Phase = "complete" });
                        TryCleanJob(directory); continue;
                    }
                }
                using var parent = Process.GetCurrentProcess();
                WriteJson(Path.Combine(directory, "job.json"), job with { ParentPid = parent.Id, ParentStartTicks = parent.StartTime.ToUniversalTime().Ticks });
                File.Delete(Path.Combine(directory, "helper-ready")); File.Delete(Path.Combine(directory, "abort")); File.Delete(Path.Combine(directory, "proceed"));
                string stage = Path.Combine(directory, "stage");
                var start = new ProcessStartInfo(Path.Combine(stage, "AntigravityHub.exe")) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = stage, WindowStyle = ProcessWindowStyle.Hidden };
                start.ArgumentList.Add("--recover-hub-update"); start.ArgumentList.Add(Path.Combine(directory, "job.json"));
                using var helper = Process.Start(start) ?? throw new IOException("无法启动更新恢复助手。");
                for (int i = 0; i < 100; i++)
                {
                    if (File.Exists(Path.Combine(directory, "helper-ready"))) { File.WriteAllText(Path.Combine(directory, "proceed"), "proceed"); return true; }
                    if (helper.HasExited) break;
                    await Task.Delay(100);
                }
                throw new IOException("更新恢复未能开始。请保留临时目录中的备份。");
            }
            catch (InvalidDataException) { }
            catch (JsonException) { }
        }
        return false;
    }
}
