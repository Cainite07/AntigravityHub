'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const dict={...require(path.join(root,'ui_dictionary.json')),...require(path.join(root,'ui_overrides.json'))};
let source=fs.readFileSync(path.join(root,'hans-preload.js'),'utf8').replace('__UI_DICT_JSON__',JSON.stringify(dict));
source=source.replace(/\}\)\(\);\s*$/,'globalThis.harness={translateStaticText,scan};})();');
for(const localization of [false,true])for(const thinking of [false,true]) {
  let scans=0,requests=0;
  const context={HUB_OPTIONS:{localization,thinking},process:{},window:{},console,Node:{TEXT_NODE:3,ELEMENT_NODE:1},
    MutationObserver:class{observe(){}},document:{readyState:'loading',addEventListener(){},querySelectorAll(){scans++;return[];}},
    setTimeout:()=>0,clearTimeout(){},require:()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async()=>{requests++;return[];}}})};
  vm.runInNewContext(source,context);
  const node={nodeType:3,nodeValue:'Enable Remote Control',parentElement:{closest:()=>null,matches:()=>false}};
  context.harness.translateStaticText(node);assert.equal(node.nodeValue,localization?'启用远程控制':'Enable Remote Control');
  for(const [english,chinese] of [['Trigger','触发条件'],['Unavailable','不可用'],['Gemini 4 Argon is currently available to Ultra and paid Pro plan subscribers.','Gemini 4 Argon 目前仅向 Ultra 和付费 Pro 套餐订阅用户开放。']]) {
    const label={...node,nodeValue:english};context.harness.translateStaticText(label);assert.equal(label.nodeValue,localization?chinese:english);
    const message={...node,nodeValue:english,parentElement:{closest:s=>s.includes('[data-testid="conversation-view"]')?{}:null,matches:()=>false}};
    context.harness.translateStaticText(message);assert.equal(message.nodeValue,english,'Conversation content is preserved');
  }
  context.harness.scan();assert.equal(scans,thinking?1:0);assert.equal(requests,0);
}

(async()=>{
  const handlers=new Map();let settings={localization:true,thinking:false},calls=0;
  const moduleMock={exports:{}};
  const context={module:moduleMock,console,URL,require:name=>{
    if(name==='node:path')return path;
    if(name==='./hans-bundle-hook')return{install(){},getStatus(){return{};}};
    if(name==='./hub-client-settings')return{read:()=>settings};
    if(name==='./hans-translator')return{createTranslator:()=>({translate:async texts=>{calls++;return texts.map(()=>'测试译文');}})};
    throw Error(name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'hans-main.js'),'utf8'),context);
  context.module.exports.install({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},app:{getPath:()=>'/fixture'}});
  const frame={url:'https://127.0.0.1:3000/'};
  const event={sender:{getURL:()=>frame.url,mainFrame:frame},senderFrame:frame};
  assert.equal((await handlers.get('hans:translate')(event,['A public test sentence.']))[0],null);assert.equal(calls,0);
  settings={localization:false,thinking:true};assert.equal((await handlers.get('hans:translate')(event,['A public test sentence.']))[0],'测试译文');assert.equal(calls,1);
  await handlers.get('hans:translate-ui')(event,['A UI notice.']);assert.equal(calls,1);
  const subframe={...event,senderFrame:{url:frame.url}};await handlers.get('hans:translate')(subframe,['A test.']);assert.equal(calls,1);
  settings={localization:true,thinking:false};await handlers.get('hans:translate')(event,['A test.']);assert.equal(calls,1);
  for(const [version,suffix] of [['2.26.0','2260'],['2.28.2','2282'],['2.29.0','2290']]) if(process.env['ANTIGRAVITY_RENDERER_'+suffix]) {
    const original=fs.readFileSync(process.env['ANTIGRAVITY_RENDERER_'+suffix],'utf8');let responseSource=original,enabled=true,route;
    const hookModule={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'hans-bundle-hook.js'),'utf8'),{module:hookModule,URL,Headers,Response,console:{log(){},warn(){}},require:name=>name==='./hub-client-settings'?{read:()=>({localization:enabled})}:name==='node:crypto'?require(name):require(path.join(root,name))});
    hookModule.exports.install({app:{getVersion:()=>version},session:{defaultSession:{protocol:{handle:(scheme,handler)=>{assert.equal(scheme,'https');route=handler;}}}},net:{fetch:async()=>new Response(responseSource)}});
    const request={method:'GET',url:'https://127.0.0.1:3000/main.js'};
    const translated=await (await route(request)).text();
    if(version==='2.29.0'){
      const literalSamples=source=>[...source.matchAll(/createElement\("(?:code|kbd|samp)",(?:null|\{[^{}]*\}),\s*("(?:\\.|[^"\\])*")\)/g)].map(m=>JSON.parse(m[1]));
      const samples=literalSamples(original);
      assert(samples.includes('/') && samples.includes('plan') && samples.includes('Shift') && samples.includes('esc'));
      assert.deepEqual(literalSamples(translated),samples,'Typing instructions preserve command tokens and keycaps');
      assert(translated.includes('"套餐"'),'Billing plan title is still localized');
    }
    assert.equal(hookModule.exports.getStatus().uiSourceCount,require(path.join(root,'ui-source-'+suffix)).patches.length);
    assert.equal(hookModule.exports.getStatus().reason,null);
    assert(translated.includes('"触发条件"'));
    responseSource=original+'\n';assert.equal(await (await route(request)).text(),responseSource);
    assert.match(hookModule.exports.getStatus().reason,/Unreviewed.*renderer SHA-256/);
    enabled=false;responseSource=original;assert.equal(await (await route(request)).text(),original);
    console.log('PASS: live HTTPS renderer interception applies the reviewed '+version+' UI spans; changed hashes and disabled localization preserve source.');
  }
  console.log('PASS: all four UI/thinking combinations, new remote-control text, disabled thought scanning, offline UI channel, thinking-only requests, subframe rejection and turning thinking back off. No real data transmitted.');
})().catch(e=>{console.error(e);process.exitCode=1;});
