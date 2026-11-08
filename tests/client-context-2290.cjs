'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildPortableUiSource } = require('../client/maintenance/tools/portable-ui.cjs');
const hans = path.resolve(__dirname, '../client/release-2.22.0/source/hans');
const dictionary = { ...require(path.join(hans, 'ui_dictionary.json')), ...require(path.join(hans, 'ui_overrides.json')) };
const versionDictionary = path.join(hans, 'ui-overrides-2290.json');
if (fs.existsSync(versionDictionary)) Object.assign(dictionary, require(versionDictionary));
const native = '(()=>{const process={isMainFrame:true}, HUB_OPTIONS={appVersion:"2.29.0",localization:true,thinking:false};' +
  'const require=()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke(){throw Error("No network in this test");}}});' +
  fs.readFileSync(path.join(hans, 'hans-preload.js'), 'utf8').replace('__UI_DICT_JSON__', () => JSON.stringify(dictionary)) + '})();';

// Fixtures mirror the native React children. In particular, the search term is a separate mutable text node.
const fixture = [
  '<html lang="en"><body><div data-testid="sidecar-list-empty"><p id="empty"></p></div><p id="search" data-testid="sidecar-list-empty"></p>',
  '<div data-testid="home-greeting"><h1 id="greet">Hi $&amp;Settings, what can we get done today?</h1></div>',
  '<div class="space-y-2"><h3 id="plan">Plan</h3><div>Your Plan: BASIC</div></div><div id="other-plan">Plan</div>',
  '<div class="space-y-2"><h3 id="chat">Chat</h3><span>Conversation Steps</span></div>',
  '<section data-testid="automation-instructions"><h2 id="detail-heading">Instructions</h2></section>',
  '<div data-testid="new-sidecar-modal"><section><h2 id="form-heading">说明</h2><textarea data-testid="new-sidecar-prompt"></textarea></section></div>',
  '<span id="timing" data-testid="automation-next-run">Next run on November 21 around 2:05 PM PST</span>',
  '<span id="prior" data-testid="automation-last-run"><span title="Settings">Yesterday 12:05 AM</span></span>',
  '<span id="summary" data-testid="new-sidecar-summary">Weekdays at 9:00 AM PST · This computer</span>',
  '<span id="schedule" data-testid="automation-schedule-value">Monthly on the 23rd at 9:00 AM and 5:30 PM</span>',
  '<div data-testid="automation-schedule-editor"><div class="flex flex-wrap items-center gap-2 text-sm"><button data-testid="schedule-repeat">Every day</button><span id="daily-at" class="text-muted-foreground select-none">at</span><button data-testid="schedule-time" value="9:0"><span>9:00 AM</span></button><span data-testid="schedule-timezone" title="America/Los_Angeles">GMT-8</span></div></div>',
  '<div data-testid="automation-schedule-editor"><div><button data-testid="schedule-repeat">Every week</button><span id="weekly-on" class="text-muted-foreground select-none">于</span><button data-testid="schedule-weekday" value="1"><span>Monday</span></button><span id="weekly-at" class="text-muted-foreground select-none">at</span><button data-testid="schedule-time" value="14:30"><span>2:30 PM</span></button></div>',
  '<div data-testid="schedule-custom"><span id="custom-on" class="text-muted-foreground select-none">on</span><div role="group" aria-label="Days"><button value="1" aria-pressed="true" aria-label="Monday">M</button></div></div></div>',
  '<span id="other-at" class="text-muted-foreground select-none">at</span>',
  '<div data-testid="conversation-view"><div data-testid="agent-input-box"><p id="hint" class="pointer-events-none absolute">Ask anything, @ to mention, / for actions</p><div contenteditable="true">Ask anything, @ to mention, / for actions</div></div></div>',
  '<textarea id="prompt" data-testid="schedule-editor-prompt" placeholder="What should the agent do on each run?">No</textarea>',
  '<ol data-testid="new-sidecar-steps" aria-label="Steps"></ol>',
  ...['transcript-line-text','voice-picker-name','notebook-viewer','browser-url-display','branch-pill-label','automation-name',
    'automation-instructions-markdown','new-sidecar-cloud-identity-option'].map(id => '<div data-testid="'+id+'"><span title="Settings" class="private">Settings</span></div>'),
  '<div class="prose"><div data-testid="home-greeting"><h1 id="fake">What can we get done today?</h1></div></div></body></html>'
].join('');

async function check(context, mode) {
  const page = await context.newPage();
  try {
    await page.goto('https://127.0.0.1:32889/');
    await page.evaluate(() => {
      document.getElementById('empty').append('No ', 'automations', ' yet');
      document.getElementById('search').append('No ', 'scheduled tasks', ' match “', 'No', '”.');
      window.queryNode = document.getElementById('search').childNodes[3];
    });
    await page.evaluate(mode === 'portable' ? buildPortableUiSource() : native);
    const value = id => page.locator('#' + id).textContent();
    for (const [id, expected] of Object.entries({
      empty:'暂无自动化任务', search:'没有定时任务与“No”匹配', greet:'你好，$&Settings！今天想一起做点什么？',
      plan:'套餐', 'other-plan':dictionary.Plan, chat:'对话', 'detail-heading':'任务指令', 'form-heading':'任务指令',
      timing:'下次运行：11月21日 14:05 左右 PST', prior:'昨天 00:05',
      'daily-at':'','weekly-on':'','weekly-at':'','custom-on':'','other-at':'at',
      summary:'工作日 09:00 PST · 此电脑', schedule:'每月23日 09:00、17:30',
      hint:'想问什么都可以，@ 引用，/ 执行动作', fake:'What can we get done today?'
    })) assert.equal(await value(id), expected, mode + ' ' + id);
    assert(await page.locator('.private').evaluateAll(nodes => nodes.every(node => node.textContent === 'Settings' && node.title === 'Settings')));
    assert.equal(await page.locator('#prior span').getAttribute('title'), 'Settings');
    assert.deepEqual(await page.getByTestId('schedule-time').evaluateAll(nodes => nodes.map(n => n.value)), ['9:0','14:30']);
    assert.equal(await page.getByTestId('schedule-weekday').getAttribute('value'), '1');
    assert.equal(await page.getByTestId('schedule-timezone').getAttribute('title'), 'America/Los_Angeles');
    assert.equal(await page.getByTestId('schedule-timezone').textContent(), 'GMT-8');
    assert.equal(await page.locator('[aria-pressed]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('new-sidecar-steps').getAttribute('aria-label'), '步骤');
    assert.equal(await page.locator('#prompt').inputValue(), 'No');
    assert.match(await page.locator('#prompt').getAttribute('placeholder'), /智能体/);
    assert.equal(await page.locator('[contenteditable]').textContent(), 'Ask anything, @ to mention, / for actions');
    await page.evaluate(() => {
      window.queryNode.nodeValue = 'Settings';
      document.getElementById('greet').firstChild.nodeValue = 'What can we get done today?';
      document.getElementById('summary').firstChild.nodeValue = 'Step 2 of 3';
      document.getElementById('hint').firstChild.nodeValue = 'Settings'; // supplied by a custom agent
    });
    assert.equal(await value('search'), '没有定时任务与“Settings”匹配');
    assert.equal(await value('greet'), '今天想一起做点什么？');
    assert.equal(await value('summary'), '第 2 步，共 3 步');
    assert.equal(await value('hint'), 'Settings');
    if (mode === 'portable') {
      await page.evaluate(buildPortableUiSource(false));
      assert.deepEqual(await page.locator('#search').evaluate(el => Array.from(el.childNodes, n => n.nodeValue)), ['No ','scheduled tasks',' match “','Settings','”.']);
      assert.equal(await value('empty'), 'No automations yet');
      assert.equal(await value('greet'), 'What can we get done today?');
      assert.equal(await value('summary'), 'Step 2 of 3');
      assert.equal(await value('daily-at'), 'at');
      assert.equal(await value('weekly-on'), '于');
      assert.equal(await value('custom-on'), 'on');
      assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'What should the agent do on each run?');
      assert(await page.evaluate(() => document.documentElement.lang === 'en' && document.getElementById('search').childNodes[3] === window.queryNode));
    }
  } finally { await page.close(); }
}

async function checkScopedTemplates(context) {
  const page = await context.newPage();
  try {
    await page.goto('https://127.0.0.1:32889/');
    await page.evaluate(() => { document.body.innerHTML = [
      '<div data-testid="known-panel"><div data-testid="nested"><p id="scoped">Inspect fixture: $&amp;</p></div></div>',
      '<p id="outside">Inspect fixture: $&amp;</p><div class="prose" data-testid="known-panel"><p id="private">Inspect fixture: $&amp;</p></div>',
      '<button id="specific" data-testid="known-panel" title="Inspect fixture: $&amp;" aria-label="Inspect fixture: $&amp;"></button>',
      '<button id="generic" title="Inspect fixture: $&amp;"></button><span id="noncontrol" title="Inspect fixture: $&amp;"></span>',
      '<div data-testid="notebook-viewer"><button id="private-attr" title="Inspect fixture: $&amp;"></button></div>'
    ].join(''); });
    const scoped = (scope, label) => ({parts:['Inspect fixture: ',''],translated:[label,''],scope});
    const memory = {entries:{},templates:[],scopedTemplates:[
      scoped({testId:'known-panel'},'控件文字：'), scoped({attribute:'title'},'通用标题：'),
      scoped({testId:'known-panel',attribute:'title'},'专用标题：')
    ]};
    await page.evaluate(buildPortableUiSource(true, memory));
    assert.equal(await page.locator('#scoped').textContent(), '控件文字：$&');
    for (const id of ['outside','private']) assert.equal(await page.locator('#'+id).textContent(), 'Inspect fixture: $&');
    for (const [id,expected] of Object.entries({specific:'专用标题：$&',generic:'通用标题：$&',noncontrol:'Inspect fixture: $&','private-attr':'Inspect fixture: $&'})) {
      assert.equal(await page.locator('#'+id).getAttribute('title'), expected);
    }
    assert.equal(await page.locator('#specific').getAttribute('aria-label'), 'Inspect fixture: $&');
    await page.locator('#specific').evaluate(node => node.title = 'Inspect fixture: Settings');
    await page.waitForFunction(() => document.getElementById('specific').title === '专用标题：Settings');
    await page.evaluate(buildPortableUiSource(false));
    assert.equal(await page.locator('#specific').getAttribute('title'), 'Inspect fixture: Settings');
    assert.equal(await page.locator('#scoped').textContent(), 'Inspect fixture: $&');
  } finally { await page.close(); }
}

async function checkPublishedScopes(context) {
  const page = await context.newPage();
  try {
    await page.goto('https://127.0.0.1:32889/');
    await page.evaluate(() => { document.body.innerHTML = [
      '<div data-testid="media-modal-video-controls"><button id="speed" aria-label="Playback speed 1.25x"></button></div>',
      '<button id="other-speed" aria-label="Playback speed 1.25x"></button>',
      '<section data-testid="voice-picker"><h2 id="voice">Choose Settings\'s Voice</h2></section>',
      '<button id="download" data-testid="webview-download-show-in-folder" aria-label="Show $&amp;.txt in folder"></button>',
      '<div data-testid="notebook-viewer"><button data-testid="webview-download-show-in-folder" id="guest" aria-label="Show $&amp;.txt in folder"></button></div>'
    ].join(''); });
    await page.evaluate(buildPortableUiSource());
    assert.equal(await page.locator('#voice').textContent(), '选择Settings的声音');
    for (const [id,expected] of Object.entries({speed:'播放速度 1.25 倍','other-speed':'Playback speed 1.25x',download:'在文件夹中显示$&.txt',guest:'Show $&.txt in folder'})) {
      assert.equal(await page.locator('#'+id).getAttribute('aria-label'), expected);
    }
    await page.evaluate(buildPortableUiSource(false));
    assert.equal(await page.locator('#speed').getAttribute('aria-label'), 'Playback speed 1.25x');
    assert.equal(await page.locator('#download').getAttribute('aria-label'), 'Show $&.txt in folder');
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url() === 'https://127.0.0.1:32889/' ?
      route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}) : route.abort());
    await check(context, 'native');
    await check(context, 'portable');
    await checkScopedTemplates(context);
    await checkPublishedScopes(context);
    console.log('PASS: native and portable 2.29 controls, scoped template boundaries, literal user values, React updates and reversible fallback.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
