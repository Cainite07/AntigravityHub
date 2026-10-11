using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AntigravityHub
{
    public static class CredentialManager
    {
        private const int CRED_TYPE_GENERIC = 1;
        private const int CRED_PERSIST_LOCAL_MACHINE = 2;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            public string TargetName;
            public string? Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public string? TargetAlias;
            public string? UserName;
        }

        [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

        [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite([In] ref CREDENTIAL userCredential, uint flags);

        [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
        private static extern void CredFree([In] IntPtr cred);

        [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        public static bool DeleteCredential(string target) =>
            CredDelete(target, CRED_TYPE_GENERIC, 0) || Marshal.GetLastWin32Error() == 1168;

        public static string? ReadCredential(string target)
        {
            if (CredRead(target, CRED_TYPE_GENERIC, 0, out IntPtr credPtr))
            {
                try
                {
                    CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
                    if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero)
                    {
                        byte[] blob = new byte[cred.CredentialBlobSize];
                        Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
                        return Encoding.UTF8.GetString(blob);
                    }
                }
                finally
                {
                    CredFree(credPtr);
                }
            }
            return null;
        }

        public static bool WriteCredential(string target, string userName, string secretJson)
        {
            byte[] blob = Encoding.UTF8.GetBytes(secretJson);
            IntPtr pBlob = Marshal.AllocHGlobal(blob.Length);
            try
            {
                Marshal.Copy(blob, 0, pBlob, blob.Length);
                CREDENTIAL cred = new CREDENTIAL
                {
                    Flags = 0,
                    Type = CRED_TYPE_GENERIC,
                    TargetName = target,
                    Comment = null,
                    CredentialBlobSize = (uint)blob.Length,
                    CredentialBlob = pBlob,
                    Persist = CRED_PERSIST_LOCAL_MACHINE,
                    AttributeCount = 0,
                    Attributes = IntPtr.Zero,
                    TargetAlias = null,
                    UserName = userName
                };

                return CredWrite(ref cred, 0);
            }
            finally
            {
                Marshal.FreeHGlobal(pBlob);
            }
        }
    }
}
