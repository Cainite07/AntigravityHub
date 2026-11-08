'use strict';
const fs=require('node:fs'),path=require('node:path');
const hans=path.resolve(__dirname,'../../release-2.22.0/source/hans');
function lifecycle(memory){
 const records=new WeakMap();let references=[],count=0,engineStop=()=>{},stopped=false;
 const scopedByField=new Map();
 for(const template of memory.scopedTemplates || []){
  const {testId='',attribute='text'}=template.scope || {};
  if(!testId && attribute==='text')continue;
  if(!['text','title','aria-label','placeholder'].includes(attribute))continue;
  if(!scopedByField.has(attribute))scopedByField.set(attribute,new Map());
  const buckets=scopedByField.get(attribute);
  if(!buckets.has(testId))buckets.set(testId,[]);
  buckets.get(testId).push(template);
 }
 const originalLanguage=document.documentElement?.getAttribute('lang')??null;
 const privateFields='[data-testid="project-selector-item"],[data-testid="project-selector-github-repo-item"],[data-testid="project-header"],'+
  '[data-testid^="plugin-suggested-prompt"],[data-plugin-content],plugin-card,[data-testid="doc-row-modal"],[data-testid="hook-row-modal"],'+
  '[data-testid="conversation-navigator"],[data-file-path],[role="treeitem"] .truncate,[role="treeitem"] [title]';
 function privateNode(node){const element=node?.nodeType===1?node:node?.parentElement;return !!element?.closest(privateFields);}
 function remember(node,key,original,translated){
  if(original===translated)return;
  let values=records.get(node);if(!values){values=new Map();records.set(node,values);references.push(new WeakRef(node));}
  const previous=values.get(key);values.set(key,{original:previous?.translated===original?previous.original:original,translated});count++;
  if(references.length>4096)references=references.filter(ref=>ref.deref()?.isConnected);
 }
 function matchTemplates(value,templates){
  if(value.length>1000)return null;
  for(const template of templates){
   const {parts,translated}=template;
   if(!value.startsWith(parts[0])||!value.endsWith(parts.at(-1)))continue;
   const captures=[];let offset=parts[0].length,valid=true;
   for(let i=1;i<parts.length;i++){
    const delimiter=parts[i],end=i===parts.length-1?value.length-delimiter.length:value.indexOf(delimiter,offset);
    if(end<offset || (i<parts.length-1&&translated[i]!==delimiter&&value.indexOf(delimiter,end+delimiter.length)>=0)){valid=false;break;}
    captures.push(value.slice(offset,end));offset=end+delimiter.length;
   }
   if(valid&&offset===value.length)return translated.map((part,index)=>part+(captures[index]??'')).join('');
  }
  return null;
 }
 function translateTemplate(value){return matchTemplates(value,memory.templates);}
 function translateScoped(value,element,field){
  const buckets=scopedByField.get(field);
  if(!buckets || !value || !/[A-Za-z]/.test(value))return null;
  if(field!=='text' && !element.matches('button,input,textarea,select,option,a[href],[role="button"],[role="tab"],[role="menuitem"],[role="combobox"],[role="option"],[role="switch"],[role="textbox"],[role="checkbox"]'))return null;
  // Prefer the closest matching native control. A generic attribute rule comes last.
  for(let control=element.closest('[data-testid]');control;control=control.parentElement?.closest('[data-testid]')){
   const templates=buckets.get(control.getAttribute('data-testid'));
   const translated=templates && matchTemplates(value,templates);
   if(translated!=null)return translated;
  }
  return buckets.has('')?matchTemplates(value,buckets.get('')):null;
 }
 function stop(){
  if(stopped)return;stopped=true;engineStop();
  for(const ref of references){const node=ref.deref();if(!node)continue;for(const[key,value]of records.get(node)){
   if(key==='text'&&node.nodeValue===value.translated)node.nodeValue=value.original;
   else if(key!=='text'&&node.getAttribute(key)===value.translated)node.setAttribute(key,value.original);
  }}
  if(document.documentElement?.getAttribute('lang')==='zh-CN'){
    if(originalLanguage===null)document.documentElement.removeAttribute('lang');else document.documentElement.setAttribute('lang',originalLanguage);
  }
  references=[];delete window.__antigravityHans23;delete globalThis.__aghFixedUi;
 }
 globalThis.__aghFixedUi={stop,status:()=>({mode:'persistent-ui',changes:count,phrases:Object.keys(memory.entries).length,templates:memory.templates.length,stopped})};
  return {localization:true,thinking:false,privateFields,privateNode,remember,translateTemplate,translateScoped,onReady:stopEngine=>{engineStop=stopEngine;}};
}
function once(source,from,to){if(source.split(from).length!==2)throw Error('Shared UI engine lifecycle anchor changed: '+from);return source.replace(from,()=>to);}
function buildPortableUiSource(enabled=true,approvedMemory){
 if(!enabled)return 'globalThis.__aghFixedUi?.stop();';
 const memory=approvedMemory??JSON.parse(fs.readFileSync(path.join(hans,'ui-translation-memory.json'),'utf8'));
 let source=fs.readFileSync(path.join(hans,'hans-preload.js'),'utf8');
 source=once(source,'__UI_DICT_JSON__',JSON.stringify(memory.entries));
 source=once(source,'function enqueueNotice(node) {','function enqueueNotice(node) { return; }\n  function unusedNoticeQueue(node) {');
 source=once(source,'function translateUiValue(value) {','function translateUiValue(value) { return translateUiValueCore(value) || options.translateTemplate(value); }\n  function translateUiValueCore(value) {');
 source=once(source,'function translateStaticText(node) {','function translateStaticTextCore(node) {');
 source=once(source,'function translateStaticAttributes(element) {',`function translateStaticText(node) {
    if(options.privateNode(node))return;
    const nodes=[...(node?.parentElement?.childNodes || [node])].filter(n=>n?.nodeType===3);
    const before=nodes.map(n=>n.nodeValue),value=node.nodeValue;
    const scoped=!isProtected(node) && options.translateScoped(value,node.parentElement,'text');
    if(typeof scoped==='string'){
      if(scoped!==value)node.nodeValue=scoped;
    }else translateStaticTextCore(node);
    nodes.forEach((n,i)=>options.remember(n,'text',before[i],n.nodeValue));
  }
  function translateStaticAttributes(element) {
    if(options.privateNode(element))return;
    const names=['aria-label','title','placeholder'],before=names.map(name=>element?.getAttribute?.(name));
    translateStaticAttributesCore(element);
    for(let i=0;i<names.length;i++){
      const name=names[i],value=before[i];
      if(!value || (isProtected(element) && !(name==='placeholder' && element.matches(NATIVE_PROMPT) && element.parentElement && !isProtected(element.parentElement))))continue;
      const scoped=options.translateScoped(value,element,name);
      if(scoped!=null && scoped!==element.getAttribute(name))element.setAttribute(name,scoped);
    }
    names.forEach((name,i)=>{if(before[i]!=null)options.remember(element,name,before[i],element.getAttribute(name));});
  }
  function translateStaticAttributesCore(element) {`);
 source=once(source,"const STATIC_PROTECTED = PROTECTED +", "const STATIC_PROTECTED = PROTECTED + ',' + options.privateFields +");
 source=once(source,'function initialize() {',`options.onReady(() => {
    observer.disconnect(); if(retryTimer)clearTimeout(retryTimer); if(noticeTimer)clearTimeout(noticeTimer);
    document.removeEventListener('DOMContentLoaded',initialize);
  });
  function initialize() {`);
 return `(()=>{if(!/^https:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(location.origin))return;
 if(globalThis.__aghFixedUi)return globalThis.__aghFixedUi.status();
 const HUB_OPTIONS=(${lifecycle.toString()})(${JSON.stringify(memory)});
 const process={isMainFrame:true};const require=name=>{if(name!=='electron')throw Error('No page dependencies');return {contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async()=>null}};};
 ${source}
 return globalThis.__aghFixedUi.status();})()`;
}
module.exports={buildPortableUiSource};
