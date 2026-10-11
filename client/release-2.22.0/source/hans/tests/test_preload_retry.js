'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = fs.existsSync(path.join(__dirname, 'rewrite')) ? path.join(__dirname, 'rewrite') : path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'hans-preload.js'), 'utf8').replace('__UI_DICT_JSON__', '{}').replace(/\}\)\(\);\s*$/, 'globalThis.harness={scan,dispatch};})();');

function fixture(inputs, failFirst) {
  let now = 0, timerId = 0, calls = 0, css = 0;
  const timers = new Map();
  const batches = [];
  const text = (value) => ({ nodeType: 3, nodeValue: value, isConnected: true });
  const blocks = inputs.map((input) => ({ childNodes: [text(input)], isConnected: true, closest: () => null, querySelector: () => null }));
  const body = { querySelectorAll: () => blocks };
  const trigger = { firstElementChild: { tagName: 'SPAN', childNodes: [text('Thought for 5s')], textContent: 'Thought for 5s' }, parentElement: { querySelector: () => body }, getAttribute: () => null, setAttribute() {} };
  const context = {
    process: {}, window: {}, console,
    Date: { now: () => now },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    MutationObserver: class { observe() {} },
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [trigger] },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (callback, milliseconds) => { const id = ++timerId; timers.set(id, { callback, due: now + milliseconds }); return id; },
    clearTimeout: (id) => timers.delete(id),
    require: () => ({
      webFrame: { insertCSS: () => css++ },
      contextBridge: { exposeInMainWorld: (name, api) => context.window[name] = api },
      ipcRenderer: { invoke: async (_, batch) => {
        calls++; batches.push(batch);
        return failFirst && calls === 1 ? batch.map(() => null) : batch.map(() => '翻译完成。');
      } }
    })
  };
  vm.runInNewContext(engine, context);
  async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async function advance(until) {
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].due; next[1].callback(); await flush();
    }
    now = until; await flush();
  }
  return { context, blocks, batches, flush, advance, calls: () => calls, css: () => css };
}

(async () => {
  const retry = fixture(['An unchanged paragraph should retry without DOM mutations.'], true);
  retry.context.harness.scan();
  assert.equal(retry.css(), 0, 'No CSS should hide pending paragraphs');
  assert.equal(retry.blocks[0].childNodes[0].nodeValue, 'An unchanged paragraph should retry without DOM mutations.');
  await retry.flush();
  assert.equal(retry.calls(), 1);
  await retry.advance(7200);
  assert.equal(retry.calls(), 2, 'Quiet DOM must still retry after a service failure');
  assert.equal(retry.blocks[0].childNodes[0].nodeValue, '翻译完成。');
  const large = fixture(Array.from({ length: 30 }, (_, index) => 'Paragraph ' + index + ' ' + 'x'.repeat(3000)), false);
  large.context.harness.scan(); await large.flush();
  assert(large.batches.length >= 2);
  assert(large.batches.every((batch) => batch.length <= 30 && batch.reduce((sum, value) => sum + value.length, 0) <= 60000));
  console.log(JSON.stringify({ passed: true, noBlank: retry.css() === 0, automaticRetryCalls: retry.calls(), largeBatches: large.batches.map((batch) => batch.length) }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
