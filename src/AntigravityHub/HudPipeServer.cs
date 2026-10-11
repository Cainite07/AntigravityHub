using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Security.Cryptography;
namespace AntigravityHub;
internal sealed class HudPipeServer
{
    public static string PipeName => "AntigravityHub.Hud." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).ToUpperInvariant())))[..16].ToLowerInvariant();
    private string _snapshot = "{\"available\":false}";
    public void Publish(object snapshot) => Volatile.Write(ref _snapshot, JsonSerializer.Serialize(snapshot,JsonOpts.CamelCase));
    public void Start(Func<string,string,Task<bool>> command, CancellationToken stop)
    {
        for(int i=0;i<4;i++) _ = Task.Run(async () =>
        {
            while(!stop.IsCancellationRequested)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream(PipeName,PipeDirection.InOut,4,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
                    await pipe.WaitForConnectionAsync(stop);
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop); timeout.CancelAfter(TimeSpan.FromSeconds(90));
                    var bytes = new byte[8192]; int length=0;
                    while(length<bytes.Length) { int n=await pipe.ReadAsync(bytes.AsMemory(length,1),timeout.Token); if(n==0)break; if(bytes[length++]==10)break; }
                    if(length==bytes.Length || length==0)continue;
                    using var doc=JsonDocument.Parse(bytes.AsMemory(0,length));
                    string action=doc.RootElement.GetProperty("action").GetString()??"";
                    string result;
                    if(action=="snapshot") result=Volatile.Read(ref _snapshot);
                    else if(action=="open" || action=="switch") { string id=doc.RootElement.TryGetProperty("accountId",out var a)?a.GetString()??"":""; if(id.Length>128)continue; bool ok = await command(action,id).WaitAsync(timeout.Token); result=JsonSerializer.Serialize(new {ok}); }
                    else continue;
                    await pipe.WriteAsync(Encoding.UTF8.GetBytes(result+"\n"),timeout.Token);
                }
                catch(OperationCanceledException) { }
                catch(Exception ex) { Logger.Log("HUD",ex.GetType().Name); }
            }
        },stop);
    }
}
