using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace AntigravityHub
{
    // One writer's temporary file must never be reused by another writer.
    internal static class AtomicFile
    {
        public static void WriteBytes(string path, byte[] bytes)
        {
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes);
                    stream.Flush(flushToDisk: true);
                }
                File.Move(temporary, path, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        public static Task WriteTextAsync(string path, string text) =>
            Task.Run(() => WriteBytes(path, new UTF8Encoding(false).GetBytes(text)));
    }
}
