'use strict';
// Runs with the client, never at Windows logon. Uses its existing loopback debugger.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {buildPortableUiSource}=require('./portable-ui.cjs');
const home=path.join(os.homedir(),'.antigravity_hub');
const profile=path.join(process.env.APPDATA,'Antigravity');
const settingsFile=path.join(home,'app_settings.json');
const portFile=path.join(profile,'DevToolsActivePort');
let enabledSource;
const disabledSource=buildPortableUiSource(false);
const expression=enabled=>enabled?(enabledSource??=buildPortableUiSource(true)):disabledSource;
const waitForUpdate=process.argv.includes('--after-update'), started=Date.now();
const sessions=new Map();let activePort=null,lastLive=Date.now(),fullAdapter=false,stopping=false;
function settings(){try{return JSON.parse(fs.readFileSync(settingsFile,'utf8').replace(/^\uFEFF/,''));}catch{return {EnableClientLocalization:false};}}
function localPage(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='127.0.0.1'&&!!u.port&&!u.username&&!u.password;}catch{return false;}}
function connect(url){
  const socket=new WebSocket(url),pending=new Map();let sequence=0;
  socket.addEventListener('message',event=>{
    const value=JSON.parse(event.data);const request=pending.get(value.id);if(!request)return;
    pending.delete(value.id);clearTimeout(request.timer);
    if(value.error)request.reject(Error(value.error.message));
    else if(value.result?.exceptionDetails)request.reject(Error('UI initialization failed: '+value.result.exceptionDetails.text));
    else request.resolve(value.result);
  });
  socket.addEventListener('close',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Client closed'));}pending.clear();});
  const ready=new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  async function call(method,params={}){await ready;return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Local debugger timed out'));},5000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });}
  return {socket,call};
}
async function attach(target,port){
  const client=connect(target.webSocketDebuggerUrl);sessions.set(target.id,client);
  try {
    const identity=await client.call('Runtime.evaluate',{expression:'Boolean(window.nativeStorage && window.electronUpdater && window.agent)',returnByValue:true});
    if(identity.result?.value!==true){client.socket.close();sessions.delete(target.id);return;}
    const status=await client.call('Runtime.evaluate',{expression:'window.antigravityHansStatus ? window.antigravityHansStatus.bundle() : null',awaitPromise:true,returnByValue:true});
    const native=status.result?.value;
    if(native?.uiSourceCount>0 && !native.reason){fullAdapter=true;client.socket.close();sessions.delete(target.id);return;}
    await client.call('Page.enable');await client.call('Runtime.enable');
    const enabled=settings().EnableClientLocalization===true;
    const script=await client.call('Page.addScriptToEvaluateOnNewDocument',{source:expression(enabled),worldName:'AntigravityHub fixed UI'});
    const tree=await client.call('Page.getFrameTree');
    const world=await client.call('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'AntigravityHub fixed UI'});
    Object.assign(client,{script:script.identifier,world:world.executionContextId,enabled,port});
    client.socket.addEventListener('message',async event=>{
      const message=JSON.parse(event.data),frame=message.params?.frame;
      if(message.method!=='Page.frameNavigated'||frame?.parentId||!localPage(frame?.url))return;
      try {
        const next=await client.call('Page.createIsolatedWorld',{frameId:frame.id,worldName:'AntigravityHub fixed UI'});
        client.world=next.executionContextId;
        await client.call('Runtime.evaluate',{expression:expression(client.enabled),contextId:client.world,returnByValue:true});
      }catch{}
    });
    await client.call('Runtime.evaluate',{expression:expression(enabled),contextId:world.executionContextId,returnByValue:true});
  }catch{client.socket.close();sessions.delete(target.id);}
}
async function tick(){
  try {
    const stat=fs.statSync(portFile);
    if(waitForUpdate && activePort===null && stat.mtimeMs<started)return;
    const port=Number(fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0]);
    if(!Number.isInteger(port)||port<1||port>65535)return;
    const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1800)});
    const targets=await response.json();if(!Array.isArray(targets))return;
    lastLive=Date.now();activePort=port;
    const pages=targets.filter(t=>t.type==='page'&&localPage(t.url)&&t.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'+port+'/'));
    for(const [id,session]of sessions)if(!pages.some(t=>t.id===id)||session.socket.readyState>1){session.socket.close();sessions.delete(id);}
    for(const page of pages)if(!sessions.has(page.id))await attach(page,port);
    // Preload settings arrive asynchronously. Recheck after attachment so a
    // normal fully adapted startup never retains the temporary fallback.
    for(const session of sessions.values())if(session.world){
      const status=await session.call('Runtime.evaluate',{expression:'window.antigravityHansStatus ? window.antigravityHansStatus.bundle() : null',awaitPromise:true,returnByValue:true});
      if(status.result?.value?.uiSourceCount>0 && !status.result.value.reason){
        await session.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.script});
        await session.call('Runtime.evaluate',{expression:expression(false),contextId:session.world,returnByValue:true});
        fullAdapter=true;
      }
    }
    const enabled=settings().EnableClientLocalization===true;
    for(const session of sessions.values())if(session.world && session.enabled!==enabled){
      await session.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.script});
      session.script=(await session.call('Page.addScriptToEvaluateOnNewDocument',{source:expression(enabled),worldName:'AntigravityHub fixed UI'})).identifier;
      await session.call('Runtime.evaluate',{expression:expression(enabled),contextId:session.world,returnByValue:true});session.enabled=enabled;
    }
  }catch{}
}
async function main(){
  if(settings().EnableClientLocalization!==true)return;
  // Per-user single instance without a stale lock file or process termination.
  const identity=require('node:crypto').createHash('sha256').update(os.homedir()).digest('hex').slice(0,20);
  const lock=net.createServer();await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen('\\\\.\\pipe\\AntigravityHub.UiGuard.'+identity,resolve);});
  try {
    while(!stopping){
      await tick();
      if(fullAdapter || Date.now()-lastLive>(waitForUpdate?45000:20000))break;
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
  }finally{for(const session of sessions.values())session.socket.close();lock.close();}
}
if(require.main===module)main().catch(error=>{if(error.code!=='EADDRINUSE')process.exitCode=1;});
module.exports={localPage};
