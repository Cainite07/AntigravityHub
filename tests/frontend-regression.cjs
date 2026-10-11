const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.TZ = 'Asia/Shanghai';
class Element {
  constructor() {
    this.style = {}; this.dataset = {}; this.children = []; this.innerText = ''; this.innerHTML = '';
    const classes = new Set();
    this.classList = { add(...v) {v.forEach(x=>classes.add(x));}, remove(...v) {v.forEach(x=>classes.delete(x));}, contains(v) { return classes.has(v); }, toggle(v,on) {if(on??!classes.has(v))classes.add(v);else classes.delete(v);} };
  }
  setAttribute(name,value) { this[name]=value; }
  appendChild(child) { this.children.push(child); }
  remove() {}
  contains() { return false; }
}
const elements = new Map();
const documentListeners = new Map();
const document = { documentElement:{dataset:{theme:'light'}}, readyState: 'loading', body: new Element(), addEventListener(name,handler) {documentListeners.set(name,handler);},
  createElement: () => new Element(), getElementById: id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  }, querySelectorAll: () => [] };
const timers = new Map(); let timerId = 0, timerClock = 0;
const posted = [];
const webviewListeners = new Map();
const windowMock = { addEventListener() {}, removeEventListener() {}, hubTheme:{ preference:'system', apply(theme){document.documentElement.dataset.theme=theme==='system'?'light':theme;} }, chrome: { webview: { postMessage: message => posted.push(message), addEventListener: (name, handler) => webviewListeners.set(name, handler) } } };
function advance(ms) {
  const target = timerClock + ms;
  for (;;) {
    const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]); timerClock = next[1].at; next[1].callback();
  }
  timerClock = target;
}
const context = vm.createContext({ document, window: windowMock, URL,
  localStorage: { setItem() {}, getItem() { return null; } }, console,
  setTimeout: (callback, delay = 0) => { const id = ++timerId; timers.set(id, {callback, at: timerClock + delay}); return id; }, clearTimeout: id => timers.delete(id), requestAnimationFrame() {} });
const html = fs.readFileSync(path.join(__dirname, '../src/AntigravityHub/wwwroot/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/AntigravityHub/wwwroot/app.js'), 'utf8');
fs.writeFileSync(path.join(__dirname, 'frontend-current.js'), source);
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);
const el = id => document.getElementById(id);
el('hub-update-modal').classList.add('hidden');
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
check('1. Zero cache/input/output percentages and clearing stale bars', () => {
  run(`renderHubData({accounts:[], stats:{todayTokens:100,todayInputTokens:100,todayCachedTokens:0,todayCachePercent:0,dailyRecords:[],models:[]}})`);
  assert.equal(el('stat-today-cache-pct').innerText, '缓存读取 0%');
  assert.deepEqual(['today-bar-cache','today-bar-in','today-bar-out'].map(id=>el(id).style.width), ['0%','100%','0%']);
  run(`renderHubData({accounts:[], stats:{todayTokens:0,dailyRecords:[],models:[]}})`);
  assert.ok(['today-bar-cache','today-bar-in','today-bar-out'].every(id=>el(id).style.width === '0%'));
});
check('2. Local week boundaries in positive and negative UTC offsets', () => {
  for (const tz of ['Asia/Shanghai', 'America/Los_Angeles', 'Europe/Berlin']) {
    process.env.TZ = tz;
    run(`allRecords=[{date:'2026-09-26',tokens:100,requests:1,formatted:'100'}];renderWeeklyFlow()`);
    assert.equal(run('Object.values(weekGroupsCache)[0].startDate'), '2026-09-21');
    assert.equal(run('Object.values(weekGroupsCache)[0].endDate'), '2026-09-27');
  }
  process.env.TZ = 'Asia/Shanghai';
});
check('3. Historical weeks are not marked as current', () => {
  run(`allRecords=[{date:'2000-08-15',tokens:100,requests:1,formatted:'100'}];renderWeeklyFlow()`);
  assert.ok(!el('week-cards-container').innerHTML.includes('本周'));
  run(`allRecords=[{date:getLocalTodayStr(),tokens:100,requests:1,formatted:'100'}];renderWeeklyFlow()`);
  assert.ok(el('week-cards-container').innerHTML.includes('本周'));
});
check('4. Historical months are not marked as current', () => {
  run(`allRecords=[{date:'2000-08-15',tokens:100,requests:1,formatted:'100'}];renderMonthlyFlow()`);
  assert.ok(!el('month-cards-container').innerHTML.includes('当前月份'));
  run(`allRecords=[{date:getLocalTodayStr(),tokens:100,requests:1,formatted:'100'}];renderMonthlyFlow()`);
  assert.ok(el('month-cards-container').innerHTML.includes('当前月份'));
});
check('5. Empty refresh clears rows, summary and badges', () => {
  run(`currentFlowMode='day';renderHubData({accounts:[],stats:{dailyRecords:[{date:'2026-09-25',tokens:100,requests:1,formatted:'100'}],models:[]}})`);
  assert.ok(el('daily-table-body').innerHTML.includes('2026-09-25'));
  run(`renderHubData({accounts:[],stats:{dailyRecords:[],models:[]}})`);
  assert.equal(el('daily-table-body').innerHTML, '');
  assert.equal(el('flow-summary-days').innerText, '0 天');
  assert.equal(el('sidebar-daily-badge').innerText, '0天');
  assert.ok(!el('flow-summary-avg').innerHTML.includes('NaN'));
});
check('6. Annual selection survives refresh and resets to all-time', () => {
  run(`currentHeatMode='year';selectedCalDate='2026-09-25';renderHubData({accounts:[],stats:{dailyRecords:[{date:'2026-09-25',tokens:100,requests:1,formatted:'100'}],dailyModels:{'2026-09-25':[]},models:[],totalTokens:200,totalFormatted:'200'}})`);
  assert.ok(el('hero-title').innerText.includes('2026-09-25'));
  assert.equal(el('hero-today-exact').innerText, '100');
  assert.equal(el('model-reset-scope-btn').innerText, '恢复全量');
  run('resetModelScope()');
  assert.equal(el('hero-title').innerText, '全周期消耗概览');
});
check('7. Current streak detects gaps, zero-use days and yesterday', () => {
  run(`testDay=(n)=>{const d=new Date();d.setDate(d.getDate()+n);return formatLocalDate(d)}`);
  assert.equal(run(`getCurrentStreak([{date:testDay(0),tokens:1},{date:testDay(-1),tokens:1},{date:testDay(-3),tokens:1}])`), 2);
  assert.equal(run(`getCurrentStreak([{date:testDay(-1),tokens:1},{date:testDay(-2),tokens:1}])`), 2);
  assert.equal(run(`getCurrentStreak([{date:testDay(0),tokens:0},{date:testDay(-5),tokens:1}])`), 0);
  assert.equal(run('getCurrentStreak([])'), 0);
});
check('8. Monthly filter summary stays aligned after refresh/blank click', () => {
  run(`currentFlowMode='day';selectedDailyMonth='2026-08';renderHubData({accounts:[],stats:{dailyRecords:[{date:'2026-08-15',tokens:100,requests:1,formatted:'100'},{date:'2026-09-15',tokens:900,requests:1,formatted:'900'}],models:[]}})`);
  assert.equal(el('flow-summary-days').innerText, '1 天');
  assert.ok(el('flow-summary-total').innerHTML.includes('>100</span>'));
  assert.ok(!el('daily-table-body').innerHTML.includes('2026-09-15'));
  run('revertFlowSummaryToDefault()');
  assert.equal(el('flow-summary-days').innerText, '1 天');
});
check('9. Toast treats markup as text', () => {
  run(`showToast('<b data-marker="yes">test</b>', false)`);
  const markup = document.body.children.at(-1).innerHTML;
  assert.ok(!markup.includes('<b data-marker='));
  assert.ok(markup.includes('&lt;b data-marker='));
});
check('10. IPC logs omit the payload containing OAuth codes', () => {
  const host = fs.readFileSync(path.join(__dirname, '../src/AntigravityHub/MainWindow.xaml.cs'), 'utf8');
  const handler = host.slice(host.indexOf('private async void OnWebMessageReceived'), host.indexOf('private System.Windows.Threading.DispatcherTimer? _autoSyncTimer'));
  assert.ok(!/Log\([^\n]*\{json\}/.test(handler));
  assert.ok(handler.includes('Log($"OnWebMessageReceived action: {action}")'));
});
check('11. Unknown quota and subscription remain explicitly unknown', () => {
  run(`renderHubData({accounts:[{id:'safe',email:'fixture@example.invalid',gemini5hQuota:-1,geminiWeeklyQuota:-1,claude5hQuota:-1,claudeWeeklyQuota:-1}],stats:{todayTokens:0,dailyRecords:[],models:[]}})`);
  const markup = el('accounts-full-list').innerHTML;
  assert.ok(markup.includes('未知') && markup.includes('尚未同步'));
  assert.ok(!markup.includes('订阅未核验') && !markup.includes('Google 服务返回的账号档位'));
  assert.ok(!markup.includes('100%') && !markup.includes('刚刚') && !markup.includes('>PRO 订阅</span>'));
});
check('12. Real zero quota renders a zero-width bar', () => {
  run(`renderHubData({accounts:[{id:'safe',email:'fixture@example.invalid',gemini5hQuota:0,geminiWeeklyQuota:0,claude5hQuota:0,claudeWeeklyQuota:0}],stats:{todayTokens:0,dailyRecords:[],models:[]}})`);
  assert.ok(el('accounts-full-list').innerHTML.includes('width: 0%'));
  assert.ok(!el('accounts-full-list').innerHTML.includes('width: 3%'));
});
check('13. Account attributes and model text/styles resist markup injection', () => {
  run(`renderHubData({accounts:[{id:'safe',email:'quote" onmouseover="injected@example.invalid',avatarUrl:'javascript:alert(1)'}],stats:{todayTokens:0,dailyRecords:[],models:[]}})`);
  const accountsMarkup = el('accounts-full-list').innerHTML;
  assert.ok(!accountsMarkup.includes(' onmouseover="injected'));
  assert.ok(!accountsMarkup.includes('src="javascript:'));
  run(`window.currentStats={models:[{name:'<img src=x onerror=alert(1)>',color:'red; background-image:url(evil)',formatted:'<b>test</b>',percentage:20,costFormatted:'<b>cost</b>'}],dailyRecords:[]};allRecords=[];renderModelDistribution('all')`);
  const modelMarkup = el('model-distribution-list').innerHTML;
  assert.ok(!modelMarkup.includes('<img src=x') && !modelMarkup.includes('background-image:url(evil)'));
  assert.ok(modelMarkup.includes('&lt;img') && modelMarkup.includes('&lt;b&gt;cost'));
});
check('14. Stale completion is ignored and real failure is not success', () => {
  run('refreshData()');
  const requestId = run('activeRefreshId');
  assert.equal(posted.at(-1).requestId, requestId);
  run(`onRefreshFinished({requestId:'stale',success:true})`);
  assert.equal(run('activeRefreshId'), requestId);
  context.testRefreshId = requestId;
  run(`onRefreshFinished({requestId:testRefreshId,success:false,message:'fixture failure'})`);
  advance(800);
  assert.equal(el('refresh-label').innerText, '未完成');
  advance(1500);
  assert.equal(run('isRefreshing'), false);
});
check('15. Successful completion and timeout have different outcomes', () => {
  run('refreshData();onRefreshFinished({requestId:activeRefreshId,success:true})'); advance(800);
  assert.equal(el('refresh-label').innerText, '已同步 ✓'); advance(1500);
  run('refreshData()'); advance(60000); advance(800);
  assert.equal(el('refresh-label').innerText, '未完成'); advance(1500);
});
check('16. Cache writes and unpriced totals stay visible in every scope', () => {
  run(`renderUsageChips([{tokens:100,cacheWriteTokens:100}])`);
  assert.ok(el('hero-chip-cache').innerHTML.includes('写入 <b>100</b> (100%)'));
  run(`allRecords=[{date:getLocalTodayStr(),tokens:100,requests:1,formatted:'100',unpricedTokens:100,costFormatted:'未定价',costUsd:0,costRmb:0}];renderWeeklyFlow();renderMonthlyFlow();updateFlowSummary(allRecords,'test')`);
  assert.ok(el('week-cards-container').innerHTML.includes('未定价'));
  assert.ok(el('month-cards-container').innerHTML.includes('未定价'));
  assert.ok(el('flow-summary-total').innerHTML.includes('未定价'));
});
check('17. Windows modifier is preserved by hotkey recording', () => {
  context.hotkeyEvent = { key:'a',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false,preventDefault(){},stopPropagation(){} };
  run('handleHotkeyKeyDown(hotkeyEvent)');
  assert.equal(run('appSettings.globalHotkey'), 'Win + A');
});
check('18. Rolling heatmap metrics exclude history outside the displayed period and clear when empty', () => {
  run(`renderHubData({accounts:[],stats:{totalTokens:999999,totalFormatted:'999,999',dailyRecords:[{date:'2020-01-01',tokens:999000}],models:[],heatmap:[{date:'2026-09-26',tokens:10,level:1},{date:'2026-09-27',tokens:20,level:1}]}})`);
  assert.equal(el('year-stat-days').innerText, '2 天');
  assert.equal(el('year-stat-tokens').innerText, '30');
  assert.equal(el('year-stat-avg').innerText, '15');
  run(`renderHubData({accounts:[],stats:{dailyRecords:[],models:[],heatmap:[]}})`);
  assert.equal(el('year-stat-days').innerText, '0 天');
  assert.equal(el('year-stat-avg').innerText, '0');
  assert.equal(el('heatmap-grid-year').innerHTML, '');
});
check('19. Heatmap starts on the actual weekday and renders month labels from dates', () => {
  el('heatmap-grid-year').children = []; el('year-month-axis').children = [];
  run(`renderHubData({accounts:[],stats:{dailyRecords:[],models:[],heatmap:[{date:'2026-02-01',tokens:1,level:1},{date:'2026-02-02',tokens:2,level:1}]}})`);
  const columns = el('heatmap-grid-year').children;
  assert.equal(columns[0].children[6].dataset.date, '2026-02-01');
  assert.equal(columns[1].children[0].dataset.date, '2026-02-02');
  assert.equal(el('year-month-axis').children[0].innerText, '2月');
});
check('20. Base and variant portraits stay separate while the variant shows its inherited price', () => {
  run(`renderHubData({accounts:[],stats:{totalTokens:5000000,totalCostFormatted:'¥61.09',dailyRecords:[],heatmap:[],models:[{name:'gemini-3.8-flash',tokens:2000000,formatted:'2M',percentage:40,costFormatted:'¥24.44',pricingBasis:'exact',priceKnown:true,color:'#3C804F'},{name:'gemini-3.8-flash-n',tokens:3000000,formatted:'3M',percentage:60,costFormatted:'¥36.65',pricingBasis:'base-variant',priceKnown:true,color:'#466B82'}]}});renderModelDistribution('all','')`);
  assert.equal(el('hero-cost-badge').innerText, '¥61.09');
  const rendered = el('model-distribution-list').innerHTML;
  assert.ok(rendered.includes('该衍生模型沿用基座参考费率；画像与历史记录保留独立模型名'));
  assert.ok(rendered.includes('gemini-3.8-flash-n'));
  assert.ok(rendered.includes('gemini-3.8-flash'));
  assert.ok(rendered.includes('¥24.44') && rendered.includes('¥36.65'));
  assert.ok(!rendered.includes('部分未定价') && !rendered.includes('≥'));
});
check('21. Monthly and annual heatmaps distinguish million-token usage and ignore empty dates in the scale', () => {
  assert.equal(run('usageLevel(0, usageThresholds([0,9000000,25000000,100000000,400000000]))'), 0);
  assert.equal(run('new Set([9000000,25000000,100000000,400000000].map(n => usageLevel(n, usageThresholds([9000000,25000000,100000000,400000000])))).size'), 4);
  el('month-cal-grid').children = [];
  run(`currentCalYear=2026;currentCalMonth=8;allRecords=[{date:'2026-09-01',tokens:9000000},{date:'2026-09-02',tokens:25000000},{date:'2026-09-03',tokens:100000000},{date:'2026-09-04',tokens:400000000}];renderMonthCalendar()`);
  const classes = el('month-cal-grid').children.map(cell => cell.className || '');
  for (const level of [1,2,3,4]) assert.ok(classes.some(value => value.includes('heat-l-' + level)));
});
check('22. Zero cache writes are hidden and positive writes retain a separate explanation', () => {
  run(`renderUsageChips([{tokens:100,cachedTokens:90,inputTokens:10,cacheWriteTokens:0}])`);
  assert.ok(!el('hero-chip-cache').innerHTML.includes('写入'));
  run(`allRecords=[{date:'2026-09-01',tokens:100,cachedTokens:90,inputTokens:10,cacheWriteTokens:0}];selectedDailyMonth='all';renderDailyTable()`);
  assert.ok(!el('daily-table-body').innerHTML.includes('/ 写'));
  run(`renderUsageChips([{tokens:100,cacheWriteTokens:100}])`);
  assert.ok(el('hero-chip-cache').innerHTML.includes('缓存写入 <b>100</b> (100%)'));
});
check('23. Cached account avatar is shared across views and unknown tier has no fabricated badge', () => {
  run(`renderHubData({accounts:[{id:'safe',email:'fixture@example.invalid',avatarDataUrl:'data:image/png;base64,aGVsbG8=',tier:'Google AI Pro',isCurrent:true,ideRestartPending:true}],currentAccount:{id:'safe',avatarDataUrl:'data:image/png;base64,aGVsbG8=',tier:'Google AI Pro',ideRestartPending:true},stats:{dailyRecords:[],models:[]}})`);
  assert.ok(el('accounts-full-list').innerHTML.includes('data:image/png;base64,aGVsbG8='));
  assert.ok(el('accounts-full-list').innerHTML.includes('PRO'));
  assert.ok(el('accounts-full-list').innerHTML.includes('请重启 Antigravity 后使用此账号'));
  assert.ok(el('sidebar-accounts-list').innerHTML.includes('等待重启 IDE'));
  assert.ok(el('sidebar-account-context').innerText.includes('待重启 IDE'));
  assert.equal(run(`safeAvatarUrl('data:image/svg+xml;base64,aGVsbG8=')`), './avatar.svg');
});
check('24. Switching sends no restart override and removed settings cannot defer activation', () => {
  run(`isSwitchingAccount=false;selectAccount('safe','fixture@example.invalid')`);
  assert.equal(posted.at(-1).action, 'switchAccount');
  assert.equal(posted.at(-1).accountId, 'safe');
  assert.ok(!Object.hasOwn(posted.at(-1), 'restartIde'));
  advance(120000);
  assert.equal(run('isSwitchingAccount'), true);
  const count = posted.length; run(`selectAccount('safe','fixture@example.invalid')`);
  assert.equal(posted.length, count);
  const html = fs.readFileSync(path.join(__dirname,'../src/AntigravityHub/wwwroot/index.html'),'utf8');
  assert.ok(!html.includes('set-autoreload') && !source.includes('autoReloadAntigravity'));
  // assert.ok(html.includes('取消后账号和任务保持不变')); // 图四冗余说明文字已按用户需求删除
});
check('25. Cancellation restores switch controls and displays a non-error result', () => {
  run('initApp()');
  webviewListeners.get('message')({data:{type:'switchResult',data:{success:false,cancelled:true,message:'已取消切换'}}});
  assert.equal(run('isSwitchingAccount'), false);
  assert.ok(document.body.children.at(-1).innerHTML.includes('已取消切换'));
  assert.ok(!document.body.children.at(-1).innerHTML.includes('text-[#A63E26]'));
});
check('26. Web and native tray use the same mandatory backend switching flow', () => {
  const host = fs.readFileSync(path.join(__dirname,'../src/AntigravityHub/MainWindow.xaml.cs'),'utf8');
  assert.ok(host.includes('await RunAccountSwitchAsync(accountId)'));
  assert.ok(host.includes('SwitchAccountFromTrayAsync(string targetAccountId) => RunAccountSwitchAsync(targetAccountId)'));
  assert.ok(!host.includes('GetProperty("restartIde"') && !host.includes('AutoReloadAntigravity'));
});
check('27. Closing settings applies a draft once and incoming refresh cannot replace edits',()=>{
  run("appSettings.currency='CNY';openSettingsModal();setSettingCurrency('USD');setSettingPollInterval(15)");
  webviewListeners.get('message')({data:{type:'settingsData',data:{currency:'CNY',pollIntervalSeconds:60}}});
  const before=posted.filter(x=>x.action==='saveSettings').length;run('closeSettingsModal();closeSettingsModal()');
  const saves=posted.filter(x=>x.action==='saveSettings');assert.equal(saves.length,before+1);assert.equal(saves.at(-1).settings.currency,'USD');assert.equal(saves.at(-1).settings.pollIntervalSeconds,15);
  assert.ok(!html.includes('保存配置')&&!html.includes('saveAndCloseSettings'));
});
check('28. Theme quick switch persists through an allowed dedicated action',()=>{
  document.documentElement.dataset.theme='light';run('toggleTheme()');assert.equal(posted.at(-1).action,'setTheme');assert.equal(posted.at(-1).theme,'dark');
  const policy=fs.readFileSync(path.join(__dirname,'../src/AntigravityHub/BrowserPolicy.cs'),'utf8');assert.ok(policy.includes('"setTheme"'));
});
check('29. Hotkey draft displays the newly recorded key before auto-apply',()=>{
  run("openSettingsModal();startRecordHotkey();handleHotkeyKeyDown({key:'b',altKey:true,preventDefault(){},stopPropagation(){}})");
  assert.equal(elements.get('hotkey-btn').innerText,'Alt + B');run('closeSettingsModal()');
});
check('30. Client HUD preference is preserved in a draft and applied on close',()=>{
  run("appSettings.enableClientHud=true;openSettingsModal()");
  assert.equal(el('set-hud').checked,true);el('set-hud').checked=false;
  webviewListeners.get('message')({data:{type:'settingsData',data:{enableClientHud:true}}});
  run('closeSettingsModal()');assert.equal(posted.filter(x=>x.action==='saveSettings').at(-1).settings.enableClientHud,false);
  assert.ok(html.includes('显示状态栏'));assert.ok(!html.includes('divide-[#EFE9DD]'));
});
check('31. A running process without credentials is not marked ready', () => {
  webviewListeners.get('message')({data:{type:'clientStatus',data:{isRunning:true,pid:123,credsFound:false}}});
  assert.equal(el('client-status-badge').innerText, '未找到凭据');
  assert.ok(el('client-status-badge').className.includes('amber'));
});
check('32. Native credentials enable import even when the client is closed', () => {
  webviewListeners.get('message')({data:{type:'clientStatus',data:{isRunning:false,credsFound:true,statusText:'登录凭据可读取'}}});
  assert.equal(el('client-status-badge').innerText, '可导入');
  assert.equal(el('client-status-text').innerText, '登录凭据可读取');
  assert.ok(el('client-status-dot').className.includes('emerald'));
});
check('33. Client import still reaches the existing native action', () => {
  run('importFromCurrentLogin()');
  assert.equal(posted.at(-1).action, 'importCurrentAccount');
});
check('34. UI and thinking translation default off and save independently', () => {
  run('appSettings.enableClientLocalization=false;appSettings.enableThinkingTranslation=false;openSettingsModal()');
  assert.equal(el('set-client-hans').checked,false);assert.equal(el('set-thinking-hans').checked,false);
  assert.equal(el('client-width').value,1400);assert.equal(el('client-height').value,900);
  assert.equal(el('set-tray').checked,true);assert.equal(el('set-start-min').checked,true);
  el('set-thinking-hans').checked=true;run('closeSettingsModal()');
  let saved=posted.filter(x=>x.action==='saveSettings').at(-1).settings;
  assert.equal(saved.enableClientLocalization,false);assert.equal(saved.enableThinkingTranslation,true);
  run('openSettingsModal()');el('set-thinking-hans').checked=false;el('set-client-hans').checked=true;run('closeSettingsModal()');
  saved=posted.filter(x=>x.action==='saveSettings').at(-1).settings;
  assert.equal(saved.enableClientLocalization,true);assert.equal(saved.enableThinkingTranslation,false);
  assert(html.indexOf('set-client-hans')<html.indexOf('theme-system'));
});
check('35. Custom dimensions save and invalid dimensions keep the settings editor open',()=>{
  run('openSettingsModal()');el('set-client-size').checked=true;el('client-width').value='1234';el('client-height').value='789';run('closeSettingsModal()');
  const saved=posted.filter(x=>x.action==='saveSettings').at(-1).settings;
  assert.equal(saved.clientWindowWidth,1234);assert.equal(saved.clientWindowHeight,789);assert.equal(saved.enableClientWindowSize,true);
  run('openSettingsModal()');el('client-width').value='1234.5';const before=posted.filter(x=>x.action==='saveSettings').length;run('closeSettingsModal()');
  assert.equal(posted.filter(x=>x.action==='saveSettings').length,before);assert(run('settingsDraft !== null'));
  el('client-width').value='1234';run('closeSettingsModal()');
});
check('36. Automatic component status works without installation controls', () => {
  run('initApp()');
  const handler = webviewListeners.get('message');
  assert.equal(typeof handler, 'function');
  handler({data:{type:'clientEnhancementStatus', message:'已就绪。'}});
  assert.equal(el('client-enhancement-status').innerText,'已就绪。');
  handler({data:{type:'clientEnhancementStatus', message:'已准备好，等待 Antigravity 退出后安装。'}});
  assert.ok(el('client-enhancement-status').innerText.includes('等待'));
});
check('37. Translation edits prompt only after the matching successful save',()=>{
  el('client-restart-modal').classList.add('hidden');
  run('pendingSettingsSave=null;appSettings.enableClientLocalization=false;appSettings.enableThinkingTranslation=false;openSettingsModal()');
  el('set-client-hans').checked=true;run('closeSettingsModal()');
  const save=posted.filter(x=>x.action==='saveSettings').at(-1);
  assert(el('client-restart-modal').classList.contains('hidden'));
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:'stale'}});
  assert(el('client-restart-modal').classList.contains('hidden'));
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:save.requestId,data:save.settings}});
  assert(!el('client-restart-modal').classList.contains('hidden'));
  assert.equal(posted.at(-1).isOpen,true);
  run('closeClientRestartPrompt()');assert.equal(posted.at(-1).isOpen,false);
  run('openSettingsModal()');el('set-thinking-hans').checked=true;run('closeSettingsModal()');
  const thought=posted.filter(x=>x.action==='saveSettings').at(-1);
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:thought.requestId,data:thought.settings}});
  assert(!el('client-restart-modal').classList.contains('hidden'));run('closeClientRestartPrompt()');
});
check('38. Unchanged, reverted and live settings do not ask for restart',()=>{
  run('openSettingsModal()');el('set-client-hans').checked=false;el('set-client-hans').checked=true;run('closeSettingsModal()');
  assert(el('client-restart-modal').classList.contains('hidden'));
  run('openSettingsModal()');el('client-width').value='1300';run('setSettingCurrency("CNY");closeSettingsModal()');
  const save=posted.filter(x=>x.action==='saveSettings').at(-1);
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:save.requestId,data:save.settings}});
  assert(el('client-restart-modal').classList.contains('hidden'));
});
check('39. Failed persistence cannot offer a restart for unsaved choices',()=>{
  run('openSettingsModal()');el('set-thinking-hans').checked=false;run('closeSettingsModal()');
  const save=posted.filter(x=>x.action==='saveSettings').at(-1);
  webviewListeners.get('message')({data:{type:'settingsSaveFailed',requestId:save.requestId}});
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:save.requestId}});
  assert(el('client-restart-modal').classList.contains('hidden'));assert.equal(run('pendingSettingsSave'),null);
});
check('40. Restart is explicit, single-flight and leaves a retry after failure',()=>{
  run('showClientRestartPrompt()');const before=posted.filter(x=>x.action==='restartAntigravityClient').length;
  run('restartAntigravityClient();restartAntigravityClient();closeClientRestartPrompt()');
  assert.equal(posted.filter(x=>x.action==='restartAntigravityClient').length,before+1);
  assert(!el('client-restart-modal').classList.contains('hidden'));assert.equal(el('client-restart-button').disabled,true);
  webviewListeners.get('message')({data:{type:'clientRestartResult',success:false,message:'请先保存'}});
  assert.equal(el('client-restart-message').innerText,'请先保存');assert.equal(el('client-restart-button').disabled,false);
  run('restartAntigravityClient()');webviewListeners.get('message')({data:{type:'clientRestartResult',success:true}});
  assert(el('client-restart-modal').classList.contains('hidden'));
});
check('41. Cross, backdrop and Escape share closing logic; labels are clean',()=>{
  assert(html.includes('思维链汉化'));assert(!html.includes('已显示的思考内容将发送至腾讯'));assert(!html.includes('汉化在重新打开 Antigravity'));
  assert(html.includes('if(event.target === this) closeSettingsModal()'));assert(html.includes('onclick="closeSettingsModal()"'));
  assert(source.includes('else closeSettingsModal();'));
  const policy=fs.readFileSync(path.join(__dirname,'../src/AntigravityHub/BrowserPolicy.cs'),'utf8');assert(policy.includes('"restartAntigravityClient"'));
});
check('42. Escape saves edits, shows the reminder and can dismiss it',()=>{
  run('openSettingsModal()');el('set-thinking-hans').checked=true;
  documentListeners.get('keydown')({key:'Escape'});
  assert.equal(run('settingsDraft'),null);
  const save=posted.filter(x=>x.action==='saveSettings').at(-1);
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:save.requestId,data:save.settings}});
  assert(!el('client-restart-modal').classList.contains('hidden'));
  documentListeners.get('keydown')({key:'Escape'});
  assert(el('client-restart-modal').classList.contains('hidden'));
});
check('43. Updates are opt-out on startup; settings persist the preference',()=>{
  el('hub-update-modal').classList.add('hidden');
  assert.equal(run('appSettings.checkUpdatesOnStartup'),true);
  run('openSettingsModal()');assert.equal(el('set-check-updates').checked,true);
  el('set-check-updates').checked=false;run('closeSettingsModal()');
  const save=posted.filter(x=>x.action==='saveSettings').at(-1);
  assert.equal(save.settings.checkUpdatesOnStartup,false);
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:save.requestId,data:save.settings}});
  assert(el('client-restart-modal').classList.contains('hidden'));
});
check('44. Available release prompts once; later retains a manual entry',()=>{
  const available={state:'available',currentVersion:'1.4.0',latestVersion:'1.4.1',message:'发现新版本',notes:'<img src=x onerror=alert(1)>'};
  webviewListeners.get('message')({data:{type:'hubUpdateStatus',data:available}});
  assert(!el('hub-update-modal').classList.contains('hidden'));
  assert.equal(el('hub-update-notes-text').innerHTML,'');
  assert.equal(el('hub-update-notes-text').innerText,available.notes);
  run('closeHubUpdatePrompt()');
  webviewListeners.get('message')({data:{type:'hubUpdateStatus',data:available}});
  assert(el('hub-update-modal').classList.contains('hidden'));
  assert(!el('hub-settings-update').classList.contains('hidden'));
  run('checkHubUpdates()');assert.equal(posted.at(-1).action,'checkHubUpdate');
  webviewListeners.get('message')({data:{type:'hubUpdateStatus',data:available}});
  assert(!el('hub-update-modal').classList.contains('hidden'));
});
check('45. Update installation is explicit and single-flight; busy dismissal is blocked; failure allows retry',()=>{
  const before=posted.filter(x=>x.action==='installHubUpdate').length;
  run('startHubUpdate();startHubUpdate();closeHubUpdatePrompt()');
  assert.equal(posted.filter(x=>x.action==='installHubUpdate').length,before+1);
  assert(!el('hub-update-modal').classList.contains('hidden'));
  webviewListeners.get('message')({data:{type:'hubUpdateStatus',data:{state:'downloading',progress:42,message:'正在下载更新…'}}});
  assert.equal(el('hub-update-progress-fill').style.width,'42%');assert.equal(el('hub-update-install').disabled,true);
  documentListeners.get('keydown')({key:'Escape'});assert(!el('hub-update-modal').classList.contains('hidden'));
  webviewListeners.get('message')({data:{type:'hubUpdateStatus',data:{state:'error',message:'校验失败，当前版本已保留'}}});
  assert.equal(el('hub-update-install').disabled,false);assert.equal(el('hub-update-message').innerText,'校验失败，当前版本已保留');
  run('closeHubUpdatePrompt()');assert(el('hub-update-modal').classList.contains('hidden'));
});
check('46. Edits are saved before handing off; failed saves prevent installation',()=>{
  run('showHubUpdatePrompt();openSettingsModal()');el('set-check-updates').checked=true;
  const before=posted.filter(x=>x.action==='installHubUpdate').length;
  run('startHubUpdate()');assert.equal(posted.filter(x=>x.action==='installHubUpdate').length,before);
  const save=posted.filter(x=>x.action==='saveSettings').at(-1);
  webviewListeners.get('message')({data:{type:'settingsSaved',requestId:save.requestId,data:save.settings}});
  assert.equal(posted.filter(x=>x.action==='installHubUpdate').length,before+1);
  webviewListeners.get('message')({data:{type:'hubUpdateStatus',data:{state:'error',message:'测试失败'}}});
  run('openSettingsModal()');el('set-check-updates').checked=false;run('startHubUpdate()');
  const failedSave=posted.filter(x=>x.action==='saveSettings').at(-1);
  webviewListeners.get('message')({data:{type:'settingsSaveFailed',requestId:failedSave.requestId}});
  assert.equal(posted.filter(x=>x.action==='installHubUpdate').length,before+1);
  assert.equal(el('hub-update-install').disabled,false);
});
check('47. Backend/frontend readiness is acknowledged once, after rendering live data',()=>{
  const before=posted.filter(x=>x.action==='hubUpdateReady').length;
  const handler=webviewListeners.get('message');
  handler({data:{type:'hubData',data:{accounts:[],stats:{dailyRecords:[],models:[]}}}});
  handler({data:{type:'hubData',data:{accounts:[],stats:{dailyRecords:[],models:[]}}}});
  assert.equal(posted.filter(x=>x.action==='hubUpdateReady').length,before+(before?0:1));
});
console.log(passed.map(x => 'PASS ' + x).join('\n'));
fs.writeFileSync(path.join(__dirname, 'frontend-regression-results.json'), JSON.stringify({ passed }, null, 2));

