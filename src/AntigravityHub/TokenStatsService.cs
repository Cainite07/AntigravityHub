using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;

namespace AntigravityHub
{
    public class TokenStatsService
    {
        private readonly string _tokensPath;
        private readonly NativeTokenTracker _nativeTracker;
        private readonly SettingsService? _settingsService;

        public TokenStatsService(SettingsService? settingsService = null)
        {
            HubStorage.EnsureInitialized();
            _tokensPath = HubStorage.TokensJsonl;
            _nativeTracker = new NativeTokenTracker();
            _settingsService = settingsService;
        }

        private readonly object _statisticsLock = new();
        private TokenSummary? _cachedSummary;
        private TokenSummary? _lastKnownSummary;
        private string? _snapshotKey;

        public TokenSummary GetCachedStats()
        {
            // Keep the last successful snapshot visible while settings trigger a recalculation.
            lock (_statisticsLock) return _cachedSummary ?? _lastKnownSummary ?? new TokenSummary();
        }

        public async Task<TokenSummary> GetStatsAsync(bool triggerScan = true, CancellationToken cancellationToken = default)
        {
            if (triggerScan)
            {
                await _nativeTracker.ScanAndAggregateAsync(cancellationToken: cancellationToken);
            }

            return await Task.Run(() => GetStatsInternal(), cancellationToken);
        }

        public TokenSummary GetStats()
        {
            return GetStatsInternal();
        }

        public void InvalidateCache()
        {
            lock (_statisticsLock) _cachedSummary = null;
        }

        public static (double pin, double pcache, double pout) GetModelPricing(string model)
        {
            return ModelPricingService.TryResolve(ModelPricingService.ReadSnapshot(), model, out var price, out _)
                ? (price.Input, price.CacheRead, price.Output) : (0, 0, 0);
        }

        public static (double usd, double rmb) CalculateCost(string model, long inTok, long cachedTok, long outTok, long reasonTok, double exchangeRate, long cacheWriteTok = 0)
        {
            var prices = ModelPricingService.ReadSnapshot();
            double usd = ModelPricingService.TryResolve(prices, model, out var p, out _)
                ? (inTok * p.Input + cachedTok * p.CacheRead + (outTok + reasonTok) * p.Output + cacheWriteTok * Math.Max(0, p.CacheWrite)) / 1_000_000.0 : 0;
            return (usd, usd * exchangeRate);
        }

        private static string FormatReferenceCost(double usd, double rmb, string currency, long unpricedTokens) =>
            unpricedTokens > 0 ? (usd > 0 ? "≥" + FormatMoney(usd, rmb, currency) + "（部分未定价）" : "未定价") : FormatMoney(usd, rmb, currency);

        public static string FormatMoney(double usd, double rmb, string currency)
        {
            if (string.Equals(currency, "USD", StringComparison.OrdinalIgnoreCase))
            {
                return $"${usd:N2}";
            }
            return $"¥{rmb:N2}";
        }

        private TokenSummary GetStatsInternal()
        {
            lock (_statisticsLock)
            {
                var settings = _settingsService?.GetSettings() ?? new AppSettings();
                static string Stamp(string path)
                {
                    var file = new FileInfo(path);
                    return file.Exists ? $"{file.Length}:{file.LastWriteTimeUtc.Ticks}" : "missing";
                }
                // Include external writes, changed reference prices, exchange rates and local midnight.
                string key = $"{DateTime.Today.Ticks}:{TimeZoneInfo.Local.Id}:{settings.Currency}:{settings.LiveUsdToCnyRate:R}:"
                    + Stamp(UsageRepository.DefaultPath) + ":" + Stamp(UsageRepository.DefaultPath + "-wal")
                    + ":" + Stamp(_tokensPath) + ":" + Stamp(Path.Combine(HubStorage.HubDir, "model_pricing.json"));
                if (_cachedSummary != null && _snapshotKey == key) return _cachedSummary;
                var summary = CalculateSnapshot();
                _snapshotKey = key;
                return summary;
            }
        }

        private TokenSummary CalculateSnapshot()
        {
            var summary = new TokenSummary();
            if (!File.Exists(_tokensPath) && !File.Exists(UsageRepository.DefaultPath))
            {
                return summary;
            }

            var settings = _settingsService?.GetSettings() ?? new AppSettings();
            double exchangeRate = settings.LiveUsdToCnyRate > 0 ? settings.LiveUsdToCnyRate : 7.24;
            string currency = settings.Currency ?? "CNY";

            var prices = ModelPricingService.ReadSnapshot();
            var pricingBasis = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var monthlyPricingBasis = new Dictionary<string, Dictionary<string, string>>();
            var dailyPricingBasis = new Dictionary<string, Dictionary<string, string>>();
            static void MergePricingBasis(Dictionary<string, string> byModel, string model, string basis)
            {
                if (!byModel.TryGetValue(model, out var previous)) byModel[model] = basis;
                else if (previous == "base-variant" || basis == "base-variant") byModel[model] = "base-variant";
                else if (previous != basis) byModel[model] = "mixed";
            }
            var unpricedModels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var dailyUnpriced = new Dictionary<string, long>();
            var monthlyUnpricedModels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var dailyUnpricedModels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long totalUnpriced = 0, todayUnpriced = 0, sevenUnpriced = 0, thirtyUnpriced = 0;
            var modelMap = new Dictionary<string, (long tokens, double costUsd, double costRmb)>(StringComparer.OrdinalIgnoreCase);
            var monthlyModelMap = new Dictionary<string, Dictionary<string, (long tokens, double costUsd, double costRmb)>>(StringComparer.OrdinalIgnoreCase);
            var dailyModelMap = new Dictionary<string, Dictionary<string, (long tokens, double costUsd, double costRmb)>>(StringComparer.OrdinalIgnoreCase);
            var dayMap = new Dictionary<string, (long tokens, long inTok, long cachedTok, long cacheWriteTok, long outTok, long reasonTok, int reqs, double costUsd, double costRmb)>();

            DateTime today = DateTime.Today;
            // Include today: the rolling windows contain exactly 7 and 30 local dates.
            DateTime sevenDaysAgo = today.AddDays(-6);
            DateTime thirtyDaysAgo = today.AddDays(-29);

            long totalTokens = 0;
            double totalCostUsd = 0;
            double totalCostRmb = 0;

            long todayTokens = 0;
            double todayCostUsd = 0;
            double todayCostRmb = 0;
            long todayInTok = 0;
            long todayCachedTok = 0;
            long todayCacheWriteTok = 0;
            long todayOutTok = 0;
            long todayReasonTok = 0;
            int todayReqs = 0;

            long sevenDaysTokens = 0;
            double sevenDaysCostUsd = 0;
            double sevenDaysCostRmb = 0;

            long thirtyDaysTokens = 0;
            double thirtyDaysCostUsd = 0;
            double thirtyDaysCostRmb = 0;

            try
            {
                var repository = new UsageRepository(UsageRepository.DefaultPath);
                IEnumerable<string> lines = repository.IsInitialized() ? repository.ReadBuckets() : File.Exists(_tokensPath) ? File.ReadLines(_tokensPath) : Array.Empty<string>();
                foreach (string line in lines)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        using var doc = JsonDocument.Parse(line);
                        var root = doc.RootElement;
                        long tokens = root.TryGetProperty("total_tokens", out var tElem) ? tElem.GetInt64() : 0;
                        long inTok = root.TryGetProperty("input_tokens", out var inElem) ? inElem.GetInt64() : 0;
                        long cachedTok = root.TryGetProperty("cached_input_tokens", out var cElem) ? cElem.GetInt64() : 0;
                        long cacheWriteTok = root.TryGetProperty("cache_creation_input_tokens", out var cwElem) ? cwElem.GetInt64() : 0;
                        long outTok = root.TryGetProperty("output_tokens", out var oElem) ? oElem.GetInt64() : 0;
                        long reasonTok = root.TryGetProperty("reasoning_output_tokens", out var rElem) ? rElem.GetInt64() : 0;
                        string model = root.TryGetProperty("model", out var mElem) ? mElem.GetString() ?? "unknown" : "unknown";
                        string hourStart = root.TryGetProperty("hour_start", out var hElem) ? hElem.GetString() ?? "" : "";
                        int convCount = root.TryGetProperty("conversation_count", out var cntElem) ? cntElem.GetInt32() : 1;

                        long parts = checked(inTok + cachedTok + cacheWriteTok + outTok + reasonTok);
                        if (tokens < 0 || inTok < 0 || cachedTok < 0 || cacheWriteTok < 0 || outTok < 0 || reasonTok < 0) throw new InvalidDataException("用量记录含负数。");
                        tokens = Math.Max(tokens, parts);
                        bool priced = ModelPricingService.TryResolve(prices, model, out var price, out var basis,
                            DateTimeOffset.TryParse(hourStart, out var usageTime) ? usageTime : null);
                        // Preserve each recorded model name in every usage breakdown. Pricing may
                        // inherit a base rate, but that must not merge the model's usage portrait.
                        string displayModel = model;
                        MergePricingBasis(pricingBasis, displayModel, basis);
                        long unpriced = priced ? Math.Max(0, tokens - parts) + (price!.CacheWrite < 0 ? cacheWriteTok : 0) : tokens;
                        if (unpriced > 0) unpricedModels.Add(displayModel);
                        totalUnpriced += unpriced;
                        double recUsd = priced ? (inTok * price!.Input + cachedTok * price.CacheRead + (outTok + reasonTok) * price.Output + cacheWriteTok * Math.Max(0, price.CacheWrite)) / 1_000_000.0 : 0;
                        double recRmb = recUsd * exchangeRate;

                        totalTokens += tokens;
                        totalCostUsd += recUsd;
                        totalCostRmb += recRmb;

                        // Model breakdown (All-time)
                        if (!modelMap.ContainsKey(displayModel)) modelMap[displayModel] = (0, 0, 0);
                        var curM = modelMap[displayModel];
                        modelMap[displayModel] = (curM.tokens + tokens, curM.costUsd + recUsd, curM.costRmb + recRmb);

                        // Daily and Monthly aggregation with exact local timezone conversion (UTC+8 / system timezone)
                        if (!string.IsNullOrEmpty(hourStart) && DateTimeOffset.TryParse(hourStart, out var dto))
                        {
                            DateTime localRecordDate = dto.LocalDateTime.Date;
                            string day = localRecordDate.ToString("yyyy-MM-dd");
                            string month = localRecordDate.ToString("yyyy-MM");
                            if (!monthlyPricingBasis.TryGetValue(month, out var monthBasis)) monthlyPricingBasis[month] = monthBasis = new(StringComparer.OrdinalIgnoreCase);
                            if (!dailyPricingBasis.TryGetValue(day, out var dayBasis)) dailyPricingBasis[day] = dayBasis = new(StringComparer.OrdinalIgnoreCase);
                            MergePricingBasis(monthBasis, displayModel, basis);
                            MergePricingBasis(dayBasis, displayModel, basis);
                            if (unpriced > 0) { monthlyUnpricedModels.Add(month + "|" + displayModel); dailyUnpricedModels.Add(day + "|" + displayModel); }

                            if (!monthlyModelMap.ContainsKey(month)) monthlyModelMap[month] = new Dictionary<string, (long tokens, double costUsd, double costRmb)>(StringComparer.OrdinalIgnoreCase);
                            if (!monthlyModelMap[month].ContainsKey(displayModel)) monthlyModelMap[month][displayModel] = (0, 0, 0);
                            var mm = monthlyModelMap[month][displayModel];
                            monthlyModelMap[month][displayModel] = (mm.tokens + tokens, mm.costUsd + recUsd, mm.costRmb + recRmb);

                            if (!dailyModelMap.ContainsKey(day)) dailyModelMap[day] = new Dictionary<string, (long tokens, double costUsd, double costRmb)>(StringComparer.OrdinalIgnoreCase);
                            if (!dailyModelMap[day].ContainsKey(displayModel)) dailyModelMap[day][displayModel] = (0, 0, 0);
                            var dmMod = dailyModelMap[day][displayModel];
                            dailyModelMap[day][displayModel] = (dmMod.tokens + tokens, dmMod.costUsd + recUsd, dmMod.costRmb + recRmb);

                            if (!dayMap.ContainsKey(day)) dayMap[day] = (0, 0, 0, 0, 0, 0, 0, 0, 0);
                            var dm = dayMap[day];
                            dayMap[day] = (dm.tokens + tokens, dm.inTok + inTok, dm.cachedTok + cachedTok, dm.cacheWriteTok + cacheWriteTok, dm.outTok + outTok, dm.reasonTok + reasonTok, dm.reqs + convCount, dm.costUsd + recUsd, dm.costRmb + recRmb);

                            dailyUnpriced[day] = dailyUnpriced.GetValueOrDefault(day) + unpriced;
                            if (localRecordDate == today)
                            {
                                todayTokens += tokens;
                                todayCostUsd += recUsd;
                                todayCostRmb += recRmb;
                                todayReqs += convCount;
                                todayInTok += inTok;
                                todayCachedTok += cachedTok;
                                todayCacheWriteTok += cacheWriteTok;
                                todayUnpriced += unpriced;
                                todayOutTok += outTok;
                                todayReasonTok += reasonTok;
                            }
                            if (localRecordDate >= sevenDaysAgo && localRecordDate <= today)
                            {
                                sevenDaysTokens += tokens;
                                sevenUnpriced += unpriced;
                                sevenDaysCostUsd += recUsd;
                                sevenDaysCostRmb += recRmb;
                            }
                            if (localRecordDate >= thirtyDaysAgo && localRecordDate <= today)
                            {
                                thirtyDaysTokens += tokens;
                                thirtyUnpriced += unpriced;
                                thirtyDaysCostUsd += recUsd;
                                thirtyDaysCostRmb += recRmb;
                            }
                        }
                    }
                    catch (JsonException) { throw new InvalidDataException("历史用量中存在损坏的 JSON，已保留原数据。"); }
                }
            }
            catch { throw; }

            summary.TotalTokens = totalTokens;
            summary.TotalCostUsd = totalCostUsd;
            summary.TotalCostRmb = totalCostRmb;
            summary.TotalCostFormatted = FormatReferenceCost(totalCostUsd, totalCostRmb, currency, totalUnpriced);

            summary.TodayTokens = todayTokens;
            summary.TodayCostUsd = todayCostUsd;
            summary.TodayCostRmb = todayCostRmb;
            summary.TodayCostFormatted = FormatReferenceCost(todayCostUsd, todayCostRmb, currency, todayUnpriced);

            summary.TodayRequests = todayReqs;
            summary.SevenDaysTokens = sevenDaysTokens;
            summary.SevenDaysCostUsd = sevenDaysCostUsd;
            summary.SevenDaysCostRmb = sevenDaysCostRmb;
            summary.SevenDaysCostFormatted = FormatReferenceCost(sevenDaysCostUsd, sevenDaysCostRmb, currency, sevenUnpriced);

            summary.ThirtyDaysTokens = thirtyDaysTokens;
            summary.ThirtyDaysCostUsd = thirtyDaysCostUsd;
            summary.ThirtyDaysCostRmb = thirtyDaysCostRmb;
            summary.ThirtyDaysCostFormatted = FormatReferenceCost(thirtyDaysCostUsd, thirtyDaysCostRmb, currency, thirtyUnpriced);

            summary.TotalFormatted = FormatTokenCount(totalTokens);
            summary.TodayFormatted = FormatTokenCount(todayTokens);
            summary.SevenDaysFormatted = FormatTokenCount(sevenDaysTokens);
            summary.ThirtyDaysFormatted = FormatTokenCount(thirtyDaysTokens);

            summary.UnpricedTokens = totalUnpriced;
            summary.TodayCacheWriteTokens = todayCacheWriteTok;
            summary.TodayCacheWriteFormatted = FormatTokenCount(todayCacheWriteTok);
            summary.TodayUnclassifiedTokens = Math.Max(0, todayTokens - todayInTok - todayCachedTok - todayCacheWriteTok - todayOutTok - todayReasonTok);
            summary.TodayInputTokens = todayInTok;
            summary.TodayInputFormatted = FormatTokenCount(todayInTok);
            summary.TodayCachedTokens = todayCachedTok;
            summary.TodayCachedFormatted = FormatTokenCount(todayCachedTok);
            summary.TodayOutputTokens = todayOutTok;
            summary.TodayOutputFormatted = FormatTokenCount(todayOutTok);
            summary.TodayReasoningTokens = todayReasonTok;
            summary.TodayReasoningFormatted = FormatTokenCount(todayReasonTok);
            summary.TodayCachePercent = todayTokens > 0 ? Math.Round((double)todayCachedTok / todayTokens * 100.0, 1) : 0;

            // Models breakdown (All-time)
            var colors = new[] { "#3C804F", "#466B82", "#8C3F2B", "#D97706", "#7C3AED", "#DB2777", "#64748B" };
            int colorIdx = 0;
            foreach (var kv in modelMap.OrderByDescending(m => m.Value.tokens))
            {
                double pct = totalTokens > 0 ? Math.Round((double)kv.Value.tokens / totalTokens * 100.0, 1) : 0;
                double costPct = totalCostRmb > 0 ? Math.Round(kv.Value.costRmb / totalCostRmb * 100.0, 1) : 0;
                summary.Models.Add(new ModelUsage
                {
                    Name = kv.Key,
                    Tokens = kv.Value.tokens,
                    Formatted = FormatTokenCount(kv.Value.tokens),
                    Percentage = pct,
                    CostUsd = kv.Value.costUsd,
                    CostRmb = kv.Value.costRmb,
                    CostFormatted = FormatReferenceCost(kv.Value.costUsd, kv.Value.costRmb, currency, unpricedModels.Contains(kv.Key) ? 1 : 0),
                    PriceKnown = !unpricedModels.Contains(kv.Key),
                    PricingBasis = pricingBasis[kv.Key],
                    CostPercentage = costPct,
                    Color = colors[colorIdx % colors.Length]
                });
                colorIdx++;
            }

            // Monthly models breakdown
            foreach (var mKv in monthlyModelMap.OrderByDescending(m => m.Key))
            {
                long mTotal = mKv.Value.Values.Sum(x => x.tokens);
                double mCostTotal = mKv.Value.Values.Sum(x => x.costRmb);
                var mList = new List<ModelUsage>();
                int mColorIdx = 0;
                foreach (var kv in mKv.Value.OrderByDescending(x => x.Value.tokens))
                {
                    double pct = mTotal > 0 ? Math.Round((double)kv.Value.tokens / mTotal * 100.0, 1) : 0;
                    double costPct = mCostTotal > 0 ? Math.Round(kv.Value.costRmb / mCostTotal * 100.0, 1) : 0;
                    mList.Add(new ModelUsage
                    {
                        Name = kv.Key,
                        Tokens = kv.Value.tokens,
                        Formatted = FormatTokenCount(kv.Value.tokens),
                        Percentage = pct,
                        CostUsd = kv.Value.costUsd,
                        CostRmb = kv.Value.costRmb,
                        CostFormatted = FormatReferenceCost(kv.Value.costUsd, kv.Value.costRmb, currency, monthlyUnpricedModels.Contains(mKv.Key + "|" + kv.Key) ? 1 : 0),
                        PriceKnown = !monthlyUnpricedModels.Contains(mKv.Key + "|" + kv.Key),
                        PricingBasis = monthlyPricingBasis[mKv.Key][kv.Key],
                        CostPercentage = costPct,
                        Color = colors[mColorIdx % colors.Length]
                    });
                    mColorIdx++;
                }
                summary.MonthlyModels[mKv.Key] = mList;
            }

            // Daily models breakdown
            foreach (var dKv in dailyModelMap.OrderByDescending(d => d.Key))
            {
                long dTotal = dKv.Value.Values.Sum(x => x.tokens);
                double dCostTotal = dKv.Value.Values.Sum(x => x.costRmb);
                var dList = new List<ModelUsage>();
                int dColorIdx = 0;
                foreach (var kv in dKv.Value.OrderByDescending(x => x.Value.tokens))
                {
                    double pct = dTotal > 0 ? Math.Round((double)kv.Value.tokens / dTotal * 100.0, 1) : 0;
                    double costPct = dCostTotal > 0 ? Math.Round(kv.Value.costRmb / dCostTotal * 100.0, 1) : 0;
                    dList.Add(new ModelUsage
                    {
                        Name = kv.Key,
                        Tokens = kv.Value.tokens,
                        Formatted = FormatTokenCount(kv.Value.tokens),
                        Percentage = pct,
                        CostUsd = kv.Value.costUsd,
                        CostRmb = kv.Value.costRmb,
                        CostFormatted = FormatReferenceCost(kv.Value.costUsd, kv.Value.costRmb, currency, dailyUnpricedModels.Contains(dKv.Key + "|" + kv.Key) ? 1 : 0),
                        PriceKnown = !dailyUnpricedModels.Contains(dKv.Key + "|" + kv.Key),
                        PricingBasis = dailyPricingBasis[dKv.Key][kv.Key],
                        CostPercentage = costPct,
                        Color = colors[dColorIdx % colors.Length]
                    });
                    dColorIdx++;
                }
                summary.DailyModels[dKv.Key] = dList;
            }

            // Daily records (Dynamic, sorted descending)
            foreach (var kv in dayMap.OrderByDescending(d => d.Key))
            {
                var v = kv.Value;
                double cachePct = v.tokens > 0 ? Math.Round((double)v.cachedTok / v.tokens * 100.0, 1) : 0;
                summary.DailyRecords.Add(new DailyRecord
                {
                    Date = kv.Key,
                    Tokens = v.tokens,
                    Formatted = FormatTokenCount(v.tokens),
                    InputTokens = v.inTok,
                    InputFormatted = FormatTokenCount(v.inTok),
                    CacheWriteTokens = v.cacheWriteTok,
                    CacheWriteFormatted = FormatTokenCount(v.cacheWriteTok),
                    UnclassifiedTokens = Math.Max(0, v.tokens - v.inTok - v.cachedTok - v.cacheWriteTok - v.outTok - v.reasonTok),
                    UnpricedTokens = dailyUnpriced.GetValueOrDefault(kv.Key),
                    CachedTokens = v.cachedTok,
                    CachedFormatted = FormatTokenCount(v.cachedTok),
                    OutputTokens = v.outTok,
                    OutputFormatted = FormatTokenCount(v.outTok),
                    ReasoningTokens = v.reasonTok,
                    ReasoningFormatted = FormatTokenCount(v.reasonTok),
                    CachePercent = cachePct,
                    Requests = v.reqs,
                    CostUsd = v.costUsd,
                    CostRmb = v.costRmb,
                    CostFormatted = FormatReferenceCost(v.costUsd, v.costRmb, currency, dailyUnpriced.GetValueOrDefault(kv.Key))
                });
            }

            // Heatmap past 52 weeks (364 days)
            DateTime startDate = today.AddDays(-363);
            var activeAmounts = dayMap.Where(item => string.CompareOrdinal(item.Key, startDate.ToString("yyyy-MM-dd")) >= 0 &&
                string.CompareOrdinal(item.Key, today.ToString("yyyy-MM-dd")) <= 0 && item.Value.tokens > 0).Select(item => item.Value.tokens).OrderBy(n => n).ToArray();
            double Quantile(double q)
            {
                if (activeAmounts.Length == 0) return 0;
                double index = (activeAmounts.Length - 1) * q; int lower = (int)Math.Floor(index), upper = (int)Math.Ceiling(index);
                return activeAmounts[lower] + (activeAmounts[upper] - activeAmounts[lower]) * (index - lower);
            }
            var thresholds = new[] { Quantile(.25), Quantile(.5), Quantile(.75) };
            for (int i = 0; i < 364; i++)
            {
                var curDate = startDate.AddDays(i);
                string dStr = curDate.ToString("yyyy-MM-dd");
                long dayTokens = dayMap.TryGetValue(dStr, out var dVal) ? dVal.tokens : 0;

                int level = dayTokens > 0 ? 1 + thresholds.Count(boundary => dayTokens > boundary) : 0;

                summary.Heatmap.Add(new HeatmapDay
                {
                    Date = dStr,
                    Tokens = dayTokens,
                    Level = level
                });
            }

            _lastKnownSummary = summary;
            _cachedSummary = summary;
            return summary;
        }

        private static string FormatTokenCount(long count)
        {
            if (count >= 1_000_000_000)
                return $"{count / 1_000_000_000.0:F2}B";
            if (count >= 1_000_000)
                return $"{count / 1_000_000.0:F1}M";
            if (count >= 1_000)
                return $"{count / 1_000.0:F1}K";
            return count.ToString("N0");
        }
    }
}
