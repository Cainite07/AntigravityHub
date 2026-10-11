using System;
using System.Collections.Generic;

namespace AntigravityHub
{
    internal static class BrowserPolicy
    {
        public static readonly HashSet<string> Actions = new(StringComparer.Ordinal)
        {
            "windowDrag", "windowMin", "windowToggleMax", "windowClose", "setCloseToTray", "getSettings", "saveSettings", "setTheme",
            "openDataFolder", "fetchLiveRate", "windowResize", "modalStateChanged", "getInitialData", "refresh", "switchAccount",
            "importCurrentAccount", "importAccountFile", "startGoogleOAuth", "cancelGoogleOAuth", "submitManualAuthCode",
            "getAntigravityClientStatus", "deleteAccount", "getClientEnhancementStatus", "restartAntigravityClient"
        };

        public static bool IsTrustedDocument(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
            uri.Scheme == "https" && uri.Host == "app.local" && uri.IsDefaultPort &&
            uri.UserInfo.Length == 0 && uri.AbsolutePath == "/index.html" && uri.Query.Length == 0;

        public static bool CanOpenExternal(string address) => Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
            uri.Scheme == "https" && uri.Host == "accounts.google.com" && uri.IsDefaultPort && uri.UserInfo.Length == 0 &&
            uri.AbsolutePath == "/o/oauth2/v2/auth";
    }
}
