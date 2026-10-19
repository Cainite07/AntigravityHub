using System.Text.Json;
using AntigravityHub;

internal static class PricingTests
{
    public static List<string> Run()
    {
        var passed = new List<string>();
        void Check(bool condition, string name) { if (!condition) throw new Exception(name); passed.Add("Pricing: " + name); }
        string previous = HubStorage.HubDir;
        HubStorage.HubDir = Path.Combine(AppContext.BaseDirectory, "pricing-" + Guid.NewGuid().ToString("N"));
        HubStorage.EnsureInitialized();
        try
        {
            var prices = ModelPricingService.ReadSnapshot();
            Check(prices.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase).SetEquals(new[] {
                "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro",
                "claude-sonnet-5-5", "claude-opus-5-5", "gemini-4-argon", "gpt-oss-120b" }),
                "Built-in current catalog contains the updated menu models");
            foreach (var model in new[] { "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash" })
            {
                Check(ModelPricingService.TryResolve(prices, model, out var price, out var basis) && basis == "exact" &&
                    price.Input == .75 && price.CacheRead == .1875 && price.Output == 3.75 && price.CacheWrite == 0,
                    model + " has the requested complete reference rate");
            }
            Check(prices["gemini-3.1-pro"].CacheWrite == 0, "Pro cache write has no extra token charge in this estimate");
            Check(ModelPricingService.TryResolve(prices, "gemini-2.0-flash", out _, out var historicBasis) && historicBasis == "historical" &&
                !prices.ContainsKey("gemini-2.0-flash") && ModelPricingService.CatalogKey("gemini-2.0-flash") == null,
                "Retired historical model stays priceable without entering the seven-model catalog");
            foreach (var model in new[] { "gpt-oss-120b", "gpt-oss", "GPT-OSS 120B (Medium)" })
            {
                Check(ModelPricingService.TryResolve(prices, model, out var price, out _) &&
                    price.Input == .15 && price.CacheRead == .05 && price.Output == .60 && price.CacheWrite == 0,
                    model + " resolves to the requested OSS 120B reference");
            }
            foreach (var model in new[] { "claude-opus-4-6", "Claude Opus 4.6 (Thinking)", "claude-sonnet-4-6-thinking", "Claude Sonnet 4.6" })
            {
                Check(ModelPricingService.TryResolve(prices, model, out _, out var basis) && basis == "historical", model + " retains the historical 4.6 rate");
            }
            foreach (var model in new[] { "gemini-3.8-flash-n", "gemini-3.8-flash-n2", "gemini-3.8-flash-exp-a", "gemini-3.8-flash-tiered", "Gemini 3.8 Flash (Medium)", "claude-sonnet-5-5-n", "gpt-oss-120b-tiered" })
            {
                Check(ModelPricingService.TryResolve(prices, model, out var inherited, out var basis) && basis == "base-variant" &&
                    ModelPricingService.CatalogKey(model) is string canonical && inherited == prices[canonical],
                    model + " inherits its current menu base rate without a new catalog entry");
            }
            foreach (var model in new[] { "gemini-3.9-flash", "Gemini 3.9 Flash (Medium)", "gemini-3.9-pro", "claude-sonnet-4-7-thinking", "claude-4.7-opus",
                "gemini-3.8-flash-preview", "gemini-3.8-flash-exp-b", "gemini-3.8-flash-gray", "gemini-3.8-flash-lite", "gemini-3.8-flash-image", "gemini-3.8-flash-live",
                "unknown-pro-flash", "not-claude-sonnet-4-6", "gpt-oss-20b", "not-gpt-oss-120b", "", "sonnet" })
                Check(!ModelPricingService.TryResolve(prices, model, out _, out _), model + " cannot inherit an unrelated reference rate");
            Check(!ModelPricingService.TryResolve(prices, null, out _, out _), "Null model is unpriced without throwing");

            foreach (var model in new[] {"gemini-4-argon", "gemini-4-argon-trial", "Gemini 4 Argon (High)"}) {
                Check(ModelPricingService.TryResolve(prices, model, out var promo, out _, DateTimeOffset.Parse("2026-11-30T23:59:59Z")) && promo.Input==2 && promo.CacheRead==.10 && promo.Output==10, model+" introductory price");
                Check(ModelPricingService.TryResolve(prices, model, out var standard, out _, DateTimeOffset.Parse("2026-12-01T00:00:00Z")) && standard.Input==4 && standard.CacheRead==.20 && standard.Output==20, model+" scheduled standard price");
            }
            Check(ModelPricingService.TryResolve(prices,"Claude Opus 5.5 (Thinking)",out var opus55,out _) && opus55.Input==4 && opus55.CacheRead==.20 && opus55.Output==20 && opus55.CacheWrite==5,"Opus 5.5 complete official reference");
            Check(ModelPricingService.TryResolve(prices,"Claude Sonnet 5.5",out var sonnet55,out _) && sonnet55.Input==2 && sonnet55.CacheRead==.10 && sonnet55.Output==10 && sonnet55.CacheWrite==2.5,"Sonnet 5.5 complete official reference");
            string config = Path.Combine(HubStorage.HubDir, "model_pricing.json");
            var custom = new ModelPrice(10, 2, 20, .5, "fixture");
            File.WriteAllText(config, JsonSerializer.Serialize(new Dictionary<string, ModelPrice> {
                ["gemini-3.9-flash"] = custom, ["claude-sonnet-4-6-thinking"] = custom,
                ["gpt-oss-120b"] = custom, ["gemini-3.8-flash"] = custom, ["gemini-4-argon"] = custom }));
            prices = ModelPricingService.ReadSnapshot();
            Check(ModelPricingService.TryResolve(prices, "gemini-3.9-flash", out var exact, out var exactBasis) && exact == custom && exactBasis == "exact", "Exact future-model configuration wins over family fallback");
            Check(ModelPricingService.TryResolve(prices, "claude-sonnet-4-6-thinking", out exact, out exactBasis) && exact == custom && exactBasis == "exact", "Exact thinking configuration wins over alias");
            Check(ModelPricingService.TryResolve(prices, "gpt-oss", out exact, out _) && exact == custom, "OSS alias inherits canonical user override");
            Check(ModelPricingService.TryResolve(prices, "gemini-3.8-flash-n", out exact, out exactBasis) && exact == custom && exactBasis == "base-variant", "Known routing variant inherits its customized base rate");
            Check(!ModelPricingService.TryResolve(prices, "gemini-4.0-flash", out _, out _), "A new base version is not silently priced by an older model");
            Check(ModelPricingService.TryResolve(prices,"gemini-4-argon-trial",out var customArgon,out _,DateTimeOffset.Parse("2027-01-01T00:00:00Z")) && customArgon==custom,"User Argon override takes precedence over automatic price dates");
            var variantOverride = new ModelPrice(2, 1, 4, 0, "fixture-variant");
            File.WriteAllText(config, JsonSerializer.Serialize(new Dictionary<string, ModelPrice> { ["gemini-3.8-flash-n"] = variantOverride }));
            prices = ModelPricingService.ReadSnapshot();
            Check(ModelPricingService.TryResolve(prices, "gemini-3.8-flash-n", out exact, out exactBasis) && exact == variantOverride && exactBasis == "exact" &&
                ModelPricingService.CatalogKey("gemini-3.8-flash-n") == "gemini-3.8-flash", "Explicit variant override wins independently of its recorded model name");
            File.WriteAllText(config, "{\"fixture\":{\"Input\":1,\"CacheRead\":1,\"Output\":1,\"CacheWrite\":-0.5}}");
            bool invalid = false; try { ModelPricingService.ReadSnapshot(); } catch (InvalidDataException) { invalid = true; }
            Check(invalid, "Negative cache-write values other than the explicit unknown sentinel are rejected");
            File.Delete(config);

            var stats = new TokenStatsService();
            void Write(string model, long total = 5_000_000) => File.WriteAllText(HubStorage.TokensJsonl, JsonSerializer.Serialize(new {
                model, hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = total,
                input_tokens = 1_000_000, cached_input_tokens = 1_000_000, cache_creation_input_tokens = 1_000_000,
                output_tokens = 1_000_000, reasoning_output_tokens = 1_000_000, conversation_count = 1 }));
            Write("gemini-3.6-flash");
            var summary = stats.GetStats();
            double expected = .75 + .1875 + 2 * 3.75;
            Check(summary.TotalTokens == 5_000_000 && summary.TodayCacheWriteTokens == 1_000_000 && summary.UnpricedTokens == 0 &&
                Math.Abs(summary.TotalCostUsd - expected) < 1e-12 && !summary.TotalCostFormatted.Contains('≥') && !summary.TodayCostFormatted.Contains("未定价"),
                "Complete Gemini records retain cache writes and show a plain amount");
            string month = DateTime.Today.ToString("yyyy-MM"), day = DateTime.Today.ToString("yyyy-MM-dd");
            Check(summary.Models.Single().PriceKnown && summary.MonthlyModels[month].Single().PriceKnown &&
                summary.DailyModels[day].Single().PriceKnown && summary.DailyRecords.Single().UnpricedTokens == 0,
                "All-time/month/day models and daily records agree on Gemini pricing");
            Check(Math.Abs(TokenStatsService.CalculateCost("Gemini 3.6 Flash (Medium)", 1_000_000, 1_000_000, 1_000_000, 1_000_000, 7, 1_000_000).usd - expected) < 1e-12 &&
                TokenStatsService.GetModelPricing("gpt-oss").pin == .15, "Public calculation APIs share alias resolution");
            Write("gemini-3.8-flash-n"); summary = stats.GetStats();
            Check(summary.UnpricedTokens == 0 && summary.Models.Single().PricingBasis == "base-variant" &&
                summary.MonthlyModels[month].Single().PricingBasis == "base-variant" && summary.DailyModels[day].Single().PricingBasis == "base-variant" &&
                summary.Models.Single().Name == "gemini-3.8-flash-n" && summary.MonthlyModels[month].Single().Name == "gemini-3.8-flash-n" &&
                summary.DailyModels[day].Single().Name == "gemini-3.8-flash-n" && !summary.TotalCostFormatted.Contains('≥'),
                "Observed n variant inherits the base price but keeps its own portrait in all scopes");
            Write("gemini-3.9-flash"); summary = stats.GetStats();
            Check(summary.UnpricedTokens == 5_000_000 && !summary.Models.Single().PriceKnown && summary.TotalCostFormatted == "未定价",
                "A genuinely new base remains visibly unpriced until verified");
            File.WriteAllLines(HubStorage.TokensJsonl, new[] {
                JsonSerializer.Serialize(new { model = "gemini-3.8-flash", hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = 2_000_000, input_tokens = 1_000_000, cached_input_tokens = 1_000_000 }),
                JsonSerializer.Serialize(new { model = "gemini-3.8-flash-n", hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = 5_000_000, input_tokens = 1_000_000, cached_input_tokens = 4_000_000 }) });
            summary = stats.GetStats();
            Check(summary.Models.Count == 2 && summary.MonthlyModels[month].Count == 2 && summary.DailyModels[day].Count == 2 &&
                summary.Models.Single(m => m.Name == "gemini-3.8-flash").Tokens == 2_000_000 &&
                summary.Models.Single(m => m.Name == "gemini-3.8-flash-n").Tokens == 5_000_000 &&
                summary.MonthlyModels[month].Single(m => m.Name == "gemini-3.8-flash-n").Tokens == 5_000_000 &&
                summary.DailyModels[day].Single(m => m.Name == "gemini-3.8-flash-n").Tokens == 5_000_000 &&
                summary.Models.Single(m => m.Name == "gemini-3.8-flash-n").PricingBasis == "base-variant" &&
                Math.Abs(summary.TotalCostUsd - 2.4375) < 1e-12 && summary.UnpricedTokens == 0,
                "Base and n remain separate portraits while inheriting the same reference rate");
            File.WriteAllText(config, JsonSerializer.Serialize(new Dictionary<string, ModelPrice> { ["gemini-3.8-flash-n"] = variantOverride }));
            summary = stats.GetStats();
            Check(summary.Models.Count == 2 && Math.Abs(summary.Models.Single(m => m.Name == "gemini-3.8-flash-n").CostUsd - 6) < 1e-12 &&
                Math.Abs(summary.Models.Single(m => m.Name == "gemini-3.8-flash").CostUsd - .9375) < 1e-12 &&
                Math.Abs(summary.TotalCostUsd - 6.9375) < 1e-12 && summary.UnpricedTokens == 0,
                "Explicit variant override affects only that variant's separate portrait and the total");
            File.Delete(config);
            File.WriteAllLines(HubStorage.TokensJsonl, new[] {
                JsonSerializer.Serialize(new { model = "gemini-2.0-flash", hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = 5_000_000, input_tokens = 1_000_000, cached_input_tokens = 1_000_000, cache_creation_input_tokens = 1_000_000, output_tokens = 1_000_000, reasoning_output_tokens = 1_000_000 }),
                JsonSerializer.Serialize(new { model = "claude-3.7-sonnet", hour_start = DateTimeOffset.Now.ToString("o"), total_tokens = 5_000_000, input_tokens = 1_000_000, cached_input_tokens = 1_000_000, cache_creation_input_tokens = 1_000_000, output_tokens = 1_000_000, reasoning_output_tokens = 1_000_000 }) });
            summary = stats.GetStats();
            Check(summary.Models.Count == 2 && summary.MonthlyModels[month].Count == 2 && summary.DailyModels[day].Count == 2 &&
                summary.Models.All(m => m.PricingBasis == "historical" && m.PriceKnown) &&
                summary.Models.Any(m => m.Name == "gemini-2.0-flash") && summary.Models.Any(m => m.Name == "claude-3.7-sonnet") &&
                Math.Abs(summary.TotalCostUsd - 45.4875) < 1e-12 && summary.UnpricedTokens == 0,
                "Retired models retain separate historical portraits and their original reference rates");
            Write("gemini-3.6-flash", 5_000_100); summary = stats.GetStats();
            Check(summary.UnpricedTokens == 100 && summary.TotalCostFormatted.StartsWith('≥'), "Unclassified token differences remain visibly unpriced");
            File.WriteAllText(config, "{\"gemini-3.6-flash\":{\"Input\":0.75,\"CacheRead\":0.1875,\"Output\":3.75,\"CacheWrite\":-1}}");
            Write("gemini-3.6-flash"); summary = stats.GetStats();
            Check(summary.UnpricedTokens == 1_000_000 && summary.TotalCostFormatted.Contains("部分未定价"), "User's explicit unknown cache-write override remains respected");
        }
        finally { HubStorage.HubDir = previous; }
        return passed;
    }
}
