using System;
using System.Collections.Generic;

namespace AntigravityHub
{
    public class AccountItem
    {
        public string Id { get; set; } = "";
        public string Email { get; set; } = "";
        public string Name { get; set; } = "";
        public string Tier { get; set; } = "";
        public bool IsCurrent { get; set; }
        public string AvatarUrl { get; set; } = "";
        public string AvatarDataUrl { get; set; } = "";
        public bool IdeRestartPending { get; set; }
        public int Gemini5hQuota { get; set; } = -1;
        public int GeminiWeeklyQuota { get; set; } = -1;
        public int Argon5hQuota { get; set; } = -1;
        public int ArgonWeeklyQuota { get; set; } = -1;
        public string ArgonResetTime5h { get; set; } = "";
        public string ArgonResetTimeWeekly { get; set; } = "";
        public int Claude5hQuota { get; set; } = -1;
        public int ClaudeWeeklyQuota { get; set; } = -1;
        public int Quota5hPercent => Gemini5hQuota;
        public int QuotaWeeklyPercent => GeminiWeeklyQuota;
        public string ResetTime5h { get; set; } = "";
        public string ResetTimeWeekly { get; set; } = "";
        public string ResetTime5hDesc { get; set; } = "";
        public string ResetTimeWeeklyDesc { get; set; } = "";
        public string ResetTime5hFormatted { get; set; } = "";
        public string ResetTimeWeeklyFormatted { get; set; } = "";

        public string ClaudeResetTime5h { get; set; } = "";
        public string ClaudeResetTimeWeekly { get; set; } = "";
        public string ClaudeResetTime5hDesc { get; set; } = "";
        public string ClaudeResetTimeWeeklyDesc { get; set; } = "";
        public string ClaudeResetTime5hFormatted { get; set; } = "";
        public string ClaudeResetTimeWeeklyFormatted { get; set; } = "";

        public string QuotaStatus { get; set; } = "unknown";
        public string LastQuotaRefreshTime { get; set; } = "";
        public string LastUsed { get; set; } = "";
    }

    public class AppSettings
    {
        public string Theme { get; set; } = "system";
        public bool EnableClientHud { get; set; } = true;
        public bool EnableClientLocalization { get; set; } = false;
        public bool EnableThinkingTranslation { get; set; } = false;
        public bool EnableClientWindowSize { get; set; } = false;
        public int ClientWindowWidth { get; set; } = 1400;
        public int ClientWindowHeight { get; set; } = 900;
        public string Currency { get; set; } = "CNY"; // "CNY" or "USD"
        public double LiveUsdToCnyRate { get; set; } = 7.24;
        public string LastRateFetchTime { get; set; } = "";
        public bool CloseToTray { get; set; } = true;
        public bool LaunchOnStartup { get; set; } = false;
        public bool StartMinimized { get; set; } = true;
        public bool CheckUpdatesOnStartup { get; set; } = true;
        public bool EnableGlobalHotkey { get; set; } = true;
        public string GlobalHotkey { get; set; } = "Alt + A";
        public int PollIntervalSeconds { get; set; } = 30;
    }

    public class ModelUsage
    {
        public string Name { get; set; } = "";
        public long Tokens { get; set; }
        public string Formatted { get; set; } = "";
        public double Percentage { get; set; }
        public double CostUsd { get; set; }
        public double CostRmb { get; set; }
        public string CostFormatted { get; set; } = "";
        public double CostPercentage { get; set; }
        public bool PriceKnown { get; set; } = true;
        public string PricingBasis { get; set; } = "unknown";
        public string Color { get; set; } = "#3C804F";
    }

    public class DailyRecord
    {
        public string Date { get; set; } = "";
        public long Tokens { get; set; }
        public string Formatted { get; set; } = "";
        public long InputTokens { get; set; }
        public string InputFormatted { get; set; } = "0";
        public long CacheWriteTokens { get; set; }
        public string CacheWriteFormatted { get; set; } = "0";
        public long UnclassifiedTokens { get; set; }
        public long UnpricedTokens { get; set; }
        public long CachedTokens { get; set; }
        public string CachedFormatted { get; set; } = "0";
        public long OutputTokens { get; set; }
        public string OutputFormatted { get; set; } = "0";
        public long ReasoningTokens { get; set; }
        public string ReasoningFormatted { get; set; } = "0";
        public double CachePercent { get; set; }
        public int Requests { get; set; }
        public double CostUsd { get; set; }
        public double CostRmb { get; set; }
        public string CostFormatted { get; set; } = "";
    }

    public class HeatmapDay
    {
        public string Date { get; set; } = "";
        public long Tokens { get; set; }
        public int Level { get; set; } // 0..4
    }

    public class TokenSummary
    {
        public long TotalTokens { get; set; }
        public long TodayTokens { get; set; }
        public long SevenDaysTokens { get; set; }
        public long ThirtyDaysTokens { get; set; }
        public string TotalFormatted { get; set; } = "0";
        public string TodayFormatted { get; set; } = "0";
        public string SevenDaysFormatted { get; set; } = "0";
        public string ThirtyDaysFormatted { get; set; } = "0";
        public int TodayRequests { get; set; }

        public double TotalCostUsd { get; set; }
        public double TotalCostRmb { get; set; }
        public string TotalCostFormatted { get; set; } = "¥0.00";

        public double TodayCostUsd { get; set; }
        public double TodayCostRmb { get; set; }
        public string TodayCostFormatted { get; set; } = "¥0.00";

        public double SevenDaysCostUsd { get; set; }
        public double SevenDaysCostRmb { get; set; }
        public string SevenDaysCostFormatted { get; set; } = "¥0.00";

        public double ThirtyDaysCostUsd { get; set; }
        public double ThirtyDaysCostRmb { get; set; }
        public string ThirtyDaysCostFormatted { get; set; } = "¥0.00";

        public long TodayInputTokens { get; set; }
        public string TodayInputFormatted { get; set; } = "0";
        public long UnpricedTokens { get; set; }
        public long TodayCacheWriteTokens { get; set; }
        public string TodayCacheWriteFormatted { get; set; } = "0";
        public long TodayUnclassifiedTokens { get; set; }
        public long TodayCachedTokens { get; set; }
        public string TodayCachedFormatted { get; set; } = "0";
        public long TodayOutputTokens { get; set; }
        public string TodayOutputFormatted { get; set; } = "0";
        public long TodayReasoningTokens { get; set; }
        public string TodayReasoningFormatted { get; set; } = "0";
        public double TodayCachePercent { get; set; }

        public List<ModelUsage> Models { get; set; } = new();
        public Dictionary<string, List<ModelUsage>> MonthlyModels { get; set; } = new();
        public Dictionary<string, List<ModelUsage>> DailyModels { get; set; } = new();
        public List<DailyRecord> DailyRecords { get; set; } = new();
        public List<HeatmapDay> Heatmap { get; set; } = new();
    }

    public class HubDataResponse
    {
        public List<AccountItem> Accounts { get; set; } = new();
        public AccountItem? CurrentAccount { get; set; }
        public TokenSummary Stats { get; set; } = new();
        public AppSettings Settings { get; set; } = new();
    }

    public class SwitchRequest
    {
        public string Action { get; set; } = "";
        public string AccountId { get; set; } = "";
    }

    public class SwitchResult
    {
        public bool Success { get; set; }
        public bool Cancelled { get; set; }
        public bool RequiresIdeRestart { get; set; }
        public bool IdeRestarted { get; set; }
        public string Message { get; set; } = "";
        public AccountItem? NewAccount { get; set; }
    }

    public class OpResult
    {
        public bool Success { get; set; }
        public string Message { get; set; } = "";
    }
}
