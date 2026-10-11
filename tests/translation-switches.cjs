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
  console.log('PASS: all four UI/thinking combinations, new remote-control text, disabled thought scanning, offline UI channel, thinking-only requests, subframe rejection and turning thinking back off. No real data transmitted.');
})().catch(e=>{console.error(e);process.exitCode=1;});
