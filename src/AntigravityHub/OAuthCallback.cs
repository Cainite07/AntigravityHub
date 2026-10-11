using System;
using System.Collections.Generic;

namespace AntigravityHub
{
    internal sealed class OAuthRejectedException : ArgumentException
    {
        public OAuthRejectedException() : base("Google 未完成授权，请重试。") { }
    }
    internal static class OAuthCallback
    {
        public static string Parse(string input, string redirect, string state)
        {
            if (string.IsNullOrWhiteSpace(input) || input.Length > 8192) throw new ArgumentException("授权码或回调链接无效。");
            input = input.Trim();
            if (!input.Contains("://", StringComparison.Ordinal))
            {
                if (input.Contains('=') || input.Contains('&') || input.Contains('?') || input.IndexOfAny(new[] { ' ', '\r', '\n', '\t' }) >= 0)
                    throw new ArgumentException("请粘贴完整回调链接或纯授权码。");
                return input;
            }
            if (!Uri.TryCreate(input, UriKind.Absolute, out var uri) ||
                !Uri.TryCreate(redirect, UriKind.Absolute, out var expected) ||
                uri.Scheme != expected.Scheme || uri.Host != expected.Host || uri.Port != expected.Port ||
                uri.AbsolutePath.TrimEnd('/') != expected.AbsolutePath.TrimEnd('/') || uri.UserInfo != "" || uri.Fragment != "")
                throw new ArgumentException("回调地址不属于本次授权，请重新开始授权。");
            var query = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = pair.Split('=', 2);
                string key = Uri.UnescapeDataString(parts[0].Replace('+', ' '));
                string value = parts.Length == 2 ? Uri.UnescapeDataString(parts[1].Replace('+', ' ')) : "";
                if (!query.TryAdd(key, value)) throw new ArgumentException("回调链接含有重复参数。");
            }
            if (!query.TryGetValue("state", out var receivedState) || receivedState != state)
                throw new ArgumentException("授权校验不匹配，请使用本次授权的回调链接。");
            if (query.ContainsKey("error")) throw new OAuthRejectedException();
            if (!query.TryGetValue("code", out var code) || string.IsNullOrWhiteSpace(code))
                throw new ArgumentException("回调链接缺少授权码。");
            return code;
        }
    }
}
