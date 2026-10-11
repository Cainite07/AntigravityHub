'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const dictionary={...JSON.parse(fs.readFileSync(path.join(root,'ui_dictionary.json'))),...JSON.parse(fs.readFileSync(path.join(root,'ui_overrides.json')))};
const engine=fs.readFileSync(path.join(root,'hans-preload.js'),'utf8').replace('__UI_DICT_JSON__',JSON.stringify(dictionary)).replace(/\}\)\(\);\s*$/,'globalThis.harness={translateStaticAttributes,translateStaticText};})();');
const context={HUB_OPTIONS:{localization:true,thinking:false},process:{},window:{},console,Node:{TEXT_NODE:3,ELEMENT_NODE:1},MutationObserver:class{observe(){}},document:{readyState:'loading',addEventListener(){}},setTimeout:()=>0,clearTimeout(){},require:()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async()=>[]}})};
vm.runInNewContext(engine,context);
function button(id,label,{row=false,body=false,menu=false}={}){
  const attrs={'aria-label':label};return {nodeType:1,tagName:'BUTTON',
    getAttribute:name=>attrs[name]||null,setAttribute:(name,value)=>{attrs[name]=value;},
    matches:s=>(id&&s.includes('[data-testid="'+id+'"]'))||(menu&&s==='button[aria-haspopup="menu"]'),
    closest:s=>body&&(/\.prose|contenteditable/.test(s))?{}:row&&s==='[data-testid="conversation-row-sidebar"]'?{}:null};
}
for(const [id,label,result] of [['conversation-pin-button','Pin conversation','固定对话'],['conversation-pin-button','Unpin conversation','取消固定对话'],['conversation-archive-button','Archive conversation','归档对话'],['conversation-kebab','More options','更多选项']]){
  const b=button(id,label,{row:true});context.harness.translateStaticAttributes(b);assert.equal(b.getAttribute('aria-label'),result);
  const message=button('',label,{body:true});context.harness.translateStaticAttributes(message);assert.equal(message.getAttribute('aria-label'),label,'Same named user attributes stay protected');
}
for(const [label,result] of [['Select project, current: No Project','选择项目，当前：无项目'],['Select project, current: New Window','选择项目，当前：New Window']]){
  const b=button('',label,{menu:true});context.harness.translateStaticAttributes(b);assert.equal(b.getAttribute('aria-label'),result);
  const user=button('',label,{body:true,menu:true});context.harness.translateStaticAttributes(user);assert.equal(user.getAttribute('aria-label'),label);
}
console.log('PASS: Protected sidebar system button attributes translate; user attributes and project names stay intact');
