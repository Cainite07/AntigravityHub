// Browser-level checks against the actual preload and reviewed native layouts.
// Usage: node tests/client-ui.cjs <path-to-playwright-module> <artifact-directory>
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.argv[2]||'playwright');
const root=path.resolve(__dirname,'..'),hans=path.join(root,'client/release-2.22.0/source/hans');
const dictionary={...require(path.join(hans,'ui_dictionary.json')),...require(path.join(hans,'ui_overrides.json'))};
const translation=fs.readFileSync(path.join(hans,'hans-preload.js'),'utf8').replace('__UI_DICT_JSON__',JSON.stringify(dictionary));
const hud=fs.readFileSync(path.join(root,'src/AntigravityHub/integration/hud-preload.js'),'utf8');
const id='00000000-0000-0000-0000-000000000001',id2='00000000-0000-0000-0000-000000000002';
const fixture=`<!doctype html><html data-theme="light"><body style="margin:24px;background:#faf7f0;font:13px Segoe UI">
 <section data-testid="conversation-view"><h1 id="log" class="sr-only">Conversation Log</h1><button id="older" aria-disabled="false" aria-label="Load older messages, showing 3 of 40">Load older messages</button><button id="copy" data-tooltip-id="copy" aria-label="Copy"></button><button id="rating" data-tooltip-id="rating" aria-label="Good response"></button><span id="age" data-screenshot-volatile="true" data-tooltip-id="age" class="text-xs text-muted-foreground select-none whitespace-nowrap">7h ago</span><div class="prose"><button id="user-copy" data-tooltip-id="copy" aria-label="Copy">Conversation Log</button></div></section>
 <main style="max-width:760px">
 <h2 id="category">Google Workspace</h2><p id="category-description">Connect to Google Workspace, including Docs, Sheets, Slides, Drive, and Calendar.</p>
 <div class="relative flex items-center gap-3 p-3 rounded-xl"><div class="flex-1 min-w-0 flex flex-col"><a id="plugin-name">Automation</a><p id="plugin-description">New Automation</p></div><button id="client-control">Add</button></div>
 <div class="flex items-baseline gap-2.5 min-w-0"><span id="skill-name">Science</span><span>Built In</span><span id="skill-description" title="New Automation">New Automation</span></div>
 <div data-testid="doc-row-modal"><p id="skill-body">Enable Remote Control</p></div>
 <p id="agent-empty">No custom agents yet.</p><p id="automation-empty">No automations configured.</p>
 <div data-testid="new-sidecar-modal"><h3 id="automation-title">New Automation</h3><input id="automation-name" placeholder="Enter automation name..."><textarea id="prompt" data-testid="new-sidecar-prompt" placeholder="Enter a prompt for the agent to run...">New Automation</textarea><p id="footnote">All automations run as Flash.</p><button id="add-automation">Add Automation</button></div>
 <span id="model-tag">Leaving Soon</span><p id="model-intro">Start using Gemini 3.8 Flash, our best Flash model.</p>
 <div class="prose"><p id="message">No automations configured.</p></div>
 <div role="region" aria-label="Notifications"><div class="prose"><p id="archive-notice">View archived conversations in <a href="notification://history">history</a>.</p></div></div>
 <div class="prose"><p id="archive-message">View archived conversations in <a href="notification://history">history</a>.</p></div>
 </main>
 <div data-testid="conversation-view"><div data-testid="agent-input-box" style="position:fixed;left:24px;right:24px;bottom:24px;background:#faf7f0"><div class="justify-between"><div class="gap-1.5 flex" style="display:flex;justify-content:flex-end;gap:6px"><button aria-label="Record voice memo" data-tooltip-id="input-send-button-record-tooltip">◉</button><button id="send" data-testid="send-button" aria-label="Send message" title="Send message Enter">→</button></div></div></div>
 </div></body></html>`;
let browser;
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:850,height:950}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://127.0.0.1:12000/**',r=>r.fulfill({body:fixture,contentType:'text/html'}));
 await page.addInitScript(({id,id2})=>{
  window.process={isMainFrame:true};window.HUB_OPTIONS={localization:true,thinking:false};window.ipcCalls=[];
  const accounts=[{id:'current',isCurrent:true,name:'当前账号',email:'demo@example.test',gemini5hQuota:100,geminiWeeklyQuota:98,claude5hQuota:100,claudeWeeklyQuota:48,resetTime5h:new Date(Date.now()+5*3600000).toISOString(),resetTimeWeekly:new Date(Date.now()+6*86400000).toISOString(),claudeResetTime5h:new Date(Date.now()+5*3600000).toISOString(),claudeResetTimeWeekly:new Date(Date.now()+4*86400000).toISOString(),tier:'PRO'},{id:'alternate',name:'备用账号',email:'backup@example.test'}];
  window.require=()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async(channel,arg)=>{
   ipcCalls.push({channel,arg});if(channel==='hub-hud:snapshot')return{available:true,enabled:true,today:'2.3M',accounts};
   if(channel==='hub-hud:speed')return arg===id?{conversationId:id,tps:104.6,basis:'response'}:null;
   if(channel==='hub-hud:open'||channel==='hub-hud:switch')return true;return null;
  }}});
 },{id,id2});
 await page.goto(`https://127.0.0.1:12000/c/${id}`);
 await page.addScriptTag({content:translation});await page.addScriptTag({content:hud});await page.waitForTimeout(350);
 const checks={category:'Google 办公套件', 'plugin-name':'Automation','plugin-description':'New Automation','skill-name':'Science','skill-description':'New Automation','skill-body':'Enable Remote Control','agent-empty':'尚无自定义智能体。','automation-empty':'尚未配置自动化任务。','automation-title':'新建自动化',footnote:'所有自动化任务均使用 Flash 模型。','add-automation':'添加自动化','model-tag':'即将下线',message:'No automations configured.'};
 for(const [selector,expected]of Object.entries(checks))assert.equal(await page.locator('#'+selector).textContent(),expected,selector);
 assert.equal(await page.locator('#automation-name').getAttribute('placeholder'),'输入自动化名称…');
 assert.equal(await page.locator('#prompt').getAttribute('placeholder'),'输入供智能体执行的提示词…');
 assert.equal(await page.locator('#prompt').inputValue(),'New Automation');assert.equal(await page.locator('#send').getAttribute('title'),'发送消息 Enter');
 assert.equal(await page.locator('#archive-notice').textContent(),'可在历史中查看已归档对话。');
 assert.equal(await page.locator('#archive-notice a').getAttribute('href'),'notification://history');
 assert.equal(await page.locator('#archive-message').textContent(),'View archived conversations in history.');
 assert.equal(await page.locator('#send').getAttribute('aria-label'),'发送消息');
 assert.equal(await page.locator('[data-tooltip-id="input-send-button-record-tooltip"]').getAttribute('aria-label'),'录制语音备忘');
 assert((await page.locator('#model-intro').textContent()).includes('我们目前最出色'));
 assert.equal(await page.locator('#log').textContent(),'对话记录');assert.equal(await page.locator('#older').textContent(),'加载更早消息');assert.equal(await page.locator('#older').getAttribute('aria-label'),'加载更早消息，已显示 3 / 40 条');assert.equal(await page.locator('#copy').getAttribute('aria-label'),'复制');assert.equal(await page.locator('#rating').getAttribute('aria-label'),'好评');assert.equal(await page.locator('#age').textContent(),'7 小时前');assert.equal(await page.locator('#user-copy').getAttribute('aria-label'),'Copy');assert.equal(await page.locator('#user-copy').textContent(),'Conversation Log');
 const pill=page.locator('#antigravity-hub-hud .pill'),popup=page.locator('#antigravity-hub-hud .popover');
 assert((await pill.innerText()).includes('104.6'));assert(!(await pill.innerText()).includes('5h'));
 await pill.click();assert.equal(await popup.locator('.quota-circle').count(),2);assert.equal(await popup.locator('.meter').count(),2);assert.equal(await popup.locator('.account').count(),1);
 assert.equal(await popup.evaluate(e=>getComputedStyle(e).borderRadius),'15px');
 if(process.argv[3]){fs.mkdirSync(process.argv[3],{recursive:true});await popup.screenshot({path:path.join(process.argv[3],'hud-133-light.png')});}
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.body.style.background='#232528';document.querySelector('.justify-between').parentElement.style.background='#232528';});
 await page.waitForTimeout(180);assert.equal(await page.locator('#antigravity-hub-hud').getAttribute('data-light'),null);
 if(process.argv[3])await popup.screenshot({path:path.join(process.argv[3],'hud-133-dark.png')});
 await page.keyboard.press('Escape');assert.equal(await pill.getAttribute('aria-expanded'),'false');
 await page.evaluate(id2=>{history.pushState({},'',`/c/${id2}`);document.querySelector('.justify-between').append(document.createElement('span'));},id2);
 await page.waitForTimeout(200);assert(!(await pill.innerText()).includes('104.6'));assert((await pill.innerText()).includes('—'));
 for(const width of [850,430,320]){await page.setViewportSize({width,height:950});await page.waitForTimeout(120);const box=await pill.boundingBox();assert(box.x>=0&&box.x+box.width<=width,`Pill overflow at ${width}`);}
 assert.equal((await page.evaluate(()=>ipcCalls)).filter(x=>x.channel.startsWith('hans:translate')).length,0);
 assert.deepEqual(errors,[]);
 console.log(`PASS: ${Object.keys(checks).length} localization/content boundaries, prompt protection, tooltips, light/dark HUD, two rings, alternate-only account list, 15px corners, Escape, conversation change and 320px fit.`);
 await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
