'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../client/maintenance/tools/hud/hud-preload.js'),'utf8');
assert.equal(source,fs.readFileSync(require('node:path').join(__dirname,'../src/AntigravityHub/integration/hud-preload.js'),'utf8'),'Shipped and development HUDs must match');
function windowHarness(model){
  const trigger={textContent:model};
  const document={readyState:'loading',createElement:()=>({getContext:()=>({})}),addEventListener(){},querySelector:()=>trigger};
  const context={document,location:{pathname:'/'},MutationObserver:class{},matchMedia:()=>({}),require:()=>({ipcRenderer:{}}),setTimeout,clearTimeout,Date,Number,Map,Promise};
  context.window=context;context.top=context;
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,'globalThis.hud={currentPool,pools,quotaColor,compactPool};})();'),context);
  return {api:context.hud,trigger};
}
const account={gemini5hQuota:75,geminiWeeklyQuota:83,argonWeeklyQuota:96,claude5hQuota:12,claudeWeeklyQuota:40};
const first=windowHarness('Gemini 4 Argon 中'),second=windowHarness('Claude Sonnet 5.5 高');
assert.equal(first.api.currentPool(account).value,96);
assert.equal(first.api.currentPool(account).window,'每周');
assert.equal(second.api.currentPool(account).value,12);
first.trigger.textContent='Gemini 3.8 Flash 高';
assert.equal(first.api.currentPool(account).value,75,'Model changes must immediately select the matching pool');
assert.equal(second.api.currentPool(account).value,12,'Other windows retain their own model selection');
first.trigger.textContent='Unknown model';assert.equal(first.api.currentPool(account).value,null,'Unknown models never inherit a guessed quota');
first.trigger.textContent='Gemini 4 Argon 中';
assert.equal(first.api.currentPool({...account,argonWeeklyQuota:0}).value,0);
assert.equal(first.api.currentPool({...account,argonWeeklyQuota:-1}).value,null);
assert.equal(first.api.currentPool({...account,argon5hQuota:22}).value,22,'Only use a 5h Argon limit when actually supplied');
const pool=first.api.pools(account).find(p=>p.id==='argon');
assert(first.api.compactPool(pool).includes('compact-wide'));
const hues=[0,10,20,50,75,100].map(q=>Number(first.api.quotaColor(q).match(/hsl\(([\d.]+)/)[1]));
assert(hues.every((h,i)=>i===0||h>hues[i-1]),'Quota colors smoothly progress from red through yellow to green');
assert.equal(first.api.quotaColor(-1),'var(--muted)');
new vm.Script(source);
console.log('PASS: current-window model following, independent windows, Argon weekly/5h/zero/unknown data, compact rows, gradual red-yellow-green colors, matching shipped HUD.');

const {argonQuota,createQuotaCollector}=require('../src/AntigravityHub/integration/hub-hud-main.js');
(async()=>{
 const native={groups:[{displayName:'Gemini Models',buckets:[{window:'weekly',remainingFraction:.83}]},{displayName:'Gemini 4 Argon',buckets:[{window:'weekly',remainingFraction:.96,resetTime:'2026-10-25T00:00:00Z'}]}]};
 assert.equal(argonQuota(native).argonWeeklyQuota,96);assert.equal(argonQuota(native).argon5hQuota,-1);
 assert.equal(argonQuota({groups:[{displayName:'Argon',buckets:[{window:'weekly',remainingFraction:0}]}]}).argonWeeklyQuota,0);
 assert.equal(argonQuota({groups:[{displayName:'Gemini',buckets:[]}]}),null);
 assert.equal(argonQuota({groups:[{displayName:'Argon',buckets:[{window:'weekly',remainingFraction:2}]}]}),null);
 let calls=0,now=0,backend={pid:1,port:1234,csrf:'fixture'},resolve;
 const c=createQuotaCollector({server:()=>backend,now:()=>now,call:async(s,m,b)=>{calls++;assert.equal(m,'RetrieveUserQuotaSummary');assert.equal(b.forceRefresh,false);return native;}});
 assert.equal((await c.read('a')).argonWeeklyQuota,96);await c.read('a');assert.equal(calls,1);
 now=30001;await c.read('a');assert.equal(calls,2);await c.read('b');assert.equal(calls,3);
 const delayed=createQuotaCollector({server:()=>backend,call:()=>new Promise(r=>resolve=r)});
 const flight=delayed.read('a');delayed.clear();resolve(native);assert.equal(await flight,null);
 assert.equal(require('fs').readFileSync(require('path').join(__dirname,'../client/maintenance/tools/hud/hub-hud-main.js'),'utf8'),require('fs').readFileSync(require('path').join(__dirname,'../src/AntigravityHub/integration/hub-hud-main.js'),'utf8'));
 console.log('PASS: native Argon quota allowlist, zero/unknown values, bounded cache, account isolation and stale-flight rejection.');
})().catch(e=>{console.error(e);process.exitCode=1;});
