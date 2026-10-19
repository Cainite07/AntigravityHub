'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'ui_dictionary.json'), 'utf8'));
Object.assign(dictionary, JSON.parse(fs.readFileSync(path.join(root, 'ui_overrides.json'), 'utf8')));

const engine = fs.readFileSync(path.join(root, 'hans-preload.js'), 'utf8')
  .replace('__UI_DICT_JSON__', JSON.stringify(dictionary))
  .replace(/\}\)\(\);\s*$/, 'globalThis.harness={translateStaticText,translateStaticAttributes,isProtected,translateUiValue};})();');

const context = {
  HUB_OPTIONS: { localization: true, thinking: false },
  process: {},
  window: {},
  console,
  Date: { now: () => 0 },
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  MutationObserver: class { observe() {} },
  document: { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [] },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  require: () => ({
    webFrame: { insertCSS: () => {} },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: async () => [] }
  })
};

assert(!/\.classList\.(?:add|remove|toggle)|insertCSS|\.style[.\[]|\.className\s*=|\.innerHTML\s*=|appendChild|replaceChild/.test(engine),
  'Localization may replace text and accessible labels only; native styles and structure must stay intact');
vm.runInNewContext(engine, context);
const { translateStaticText, translateStaticAttributes, isProtected, translateUiValue } = context.harness;

function testUpdatedNativeArchiveLayouts() {
  const pairs = {
    'This page is going away soon': '此页面即将停用',
    'Search conversations with': '搜索对话请点击',
    'in the top left.': '（位于左上角）。',
    'View archived in the sidebar': '查看已归档对话请打开侧边栏的',
    'menu)': '菜单）', '(': '（', '.': '。',
    'This chat is archived.': '此对话已归档。', 'Restore': '恢复'
  };
  for (const protectedKind of [null, '.prose', '[data-plugin-content]', '[data-hans-external-content]', 'pre']) {
    for (const [original, expected] of Object.entries(pairs)) {
      const archived = original === 'This chat is archived.' || original === 'Restore';
      const card = { querySelector: selector => selector === 'span.font-medium.text-foreground'
        ? { textContent: 'This page is going away soon' } : {} };
      const element = { matches: () => false, closest(selector) {
        if (protectedKind && selector.includes(protectedKind)) return {};
        if (selector === '[data-testid="conversation-view"]') return archived ? {} : null;
        if (archived && selector.startsWith('div.relative.flex.items-center.justify-center')) return card;
        if (!archived && selector === 'div.flex.flex-col.gap-0\\.5.text-secondary-foreground') return card;
        return null;
      }};
      const node = { nodeType: 3, nodeValue: original, parentElement: element };
      translateStaticText(node);
      assert.equal(node.nodeValue, protectedKind || !context.HUB_OPTIONS.localization ? original : expected, `${protectedKind}: ${original}`);
    }
  }
  // Ordinary titles and unmarked Restore buttons must retain their original text.
  for (const original of Object.keys(pairs)) {
    const node = { nodeType: 3, nodeValue: original, parentElement: { closest: selector => selector.includes('[data-testid="conversation-view"]') ? {} : null, matches: () => false } };
    translateStaticText(node);
    assert.equal(node.nodeValue, original);
  }
  console.log('PASS: updated native history/archive layouts; conversation, plugin, code and unscoped text protected');
}

function testModelAndNotificationChrome() {
  assert.equal(translateUiValue('Gemini 4 Argon Weekly Limit'), 'Gemini 4 Argon 每周额度');
  assert.equal(translateUiValue('Gemini 4 Argon Weekly Limit Remaining'), 'Gemini 4 Argon 每周剩余额度');
  for (const protectedKind of [null, '.prose', '[data-plugin-content]', 'pre']) {
    const classes=new Set();
    const element={matches:()=>true, parentElement:{querySelector:()=>({})},
      classList:{contains:x=>classes.has(x),add:x=>classes.add(x)}, closest(selector) {
        return protectedKind && selector.includes(protectedKind) ? {} : null;
      }};
    const node={nodeType:3,nodeValue:'New',parentElement:element};
    translateStaticText(node);
    assert.equal(node.nodeValue,protectedKind?'New':'新增');
    assert.equal(classes.size,0,'Translation must preserve native classes and opacity');
    if(!protectedKind){translateStaticText(node);assert.equal(node.nodeValue,'新增');}
  }
  for (const [original,expected] of Object.entries({'View archived in the sidebar (':'可在侧边栏的（','menu).':'菜单）中查看已归档对话。'})) {
    for(const notification of [true,false]) {
      const element={matches:()=>false,closest(selector) {
        if(selector==='p')return {querySelector:()=>null};
        if(selector.startsWith('[role="region"]'))return notification?{}:null;
        if(selector.includes('.prose'))return {};
        return null;
      }};
      const node={nodeType:3,nodeValue:original,parentElement:element};
      translateStaticText(node);assert.equal(node.nodeValue,notification?expected:original);
      translateStaticAttributes({...element,nodeType:1,getAttribute:()=>null});
    }
  }
  console.log('PASS: Argon quota text, contextual new-model badge with native styling, native Markdown notification and protected user/plugin content.');
}
testUpdatedNativeArchiveLayouts();
testModelAndNotificationChrome();
context.HUB_OPTIONS.localization = false;
testUpdatedNativeArchiveLayouts();
