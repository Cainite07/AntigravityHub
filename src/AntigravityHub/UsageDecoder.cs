using System;
using System.Collections.Generic;
using System.IO;

namespace AntigravityHub
{
    public class ServerUsage
    {
        public string Model { get; set; } = "unknown";
        public int? LastStepIndex { get; set; }
        public long InputTokens { get; set; }
        public long CacheReadTokens { get; set; }
        public long CacheWriteTokens { get; set; }
        public long OutputTokens { get; set; }
        public long ThinkingOutputTokens { get; set; }
        public long ResponseOutputTokens { get; set; }
        public long TotalTokens => InputTokens + CacheReadTokens + CacheWriteTokens + OutputTokens;
    }
    internal static class UsageDecoder
    {
        private readonly struct ProtoFieldSlice
        {
            public int Num { get; }
            public int WireType { get; }
            public long VarintVal { get; }
            public int Offset { get; }
            public int Length { get; }

            public ProtoFieldSlice(int num, int wireType, long varintVal, int offset, int length)
            {
                Num = num;
                WireType = wireType;
                VarintVal = varintVal;
                Offset = offset;
                Length = length;
            }
        }
        public static ServerUsage? Decode(byte[] buf)
        {
            try { return DecodeServerUsage(buf); }
            catch (InvalidDataException) { return null; }
            catch (OverflowException) { return null; }
            catch (System.Text.DecoderFallbackException) { return null; }
        }

        private static ServerUsage? DecodeServerUsage(byte[] buf)
        {
            var root = FindProtoFields(buf, 0, buf.Length);
            var f1 = root.Find(f => f.Num == 1);
            if (f1.Length == 0) return null;

            var inner = FindProtoFields(buf, f1.Offset, f1.Length);
            string model = "unknown";
            var f19 = inner.Find(f => f.Num == 19);
            if (f19.Length > 0)
            {
                model = NormalizeModelName(new System.Text.UTF8Encoding(false, true).GetString(buf, f19.Offset, f19.Length).Trim());
            }

            int? lastStep = null;
            foreach (var item in inner)
            {
                if (item.Num == 20 && item.Length > 0)
                {
                    var kvs = FindProtoFields(buf, item.Offset, item.Length);
                    var k = kvs.Find(x => x.Num == 1);
                    var v = kvs.Find(x => x.Num == 2);
                    if (k.Length > 0 && v.Length > 0 && System.Text.Encoding.UTF8.GetString(buf, k.Offset, k.Length) == "last_step_index")
                    {
                        if (int.TryParse(System.Text.Encoding.UTF8.GetString(buf, v.Offset, v.Length), out int parsed))
                        {
                            lastStep = parsed;
                        }
                    }
                }
            }

            var f4 = inner.Find(f => f.Num == 4);
            if (f4.Length == 0) return null;

            var f4Fields = FindProtoFields(buf, f4.Offset, f4.Length);
            long input = 0, output = 0, cacheWrite = 0, cacheRead = 0, thinking = 0, response = 0;
            foreach (var f in f4Fields)
            {
                if ((f.Num is 2 or 3 or 4 or 5 or 9 or 10) && f.WireType != 0)
                    throw new InvalidDataException("Invalid usage counter wire type");
                if (f.Num == 2) input = f.VarintVal;
                else if (f.Num == 3) output = f.VarintVal;
                else if (f.Num == 4) cacheWrite = f.VarintVal;
                else if (f.Num == 5) cacheRead = f.VarintVal;
                else if (f.Num == 9) thinking = f.VarintVal;
                else if (f.Num == 10) response = f.VarintVal;
            }

            if (input < 0 || output < 0 || cacheWrite < 0 || cacheRead < 0 || thinking < 0 || response < 0) return null;
            if (output == 0) output = checked(thinking + response);
            if (thinking > output || response > output || checked(thinking + response) > output) return null;
            // Output is authoritative; preserve any unclassified remainder as response output.
            response = output - thinking;
            long total = checked(input + output + cacheWrite + cacheRead);
            if (total <= 0) return null;

            if (thinking == 0 && response == 0 && output > 0)
            {
                response = output;
            }

            return new ServerUsage
            {
                Model = model,
                LastStepIndex = lastStep,
                InputTokens = input,
                OutputTokens = output,
                CacheWriteTokens = cacheWrite,
                CacheReadTokens = cacheRead,
                ThinkingOutputTokens = thinking,
                ResponseOutputTokens = response
            };
        }

        private static (long val, int nextOffset) DecodeVarint(byte[] buf, int offset, int endOffset)
        {
            ulong value = 0;
            for (int index = 0; index < 10 && offset < endOffset; index++)
            {
                byte b = buf[offset++];
                if (index == 9 && b > 1) throw new InvalidDataException("Varint overflow");
                value |= (ulong)(b & 127) << (index * 7);
                if ((b & 128) == 0) return (unchecked((long)value), offset);
            }
            throw new InvalidDataException("Truncated varint");
        }

        private static List<ProtoFieldSlice> FindProtoFields(byte[] buf, int startOffset, int length)
        {
            if (startOffset < 0 || length < 0 || startOffset > buf.Length - length)
                throw new InvalidDataException("Invalid protobuf slice");
            var fields = new List<ProtoFieldSlice>();
            int offset = startOffset, endOffset = startOffset + length;
            while (offset < endOffset)
            {
                var (tag, next) = DecodeVarint(buf, offset, endOffset);
                offset = next;
                if (tag <= 0 || (tag >> 3) > 536870911) throw new InvalidDataException("Invalid protobuf tag");
                int fieldNum = (int)(tag >> 3), wireType = (int)(tag & 7);
                if (wireType == 0)
                {
                    var (value, valueEnd) = DecodeVarint(buf, offset, endOffset);
                    offset = valueEnd; fields.Add(new ProtoFieldSlice(fieldNum, wireType, value, offset, 0));
                }
                else if (wireType == 2)
                {
                    var (count, countEnd) = DecodeVarint(buf, offset, endOffset);
                    offset = countEnd;
                    if (count < 0 || count > endOffset - offset) throw new InvalidDataException("Truncated protobuf field");
                    fields.Add(new ProtoFieldSlice(fieldNum, wireType, 0, offset, (int)count));
                    offset += (int)count;
                }
                else if (wireType == 1 || wireType == 5)
                {
                    int count = wireType == 1 ? 8 : 4;
                    if (count > endOffset - offset) throw new InvalidDataException("Truncated fixed field");
                    offset += count;
                }
                else throw new InvalidDataException("Unsupported protobuf wire type");
            }
            return fields;
        }


        private static string NormalizeModelName(string model)
        {
            string value = model.Trim();
            return value.ToLowerInvariant() switch
            {
                "claude opus 4.6" => "claude-opus-4-6-thinking",
                "claude-opus-4-6" => "claude-opus-4-6-thinking",
                "claude sonnet 4.6" => "claude-sonnet-4-6",
                "claude 3.7 sonnet" => "claude-3.7-sonnet",
                "gemini 3.8 flash" => "gemini-3.8-flash",
                "gemini 3.7 flash" => "gemini-3.7-flash",
                "gemini 3.1 pro" => "gemini-3.1-pro",
                "gemini 2.0 flash" => "gemini-2.0-flash",
                _ => value
            };
        }
        public static bool TryReadTimestamp(byte[] data, out DateTime timestamp)
        {
            timestamp = default;
            try
            {
                var field = FindProtoFields(data, 0, data.Length).Find(f => f.Num == 1 && f.WireType == 2);
                if (field.Length == 0) return false;
                var seconds = FindProtoFields(data, field.Offset, field.Length).Find(f => f.Num == 1 && f.WireType == 0);
                if (seconds.Num != 1) return false;
                timestamp = DateTimeOffset.FromUnixTimeSeconds(seconds.VarintVal).UtcDateTime;
                return true;
            }
            catch (InvalidDataException) { return false; }
            catch (ArgumentOutOfRangeException) { return false; }
        }
    }
}
