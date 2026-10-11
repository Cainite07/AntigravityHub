using System.Text.Json;

namespace AntigravityHub
{
    internal static class JsonOpts
    {
        public static readonly JsonSerializerOptions CamelCase = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        };

        public static readonly JsonSerializerOptions Indented = new()
        {
            WriteIndented = true
        };

        public static readonly JsonSerializerOptions CamelCaseIndented = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        };
    }
}
