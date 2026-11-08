'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {chromium}=require('playwright');
const {buildPortableUiSource}=require('../client/maintenance/tools/portable-ui.cjs');
const tools=path.resolve(__dirname,'../client/maintenance/tools');
const hans=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const dictionary={...require(path.join(hans,'ui_dictionary.json')),...require(path.join(hans,'ui_overrides.json'))};
const expression=enabled=>buildPortableUiSource(enabled);
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agh-fixed-ui-test-'));
 let context,guard;
 try {
  context=await chromium.launchPersistentContext(path.join(temp,'browser'),{channel:'msedge',headless:true,args:['--remote-debugging-port=0']});
  await context.route('**/*',route=>route.request().url().startsWith('https://127.0.0.1:32882/')
   ?route.fulfill({contentType:'text/html',body:'<script>window.nativeStorage={};window.electronUpdater={};window.agent={};</script><header><button aria-label="Settings">Settings</button></header><nav data-testid="project-header"><button title="Settings">Settings</button></nav><div role="menu"><div>No projects found</div><button>New project</button><div data-testid="project-selector-item">Settings</div></div><div role="dialog"><label>Trigger</label><input placeholder="Search..."></div><div data-testid="conversation-view"><button aria-label="Settings">Settings</button><div class="prose">Trigger</div></div><plugin-card>Settings</plugin-card>'})
   :route.abort());
  const page=context.pages()[0];await page.goto('https://127.0.0.1:32882/');
  await page.evaluate(()=>{document.querySelector('.prose').innerHTML='<span>Settings</span>'.repeat(10000);});
  const initial=await page.evaluate(expression(true));assert.equal(initial.mode,'persistent-ui');
  assert.equal(await page.locator('header button').innerText(),'设置');
  assert.equal(await page.locator('[role=menu] div').first().innerText(),'未找到项目');
  assert.equal(await page.locator('label').innerText(),'触发条件');
  assert.equal(await page.locator('[data-testid=conversation-view] button').innerText(),'Settings');
  assert.equal(await page.locator('plugin-card').innerText(),'Settings');
  assert.equal(await page.locator('nav button').innerText(),'Settings');
  assert.equal(await page.locator('nav button').getAttribute('title'),'Settings');
  assert.equal(await page.locator('[data-testid=project-selector-item]').innerText(),'Settings');
  await page.evaluate(()=>{const section=document.createElement('div');section.setAttribute('role','dialog');document.body.append(section);const label=document.createElement('label');label.textContent='Trigger';section.append(label);});
  await page.getByText('触发条件',{exact:true}).last().waitFor();
  await page.evaluate(expression(false));assert.equal(await page.locator('header button').innerText(),'Settings');
  assert.equal(await page.locator('[role=menu] div').first().innerText(),'No projects found');
  const userHome=path.join(temp,'user'),appData=path.join(temp,'roaming');
  fs.mkdirSync(path.join(userHome,'.antigravity_hub'),{recursive:true});fs.mkdirSync(path.join(appData,'Antigravity'),{recursive:true});
  fs.copyFileSync(path.join(temp,'browser','DevToolsActivePort'),path.join(appData,'Antigravity','DevToolsActivePort'));
  const settings=path.join(userHome,'.antigravity_hub','app_settings.json');
  fs.writeFileSync(settings,JSON.stringify({EnableClientLocalization:true}));
  const environment={...process.env,USERPROFILE:userHome,HOME:userHome,APPDATA:appData};
  guard=spawn(process.execPath,[path.join(tools,'ui-guard.cjs')],{env:environment,windowsHide:true,stdio:'ignore'});
  await page.waitForFunction(()=>document.querySelector('header button').textContent==='设置',null,{timeout:10000});
  await page.reload();
  try { await page.waitForFunction(()=>document.querySelector('header button').textContent==='设置',null,{timeout:7000}); }
  catch(error){
    const debugSession=await context.newCDPSession(page);
    const tree=await debugSession.send('Page.getFrameTree');
    const world=await debugSession.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'AntigravityHub fixed UI'});
    const state=await debugSession.send('Runtime.evaluate',{contextId:world.executionContextId,expression:'JSON.stringify({ready:document.readyState,controller:globalThis.__aghFixedUi?.status(),flag:window.__antigravityHans23,header:document.querySelector("header button")?.textContent})',returnByValue:true});
    console.error(JSON.stringify({state:state.result.value}));await debugSession.detach();throw error;
  }
  fs.writeFileSync(settings,JSON.stringify({EnableClientLocalization:false}));
  await page.waitForFunction(()=>document.querySelector('header button').textContent==='Settings',null,{timeout:7000});
  guard.kill();await once(guard,'exit');guard=null;
  fs.writeFileSync(settings,JSON.stringify({EnableClientLocalization:true}));
  await page.evaluate(()=>window.antigravityHansStatus={bundle:async()=>({uiSourceCount:3172,reason:null})});
  guard=spawn(process.execPath,[path.join(tools,'ui-guard.cjs')],{env:environment,windowsHide:true,stdio:'ignore'});
  const [code]=await Promise.race([once(guard,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Full adapter must not retain a fallback process')),7000))]);
  assert.equal(code,0);guard=null;
  let oldEngine;
  try { oldEngine=execFileSync('git',['show','8762b8c:client/release-2.22.0/source/hans/hans-preload.js'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',stdio:['ignore','pipe','ignore']}); } catch {}
  const currentEngine=fs.readFileSync(path.join(hans,'hans-preload.js'),'utf8');
  const visits=[];
  for(const engine of [oldEngine,currentEngine].filter(Boolean)){
    await page.reload();
    await page.evaluate(()=>{
      document.querySelector('.prose').innerHTML='<span>Settings</span>'.repeat(10000);
      const original=document.createTreeWalker.bind(document);window.walkerVisits=0;
      document.createTreeWalker=(root,what,filter)=>original(root,what,{acceptNode(node){window.walkerVisits++;return filter.acceptNode(node);}});
    });
    const wrapped='(()=>{const HUB_OPTIONS={localization:true,thinking:false};const process={};const require=()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async()=>[]}});'+engine.replace('__UI_DICT_JSON__',JSON.stringify(dictionary))+'})()';
    await page.evaluate(wrapped);
    visits.push(await page.evaluate(()=>window.walkerVisits));
    assert.equal(await page.locator('.prose span').first().innerText(),'Settings');
  }
  if(oldEngine){assert(visits[0]>20000 && visits[1]<100,JSON.stringify(visits));console.log('BENCHMARK: native localization tree-walker visits '+visits[0]+' -> '+visits[1]+' for the same 10,000-node protected Markdown fixture.');}
  // User-reported fixed UI: dynamic headings, native icon fragments, the
  // conditional search placeholder and browser preferences, never chat text.
  await page.reload();
  await page.evaluate(()=>{
    document.body.innerHTML='<div role="dialog"><h2>Search Across Conversations</h2><span id="archive-guide">View archived in the sidebar <span class="whitespace-nowrap">(<svg aria-label="filter"></svg> menu)</span>.</span><button>Give Feedback</button><h3>Built-in Browser</h3><p>Configure link opening and built-in browser preferences.</p><p>Choose where links open by default when clicked.</p><button>External Browser</button><input data-testid="new-tab-search-input" placeholder="Search tabs, files, extensions, subagents, artifacts, commands..."></div><div data-testid="conversation-view"><p>Give Feedback</p></div><plugin-card>Built-in Browser</plugin-card>';
  });
  await page.evaluate('(()=>{const HUB_OPTIONS={localization:true,thinking:false};const process={};const require=()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async()=>[]}});'+currentEngine.replace('__UI_DICT_JSON__',JSON.stringify(dictionary))+'})()');
  assert.equal(await page.locator('h2').innerText(),'跨对话搜索');
  assert.match(await page.locator('#archive-guide').innerText(),/^可在侧边栏的.*菜单）中查看已归档的对话。$/);
  assert.equal(await page.getByRole('button',{name:'反馈意见',exact:true}).count(),1);
  assert.equal(await page.locator('h3').innerText(),'内置浏览器');
  assert.equal(await page.getByRole('button',{name:'外部浏览器',exact:true}).count(),1);
  assert.equal(await page.getByTestId('new-tab-search-input').getAttribute('placeholder'),'搜索标签页、文件、扩展、子智能体、产物和命令…');
  assert.equal(await page.locator('[data-testid=conversation-view]').innerText(),'Give Feedback');
  assert.equal(await page.locator('plugin-card').innerText(),'Built-in Browser');
  console.log('PASS: independent CDP fallback, native full-adapter exit, reload, localization on/off restoration, project empty state, new UI, chat/plugin protection and 10,000-node streaming subtree pruning; no external network or real user data.');
 } finally {
  if(guard){guard.kill();await once(guard,'exit').catch(()=>{});}
  if(context)await context.close();
  assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
