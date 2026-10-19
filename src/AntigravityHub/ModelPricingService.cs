using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AntigravityHub
{
    internal sealed record ModelPrice(double Input, double CacheRead, double Output, double CacheWrite,
        string Source = "project-reference-unverified", string EffectiveDate = "2026-09-27");

    internal static class ModelPricingService
    {
        private static readonly ModelPrice ArgonIntro = new(2, .10, 10, 0, "https://ai.google.dev/gemini-api/docs/pricing", "2026-09-30");
        private static readonly ModelPrice ArgonStandard = new(4, .20, 20, 0, "https://ai.google.dev/gemini-api/docs/pricing", "2026-12-01");
        private static ModelPrice ArgonAt(DateTimeOffset date) => date.UtcDateTime >= new DateTime(2026,12,1) ? ArgonStandard : ArgonIntro;
        private static ModelPrice AtDate(ModelPrice price, DateTimeOffset? date) =>
            ReferenceEquals(price, ArgonIntro) || ReferenceEquals(price, ArgonStandard) ? ArgonAt(date ?? DateTimeOffset.UtcNow) : price;
        // USD / million tokens: project reference estimates, never the subscription bill.
        // Gemini write=0 assumes no additional token write charge; TTL/storage is not measured.
        private static readonly Dictionary<string, ModelPrice> Defaults = new(StringComparer.OrdinalIgnoreCase)
        {
            ["claude-opus-5-5"] = new(4, .20, 20, 5, "https://platform.claude.com/docs/en/about-claude/pricing", "2026-09-22"),
            ["claude-sonnet-5-5"] = new(2, .10, 10, 2.5, "https://platform.claude.com/docs/en/about-claude/pricing", "2026-09-28"),
            ["gemini-4-argon"] = ArgonIntro,
            ["gemini-3.1-pro"] = new(2, .5, 12, 0),
            ["gemini-3.8-flash"] = new(.75, .1875, 3.75, 0),
            ["gemini-3.7-flash"] = new(.75, .1875, 3.75, 0),
            ["gemini-3.6-flash"] = new(.75, .1875, 3.75, 0),
            ["gpt-oss-120b"] = new(.15, .05, .60, 0)
        };
        // Preserve estimates for old local history without advertising retired models in the current model catalog.
        private static readonly Dictionary<string, ModelPrice> Historical = new(StringComparer.OrdinalIgnoreCase)
        {
            ["claude-opus-4-6-thinking"] = new(5, .5, 25, 6.25),
            ["claude-sonnet-4-6"] = new(3, .3, 15, 3.75),
            ["claude-3.7-sonnet"] = new(3, .3, 15, 3.75),
            ["gemini-2.0-flash"] = new(.75, .1875, 3.75, 0)
        };
        private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
        {
            ["claude-opus-4-6"] = "claude-opus-4-6-thinking",
            ["claude-sonnet-4-6-thinking"] = "claude-sonnet-4-6",
            ["claude-4-6-opus"] = "claude-opus-4-6-thinking",
            ["claude-4-6-sonnet"] = "claude-sonnet-4-6",
            ["gpt-oss"] = "gpt-oss-120b"
        };
        // Only routing/quality labels known to leave the base model unchanged. Preview/experimental
        // suffixes are not accepted wholesale: a gray-test model can have a different price.
        private static readonly Regex VariantSuffix = new(@"^(?:n[0-9]*|tiered|low|medium|high|thinking)(?:-(?:n[0-9]*|tiered|low|medium|high|thinking))*$", RegexOptions.CultureInvariant);
        private static readonly Dictionary<string, string> ObservedVariants = new(StringComparer.OrdinalIgnoreCase)
        {
            ["gemini-3.8-flash-exp-a"] = "gemini-3.8-flash",
            ["gemini-4-argon-trial"] = "gemini-4-argon"
        };

        public static string NormalizeModelKey(string? model)
        {
            string key = (model ?? "").Trim().ToLowerInvariant();
            key = Regex.Replace(key, @"\s*\((low|medium|high|thinking)\)$", "-$1", RegexOptions.CultureInvariant);
            key = Regex.Replace(key, @"\s+", "-", RegexOptions.CultureInvariant);
            return Regex.Replace(key, @"^(claude-(?:opus|sonnet)-)([0-9]+)\.([0-9]+)", "$1$2-$3", RegexOptions.CultureInvariant);
        }

        internal static string? CatalogKey(string? model)
        {
            string key = NormalizeModelKey(model);
            if (Defaults.ContainsKey(key)) return key;
            if (Aliases.TryGetValue(key, out var alias)) return alias;
            if (ObservedVariants.TryGetValue(key, out var observed)) return observed;
            foreach (string canonical in Defaults.Keys)
            {
                if (key.StartsWith(canonical + "-", StringComparison.OrdinalIgnoreCase) && VariantSuffix.IsMatch(key[(canonical.Length + 1)..]))
                    return canonical;
            }
            foreach (var item in Aliases)
            {
                if (key.StartsWith(item.Key + "-", StringComparison.OrdinalIgnoreCase) && VariantSuffix.IsMatch(key[(item.Key.Length + 1)..]))
                    return item.Value;
            }
            return null;
        }

        public static bool TryResolve(IReadOnlyDictionary<string, ModelPrice> prices, string? model,
            [NotNullWhen(true)] out ModelPrice? price, out string basis, DateTimeOffset? at = null)
        {
            // User-specified exact keys always win, including distinct thinking/variant rates.
            if (model != null && prices.TryGetValue(model, out price)) { price = AtDate(price, at); basis = "exact"; return true; }
            string key = NormalizeModelKey(model);
            if (prices.TryGetValue(key, out price)) { price = AtDate(price, at); basis = "alias"; return true; }
            if (Historical.TryGetValue(key, out price)) { basis = "historical"; return true; }
            string? canonical = CatalogKey(key);
            if (canonical != null && prices.TryGetValue(canonical, out price))
            {
                price = AtDate(price, at);
                basis = Aliases.ContainsKey(key) ? "alias" : "base-variant";
                return true;
            }
            foreach (var historic in Historical) {
                string historicKey = Aliases.TryGetValue(key, out var oldAlias) ? oldAlias : key;
                if (historicKey == historic.Key || (historicKey.StartsWith(historic.Key + "-", StringComparison.OrdinalIgnoreCase) && VariantSuffix.IsMatch(historicKey[(historic.Key.Length + 1)..]))) {
                    price = historic.Value; basis = "historical"; return true;
                }
            }
            price = null; basis = "unknown"; return false;
        }

        public static Dictionary<string, ModelPrice> ReadSnapshot()
        {
            var prices = new Dictionary<string, ModelPrice>(Defaults, StringComparer.OrdinalIgnoreCase);
            prices["gemini-4-argon"] = ArgonAt(DateTimeOffset.UtcNow);
            string path = Path.Combine(HubStorage.HubDir, "model_pricing.json");
            if (!File.Exists(path)) return prices;
            var configured = JsonSerializer.Deserialize<Dictionary<string, ModelPrice>>(File.ReadAllText(path),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new InvalidDataException("模型参考费率配置为空。");
            foreach (var item in configured)
            {
                var price = item.Value;
                if (string.IsNullOrWhiteSpace(item.Key) || price == null || !double.IsFinite(price.Input) || !double.IsFinite(price.CacheRead) || !double.IsFinite(price.Output) ||
                    !double.IsFinite(price.CacheWrite) || price.Input < 0 || price.CacheRead < 0 || price.Output < 0 || (price.CacheWrite < 0 && price.CacheWrite != -1))
                    throw new InvalidDataException("模型参考费率包含无效数值。");
                prices[item.Key] = price;
            }
            return prices;
        }
    }
}
