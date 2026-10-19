'use strict';
const net=require('node:net'),os=require('node:os'),crypto=require('node:crypto');
const pipeName='AntigravityHub.Hud.'+crypto.createHash('sha256').update(os.homedir().toUpperCase(),'utf8').digest('hex').slice(0,16);
function request(message,timeout=2200){return new Promise((resolve,reject)=>{
  const socket=net.createConnection('\\\\.\\pipe\\'+pipeName);let data='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(value);};
  socket.setEncoding('utf8');
  socket.setTimeout(timeout,()=>finish(Error('timeout')));
  socket.on('error',e=>finish(e));socket.on('end',()=>finish(Error('closed')));
  socket.on('connect',()=>socket.write(JSON.stringify(message)+'\n'));
  socket.on('data',chunk=>{data+=chunk;if(data.length>1800000)return finish(Error('oversize'));const i=data.indexOf('\n');if(i>=0){try{finish(null,JSON.parse(data.slice(0,i)));}catch(e){finish(e);}}});
});}
function trusted(event,BrowserWindow){try{const u=new URL(event.senderFrame.url);return event.senderFrame===event.sender.mainFrame && !!BrowserWindow.fromWebContents(event.sender) && u.protocol==='https:' && u.hostname==='127.0.0.1' && !u.username && !u.password;}catch{return false;}}
function install({ipcMain,BrowserWindow}){
  const collector=createSpeedCollector(),quotaCollector=createQuotaCollector();
  let currentAccount=null;
  ipcMain.handle('hub-hud:speed',async(event,id)=>{
    if(!trusted(event,BrowserWindow)||cached?.enabled===false||!GUID.test(id||''))return null;
    const route=new URL(event.senderFrame.url).pathname.match(/^\/c\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]?.toLowerCase();
    if(route!==id.toLowerCase())return null;
    const account=currentAccount;
    const value=await collector.read(id.toLowerCase(),account);
    return account===currentAccount?value:null;
  });
  const snapshots=new Map();let flight=null,cached=null,at=0;
  ipcMain.handle('hub-hud:snapshot',async event=>{
    if(!trusted(event,BrowserWindow))return {available:false};
    const now=Date.now(),last=snapshots.get(event.sender.id)||0;if(now-last<500)return cached||{available:false};snapshots.set(event.sender.id,now);
    if(cached?.available&&now-at<1000)return cached;
    if(!flight)flight=request({action:'snapshot'}).then(async v=>{const account=v?.accounts?.find(a=>a.isCurrent)?.id||null;if(account!==currentAccount){currentAccount=account;collector.clear();quotaCollector.clear();}if(v?.available&&v.enabled!==false&&account){const quota=await quotaCollector.read(account);if(quota)v={...v,accounts:v.accounts.map(a=>a.isCurrent?{...a,...quota}:a)};}cached=v;at=Date.now();return v;}).catch(()=>{cached=null;return {available:false};}).finally(()=>flight=null);
    return flight;
  });
  ipcMain.handle('hub-hud:open',async event=>{if(!trusted(event,BrowserWindow))return false;try{await request({action:'open'});return true;}catch{return false;}});
  let switching=false;
  ipcMain.handle('hub-hud:switch',async(event,id)=>{
    if(!trusted(event,BrowserWindow)||switching||typeof id!=='string'||id.length>128||cached?.enabled===false||!cached?.accounts?.some(a=>a.id===id))return false;
    switching=true;try{const result=await request({action:'switch',accountId:id},90000);at=0;if(result.ok===true)collector.clear();return result.ok===true;}catch{return false;}finally{switching=false;}
  });
}


// TPS transforms adapted from Antigrative Dashboard (MIT), Copyright (c) 2026
// YOU-SHOULD-KNOW-ME. See THIRD-PARTY-NOTICES.md and the included MIT license.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function seconds(v){
  if(typeof v==='number')return Number.isFinite(v)&&v>=0?v:null;
  if(typeof v==='string'&&/^\d+(?:\.\d+)?s$/.test(v))return Number(v.slice(0,-1));
  if(v&&typeof v==='object'){
    const a=Number(v.seconds??0),b=Number(v.nanos??0);
    return Number.isSafeInteger(a)&&a>=0&&Number.isInteger(b)&&b>=0&&b<1e9?a+b/1e9:null;
  }return null;
}
function tokens(v){if(v===undefined||v===null||v===''||typeof v==='boolean')return null;const n=Number(v);return Number.isSafeInteger(n)&&n>=0?n:null;}
function sessionSpeed(response,id){
  const trajectory=response?.trajectory;if(!trajectory||!Array.isArray(trajectory.generatorMetadata))return null;
  if(trajectory.cascadeId&&trajectory.cascadeId.toLowerCase()!==id)return null;
  const rows=trajectory.generatorMetadata,total=Number(response.numTotalGeneratorMetadata??rows.length);
  if(!Number.isSafeInteger(total)||total!==rows.length)return null;
  const seen=new Set();let count=0,duration=0,samples=0,allOutput=false;
  for(const [index,g]of rows.entries()){
    const chat=g?.chatModel,u=chat?.usage;if(!u)continue;
    const key=u.messageId||g.executionId||`index:${index}`;if(seen.has(key))continue;seen.add(key);
    const output=tokens(u.outputTokens),visible=tokens(u.responseOutputTokens),thinking=tokens(u.thinkingOutputTokens);
    // Pair visible response tokens with the actual streaming span. TTFT and
    // tool time never enter this average. Records lacking timing are omitted.
    if(u.responseOutputTokens!==undefined&&visible===null||u.thinkingOutputTokens!==undefined&&thinking===null)continue;
    if(output!==null&&(thinking!==null&&thinking>output||visible!==null&&visible>output))continue;
    const n=visible??(output!==null&&thinking!==null?output-thinking:output),d=seconds(chat.streamingDuration);
    if(n===null||n<=0||d===null||d<=0)continue;
    count+=n;duration+=d;samples++;if(visible===null&&thinking===null)allOutput=true;
  }
  return duration>0&&Number.isSafeInteger(count)?{conversationId:id,tps:count/duration,basis:allOutput?'all-output':'response',samples}:null;
}
function nativeServer(){
  // Use the backend owned by this Antigravity process. No cross-instance
  // discovery, log scraping, global credentials or renderer-visible token.
  const ls=require('./languageServer'),child=ls.getLsProcess(),port=ls.getLsPort();
  if(!child||child.exitCode!==null||!Number.isInteger(port)||port<1||port>65535)throw Error('Backend unavailable');
  const args=child.spawnargs||[],at=args.indexOf('--csrf_token'),csrf=at>=0?args[at+1]:args.find(x=>x.startsWith('--csrf_token='))?.slice(13);
  if(typeof csrf!=='string'||csrf.length>256||!csrf)throw Error('Backend credential unavailable');
  return {port,csrf,pid:child.pid};
}
function localCall(server,method,body){return new Promise((resolve,reject)=>{
  // The native frontend uses HTTPS with a self-signed loopback certificate.
  // Host/port/path are fixed here; caller input can never select an endpoint.
  const payload=JSON.stringify(body),req=require('node:https').request({hostname:'127.0.0.1',port:server.port,rejectUnauthorized:false,
    method:'POST',path:'/exa.language_server_pb.LanguageServerService/'+method,
    headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1','x-codeium-csrf-token':server.csrf,'Content-Length':Buffer.byteLength(payload)}},res=>{
    let chunks=[],size=0;res.on('data',b=>{size+=b.length;if(size>32*1024*1024){req.destroy(Error('Metadata too large'));return;}chunks.push(b);});
    res.on('error',reject);res.on('end',()=>{if(res.statusCode!==200)return reject(Error('Metadata unavailable'));try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{reject(Error('Invalid metadata'));}});
  });req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('Metadata timeout')));req.end(payload);
});}
// Read the native client's own quota service, which includes newly rolled-out pools.
// Only allowlisted quota counters leave the main process; no credentials or RPC body.
function argonQuota(response){
  const groups=response?.response?.groups||response?.groups;
  if(!Array.isArray(groups))return null;
  const value={argon5hQuota:-1,argonWeeklyQuota:-1,argonResetTime5h:'',argonResetTimeWeekly:''};let found=false;
  for(const group of groups){if(!/argon/i.test(group.displayName||''))continue;
    for(const b of group.buckets||[]){const fraction=b.remainingFraction??(b.remaining?.case==='remainingFraction'?b.remaining.value:null);
      if(typeof fraction!=='number'||!Number.isFinite(fraction)||fraction<0||fraction>1)continue;
      const key=b.window==='5h'?'5h':b.window==='weekly'?'Weekly':null;if(!key)continue;
      value['argon'+key+'Quota']=Math.round(fraction*100);value['argonResetTime'+key]=typeof b.resetTime==='string'?b.resetTime:'';found=true;
    }
  }return found?value:null;
}
function createQuotaCollector({server=nativeServer,call=localCall,now=()=>Date.now()}={}){
  let entry=null,epoch=0;
  return {clear(){entry=null;epoch++;},async read(account){
    let backend;try{backend=server();}catch{return null;}
    const key=`${backend.pid}:${backend.port}:${account}`,generation=epoch;
    if(entry?.key===key&&(entry.flight||now()-entry.at<30000))return entry.flight||entry.value;
    const current={key,at:now(),value:null};entry=current;
    current.flight=(async()=>{try{const result=await call(backend,'RetrieveUserQuotaSummary',{forceRefresh:false});const check=server();
      if(epoch!==generation||check.pid!==backend.pid||check.port!==backend.port||check.csrf!==backend.csrf)return null;
      return argonQuota(result);
    }catch{return null;}})().then(value=>{current.value=value;current.at=now();current.flight=null;return value;});return current.flight;
  }};
}
function createSpeedCollector({server=nativeServer,call=localCall,now=()=>Date.now()}={}){
  const cache=new Map();let epoch=0;
  function clear(){epoch++;cache.clear();}
  async function read(id,account){
    if(!GUID.test(id)||!account)return null;
    let backend;try{backend=server();}catch{return null;}
    const key=`${backend.pid}:${backend.port}:${account}:${id}`,existing=cache.get(key);
    if(existing?.flight)return existing.flight;
    if(existing&&now()-existing.at<2200)return existing.value;
    const generation=epoch,entry={at:now(),value:null};
    entry.flight=(async()=>{try{
      // Response bodies are used transiently in memory; only generator counters
      // and timings are retained for the transform. Nothing is saved or sent out.
      const first=await call(backend,'GetCascadeTrajectory',{cascadeId:id,trajectoryVerbosity:3});
      if(!first?.trajectory)return null;
      const rows=first.trajectory.generatorMetadata||[];
      const total=Number(first.numTotalGeneratorMetadata??rows.length);
      if(!Number.isSafeInteger(total)||total<rows.length||total>100000)return null;
      let pages=0;
      while(rows.length<total){
        if(++pages>128||now()-entry.at>10000||generation!==epoch)return null;
        const page=await call(backend,'GetCascadeTrajectoryGeneratorMetadata',{cascadeId:id,generatorMetadataOffset:rows.length});
        const items=page?.generatorMetadata||page?.generatorMetadatas;
        if(!Array.isArray(items)||items.length===0||rows.length+items.length>total)return null;rows.push(...items);
      }
      first.trajectory.generatorMetadata=rows;
      const current=server();if(current.pid!==backend.pid||current.port!==backend.port||current.csrf!==backend.csrf||generation!==epoch)return null;
      return sessionSpeed(first,id);
    }catch{return null;}})().then(v=>{entry.value=v;entry.at=now();entry.flight=null;return v;});
    if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(key,entry);return entry.flight;
  }
  return {read,clear};
}
module.exports={install,request,trusted,pipeName,seconds,tokens,sessionSpeed,createSpeedCollector,argonQuota,createQuotaCollector};
