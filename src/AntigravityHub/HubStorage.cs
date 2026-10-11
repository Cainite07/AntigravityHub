using System;
using System.IO;

namespace AntigravityHub
{
    public static class HubStorage
    {
        private static readonly string UserProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        private static readonly object InitializationLock = new();
        private static bool _initialized;
        public static string HubDir => Path.Combine(UserProfile, ".antigravity_hub");
        public static string AccountsJson => Path.Combine(HubDir, "accounts.json");
        public static string AccountsDetailDir => Path.Combine(HubDir, "accounts");
        public static string TokensJsonl => Path.Combine(HubDir, "tokens.jsonl");
        public static string CursorsJson => Path.Combine(HubDir, "cursors.json");

        public static void EnsureInitialized()
        {
            lock (InitializationLock)
            {
                if (_initialized) return;
                Directory.CreateDirectory(HubDir);
                Directory.CreateDirectory(AccountsDetailDir);
                if (!File.Exists(AccountsJson))
                {
                    string legacyDir = Path.Combine(UserProfile, ".antigravity_tools");
                    string legacyAccounts = Path.Combine(legacyDir, "accounts.json");
                    string details = Path.Combine(legacyDir, "accounts");
                    // Publish the index last: an interrupted migration retries missing details.
                    if (File.Exists(legacyAccounts))
                    {
                        if (Directory.Exists(details))
                            foreach (string file in Directory.GetFiles(details, "*.json"))
                            {
                                string destination = Path.Combine(AccountsDetailDir, Path.GetFileName(file));
                                if (!File.Exists(destination)) AtomicFile.WriteBytes(destination, File.ReadAllBytes(file));
                            }
                        AtomicFile.WriteBytes(AccountsJson, File.ReadAllBytes(legacyAccounts));
                    }
                }
                if (!File.Exists(TokensJsonl))
                {
                    string queue = Path.Combine(UserProfile, ".tokentracker", "tracker", "queue.jsonl");
                    if (File.Exists(queue)) AtomicFile.WriteBytes(TokensJsonl, File.ReadAllBytes(queue));
                }
                // An IO failure propagates and leaves initialization retryable.
                _initialized = true;
            }
        }
    }
}
