'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),tools=path.join(root,'client/maintenance/tools');
const {verify,mergeEntries,mergeTemplates}=require('../dev/build-ui-memory.cjs');
const memory=verify();
for(const token of ['End','From','Instructions'])assert(!Object.hasOwn(memory.entries,token),'A contextual label leaked into the shared dictionary: '+token);
const retained=mergeEntries({OldLabel:'原有译文','Google Docs':'旧误译'},{NewLabel:'新增译文'},new Map(),['Google Docs']);
assert.equal(retained.OldLabel,'原有译文','Removing an old screen from the next release must not erase its translation');
assert.equal(retained.NewLabel,'新增译文');assert.equal(retained['Google Docs'],undefined);
assert.equal(mergeEntries(retained,{OldLabel:'修正后的译文'},new Map()).OldLabel,'修正后的译文');
const oldTemplate={parts:['Old ','.'],translated:['旧版 ', '。']},newTemplate={parts:['New ','.'],translated:['新版 ','。']};
assert.deepEqual(mergeTemplates([oldTemplate],[newTemplate]),[oldTemplate,newTemplate],'Removing a legacy source template must not erase the saved translation');
assert(memory.templates.length>=322,'Keep the previously reviewed template corpus');
const phrases=new Set();
for(const source of memory.sources.filter(source=>source.path.endsWith('ui-source-manifest.json'))){
 for(const patch of JSON.parse(fs.readFileSync(path.join(root,source.path),'utf8')).patches||[]){
  if(/^(property:|react-child|native-settings|native-browser|native-tab|native-archive)/.test(patch.role||'')&&
    patch.text===patch.text.trim() && /[A-Za-z]/.test(patch.text) && memory.entries[patch.text] && memory.entries[patch.text]!==patch.text)phrases.add(patch.text);
 }
}
const known=[...phrases];assert(known.length>2000);
const templates=memory.templates.map((template,index)=>{
 const values=template.parts.slice(1).map((_,i)=>'VALUE'+index+'_'+i);
 return {original:template.parts.map((part,i)=>part+(values[i]||'')).join(''),values};
});
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agh-ui-upgrade-test-'));let context,guard;
 try {
  context=await chromium.launchPersistentContext(path.join(temp,'browser'),{channel:'msedge',headless:true,args:['--remote-debugging-port=0']});
  let version='2.28.2',revision='first';
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());if(url.origin!=='https://127.0.0.1:32883')return route.abort();
   if(url.pathname==='/main.js')return route.fulfill({contentType:'application/javascript; charset=utf-8',body:'window.nativeStorage={version:'+JSON.stringify(version)+'};window.electronUpdater={};window.agent={};window.unreviewedRenderer='+JSON.stringify(revision)+';'});
   const rows=known.map((text,i)=>'<section class="'+revision+'-layout"><'+(i%2?'p':'h3')+' data-known="'+i+'">'+escape(text)+'</'+(i%2?'p':'h3')+'></section>');
   if(revision!=='first')rows.reverse();
   const literals='<p id="command"><code>/</code> <code>plan</code> <code>/plan</code> <kbd>End</kbd></p><div id="unrelated"><span>From</span> <span>End</span> <span>Instructions</span></div>';
   return route.fulfill({contentType:'text/html; charset=utf-8',body:'<script src="/main.js"></script><main>'+rows.join('')+'</main><aside>'+templates.map((template,i)=>'<p data-template="'+i+'">'+escape(template.original)+'</p>').join('')+'</aside>'+literals+'<div id="new-word">Quantum Frobnicator 2099</div><div data-testid="conversation-view"><p>Settings</p><p>Give Feedback</p></div><div data-testid="project-selector-item">Settings</div><plugin-card>Give Feedback</plugin-card><pre>Settings</pre><textarea>Give Feedback</textarea>'});
  });
  const page=context.pages()[0];await page.goto('https://127.0.0.1:32883/');
  const home=path.join(temp,'user'),appdata=path.join(temp,'appdata');fs.mkdirSync(path.join(home,'.antigravity_hub'),{recursive:true});fs.mkdirSync(path.join(appdata,'Antigravity'),{recursive:true});
  fs.writeFileSync(path.join(home,'.antigravity_hub/app_settings.json'),JSON.stringify({EnableClientLocalization:true}));
  fs.copyFileSync(path.join(temp,'browser/DevToolsActivePort'),path.join(appdata,'Antigravity/DevToolsActivePort'));
  guard=spawn(process.execPath,[path.join(tools,'ui-guard.cjs')],{env:{...process.env,USERPROFILE:home,HOME:home,APPDATA:appdata},windowsHide:true,stdio:'ignore'});
  await page.waitForFunction(()=>document.querySelector('[data-known="0"]').textContent!=='Accept Step',null,{timeout:10000});
  const readKnown=()=>page.locator('[data-known]').evaluateAll(elements=>Object.fromEntries(elements.map(element=>[element.dataset.known,element.textContent])));
  const before=await readKnown();
  const missing=known.map((text,index)=>({text,index})).filter(({text,index})=>before[index]===text);
  assert.deepEqual(missing,[],'Previously approved static phrases must all remain translated');
  const templateResults=await page.locator('[data-template]').allTextContents();
  const failedTemplates=templates.filter((template,i)=>templateResults[i]===template.original);
  assert.deepEqual(failedTemplates,[],'Reviewed templates must keep translating variable values');
  for(const [i,template]of templates.entries())for(const value of template.values)assert(templateResults[i].includes(value),JSON.stringify({requirement:'Template values must remain unchanged',index:i,original:template.original,result:templateResults[i],missing:value}));
  version='99.7.1';revision='rebuilt-and-renamed';await page.reload();
  await page.waitForFunction(()=>document.querySelector('[data-known="0"]').textContent!=='Accept Step',null,{timeout:10000});
  assert.deepEqual(await readKnown(),before,'New version, changed renderer and reordered layout must preserve old translations');
  assert.equal(await page.evaluate(()=>window.antigravityHansStatus),undefined,'No installed native localization patch');
  assert.equal(await page.locator('#new-word').innerText(),'Quantum Frobnicator 2099');
  assert.equal(await page.locator('#command').innerText(),'/ plan /plan End');
  assert.equal(await page.locator('#unrelated').innerText(),'From End Instructions');
  assert.equal(await page.locator('[data-testid=conversation-view]').innerText(),'Settings\n\nGive Feedback');
  assert.equal(await page.locator('[data-testid=project-selector-item]').innerText(),'Settings');
  assert.equal(await page.locator('plugin-card').innerText(),'Give Feedback');
  assert.equal(await page.locator('pre').innerText(),'Settings');assert.equal(await page.locator('textarea').inputValue(),'Give Feedback');
  const report={reviewedStaticPhrases:known.length,reviewedTemplates:templates.length,versions:['2.28.2','99.7.1'],nativePatchPresent:false,rendererChanged:true,layoutReordered:true,oldTranslationsPreserved:true,newEnglishPreserved:true,userContentPreserved:true};
  console.log('PASS: '+JSON.stringify(report));
  if(process.env.AGH_UPGRADE_REPORT)fs.writeFileSync(process.env.AGH_UPGRADE_REPORT,JSON.stringify(report,null,2)+'\n');
 }finally{if(guard){guard.kill();await once(guard,'exit').catch(()=>{});}if(context)await context.close();assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
