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

vm.runInNewContext(engine, context);
const { translateStaticText, translateStaticAttributes, isProtected, translateUiValue } = context.harness;

function testUpdate2181Strings() {
  const examples = {
    'New Window': '新窗口',
    'Every command requires approval.': '每条命令都需要审核。',
    'Open in Built-in Browser': '在内置浏览器中打开',
    'Telemetry is disabled in Settings': '设置中已关闭遥测',
    'Conversation name': '对话名称',
    'Download SVG': '下载 SVG',
    'Close (Esc)': '关闭（Esc）',
    'Reset zoom (0)': '重置缩放（0）',
    'Search file contents...': '搜索文件内容...'
  };
  for (const [original, expected] of Object.entries(examples)) {
    assert.equal(translateUiValue(original), expected);
  }
  const prose = { nodeType: 1, tagName: 'P', closest: (selector) => selector.includes('.prose') ? prose : null };
  const userText = { nodeType: 3, nodeValue: 'New Window', parentElement: prose };
  translateStaticText(userText);
  assert.equal(userText.nodeValue, 'New Window', 'User text must remain unchanged');
  console.log('PASS: 2.19.1 interface strings translate without changing user text');
}

// -------------------------------------------------------------
// 1. Toast Positive & Negative Tests
// -------------------------------------------------------------
function testToastPositive() {
  const toastContainer = {
    nodeType: 1,
    tagName: 'DIV',
    closest(sel) {
      if (sel.includes('[data-sonner-toast]')) return toastContainer;
      return null;
    }
  };

  const p = {
    nodeType: 1,
    tagName: 'P',
    parentElement: toastContainer,
    closest(sel) {
      return toastContainer.closest(sel);
    }
  };

  const node1 = { nodeType: 3, nodeValue: 'View archived conversations in ', parentElement: p };
  const iconSpan = { nodeType: 1, tagName: 'SPAN', className: 'icon', firstChild: null, nextSibling: null };
  const linkText = { nodeType: 3, nodeValue: 'history', parentElement: null, nextSibling: null };
  iconSpan.nextSibling = linkText;

  const link = {
    nodeType: 1,
    tagName: 'A',
    getAttribute(attr) {
      if (attr === 'href') return 'notification://history';
      return null;
    },
    textContent: 'history',
    parentElement: p,
    firstChild: iconSpan
  };

  const node2 = { nodeType: 3, nodeValue: '.', parentElement: p };

  node1.nextSibling = link;
  link.nextSibling = node2;
  node2.nextSibling = null;

  translateStaticText(node1);

  assert.equal(node1.nodeValue, 'View archived conversations in ');
  assert.equal(linkText.nodeValue, 'history');
  assert.equal(iconSpan.className, 'icon', 'Nested icon element inside <a> must be preserved');
  assert.equal(node2.nodeValue, '.');
  console.log('PASS: [Toast DOM] Preload leaves notification markup to the source patch');
}

function testToastNegativeProseProtected() {
  const proseContainer = {
    nodeType: 1,
    tagName: 'DIV',
    className: 'prose',
    closest(sel) {
      if (sel.includes('.prose')) return proseContainer;
      return null;
    }
  };

  const p = {
    nodeType: 1,
    tagName: 'P',
    parentElement: proseContainer,
    closest(sel) {
      if (sel.includes('.prose')) return proseContainer;
      if (sel.includes('[data-sonner-toast]')) return proseContainer;
      return null;
    }
  };

  const node1 = { nodeType: 3, nodeValue: 'View archived conversations in ', parentElement: p };
  const linkText = { nodeType: 3, nodeValue: 'history', parentElement: null, nextSibling: null };
  const link = {
    nodeType: 1,
    tagName: 'A',
    getAttribute(attr) { return attr === 'href' ? 'notification://history' : null; },
    textContent: 'history',
    parentElement: p,
    firstChild: linkText
  };
  const node2 = { nodeType: 3, nodeValue: '.', parentElement: p };
  node1.nextSibling = link;
  link.nextSibling = node2;

  assert.equal(isProtected(node1), true, 'Node in prose must be protected');
  translateStaticText(node1);

  assert.equal(node1.nodeValue, 'View archived conversations in ', 'Prose content must NOT be touched');
  assert.equal(linkText.nodeValue, 'history', 'Link in prose must NOT be touched');
  assert.equal(node2.nodeValue, '.', 'Suffix in prose must NOT be touched');
  console.log('PASS: [Toast Negative - Prose] Protected prose remains 100% untouched');
}

function testToastNegativeBrokenStructure() {
  const toastContainer = {
    nodeType: 1,
    tagName: 'DIV',
    closest(sel) {
      if (sel.includes('[data-sonner-toast]')) return toastContainer;
      return null;
    }
  };

  const p = {
    nodeType: 1,
    tagName: 'P',
    parentElement: toastContainer,
    closest: (sel) => toastContainer.closest(sel)
  };

  // Case A: Missing link (only trailing plain text)
  const nodeA = { nodeType: 3, nodeValue: 'View archived conversations in ', parentElement: p };
  const brokenTail = { nodeType: 3, nodeValue: ' some other place.', parentElement: p };
  nodeA.nextSibling = brokenTail;

  translateStaticText(nodeA);
  assert.equal(nodeA.nodeValue, 'View archived conversations in ', 'Must not partially mutate to "可在 " on missing link');

  // Case B: Link exists, but missing trailing period
  const nodeB = { nodeType: 3, nodeValue: 'View archived conversations in ', parentElement: p };
  const linkB = {
    nodeType: 1,
    tagName: 'A',
    getAttribute: () => 'notification://history',
    textContent: 'history',
    parentElement: p,
    firstChild: { nodeType: 3, nodeValue: 'history' }
  };
  const wrongEnd = { nodeType: 3, nodeValue: ' unexpectedly!', parentElement: p };
  nodeB.nextSibling = linkB;
  linkB.nextSibling = wrongEnd;

  translateStaticText(nodeB);
  assert.equal(nodeB.nodeValue, 'View archived conversations in ', 'Must not mutate on unexpected end punctuation');
  assert.equal(linkB.firstChild.nodeValue, 'history', 'Link must remain untouched when structure fails');

  console.log('PASS: [Toast Negative - Structure] Zero partial mutation on broken toast structures');
}

// -------------------------------------------------------------
// 2. Model Effort & Trigger Attribute Tests
// -------------------------------------------------------------
function testModelEffort() {
  const triggerBtn = {
    nodeType: 1,
    tagName: 'BUTTON',
    attributes: { 'data-testid': 'model-selector-trigger' },
    textContent: 'Gemini 3.8 Flash High',
    closest(selector) {
      if (selector.includes('model-selector-trigger')) return triggerBtn;
      return null;
    }
  };

  const effortSpan = {
    nodeType: 1,
    tagName: 'SPAN',
    parentElement: triggerBtn,
    closest(selector) {
      if (selector.includes('model-selector-trigger')) return triggerBtn;
      return null;
    }
  };

  const efforts = [
    { in: ' High', out: ' 高' },
    { in: ' Medium', out: ' 中' },
    { in: ' Low', out: ' 低' },
    { in: ' Thinking', out: ' 思考' }
  ];

  for (const item of efforts) {
    const textNode = {
      nodeType: 3,
      nodeValue: item.in,
      parentElement: effortSpan
    };
    translateStaticText(textNode);
    assert.equal(textNode.nodeValue, item.out, `Effort translation failed for ${item.in}`);
  }

  // Negative test: Model name itself inside trigger must NOT be altered
  const modelNameNode = {
    nodeType: 3,
    nodeValue: 'Gemini 3.8 Flash',
    parentElement: triggerBtn
  };
  translateStaticText(modelNameNode);
  assert.equal(modelNameNode.nodeValue, 'Gemini 3.8 Flash', 'Model name node must remain untouched');

  // Negative test: button[data-testid="model-selector-trigger"] must NOT be whitelisted in isProtected
  assert.equal(isProtected(triggerBtn), false, 'Trigger itself is chrome, not protected whitelist');

  console.log('PASS: [Model Effort] Accurate effort translation with model name protection');
}

function testModelAriaLabel() {
  const cases = [
    { in: 'Select model, current: Gemini 3.8 Flash High', out: '选择模型，当前：Gemini 3.8 Flash 高' },
    { in: 'Select model, current: Claude 3.7 Sonnet Thinking', out: '选择模型，当前：Claude 3.7 Sonnet 思考' },
    { in: 'Select model, current: GPT-4o Medium', out: '选择模型，当前：GPT-4o 中' },
    { in: 'Select model, current: Claude 3.5 Haiku Low', out: '选择模型，当前：Claude 3.5 Haiku 低' },
    { in: 'Select model, current: Gemini 3.8 Flash', out: '选择模型，当前：Gemini 3.8 Flash' }
  ];

  for (const c of cases) {
    const attrs = {
      'data-testid': 'model-selector-trigger',
      'aria-label': c.in
    };
    const el = {
      tagName: 'BUTTON',
      getAttribute: (k) => attrs[k] || null,
      setAttribute: (k, v) => { attrs[k] = v; },
      matches: (selector) => selector === 'button[data-testid="model-selector-trigger"]',
      closest: () => null
    };
    translateStaticAttributes(el);
    assert.equal(attrs['aria-label'], c.out, `Aria label translation failed for ${c.in}`);
  }
  console.log('PASS: [Model Aria Label] Structured regex translation preserving effort and base name');
}

// -------------------------------------------------------------
// 3. Archived Chat Banner & Generic Class Tests
// -------------------------------------------------------------
function testArchivedChatBanner() {
  const banner = {
    nodeType: 1,
    tagName: 'DIV',
    closest(sel) {
      if (sel.includes('[data-testid="archived-chat-banner"]')) return banner;
      return null;
    }
  };

  const textNode = {
    nodeType: 3,
    nodeValue: 'This chat is archived.',
    parentElement: banner
  };
  translateStaticText(textNode);
  assert.equal(textNode.nodeValue, '此对话已归档。');

  const btnNode = {
    nodeType: 3,
    nodeValue: 'Restore',
    parentElement: banner
  };
  translateStaticText(btnNode);
  assert.equal(btnNode.nodeValue, '恢复');

  // Negative test: Generic div.bg-muted.border without testid inside prose must NOT be modified
  const proseDiv = {
    nodeType: 1,
    tagName: 'DIV',
    className: 'bg-muted border rounded-2xl prose',
    closest(sel) {
      if (sel.includes('.prose')) return proseDiv;
      return null;
    }
  };
  const unadornedNode = {
    nodeType: 3,
    nodeValue: 'This chat is archived.',
    parentElement: proseDiv
  };
  translateStaticText(unadornedNode);
  assert.equal(unadornedNode.nodeValue, 'This chat is archived.', 'Unscoped generic class card in prose must NOT be mutated');

  console.log('PASS: [Archived Banner] Scoped testid translation without overbroad Tailwind whitelist');
}

// -------------------------------------------------------------
// 4. Artifact Scoping & Dictionary Consistency Tests
// -------------------------------------------------------------
function testArtifactScoping() {
  const header = {
    nodeType: 1,
    tagName: 'DIV',
    closest(sel) {
      if (sel.includes('div[aria-label*="Header"]')) return header;
      return null;
    }
  };
  const headerSpan = {
    nodeType: 1,
    tagName: 'SPAN',
    className: 'truncate',
    parentElement: header,
    matches: (sel) => sel === 'span.truncate',
    closest: (sel) => header.closest(sel)
  };
  const headerNode = {
    nodeType: 3,
    nodeValue: 'Artifact',
    parentElement: headerSpan
  };
  translateStaticText(headerNode);
  assert.equal(headerNode.nodeValue, 'Artifact', 'Preload must leave Artifact titles to the source patch');

  const fileNameNode = { nodeType: 3, nodeValue: 'Artifact', parentElement: { nodeType: 1, tagName: 'SPAN', closest: () => null } };
  translateStaticText(fileNameNode);
  assert.equal(fileNameNode.nodeValue, 'Artifact', 'User-named file must not be changed');

  // Negative test: user message with "Artifact" in prose
  const proseP = {
    nodeType: 1,
    tagName: 'P',
    closest(sel) {
      if (sel.includes('.prose')) return proseP;
      return null;
    }
  };
  const proseNode = {
    nodeType: 3,
    nodeValue: 'Artifact',
    parentElement: proseP
  };
  translateStaticText(proseNode);
  assert.equal(proseNode.nodeValue, 'Artifact', 'User text Artifact in prose must NOT be modified');

  // Terminology check in overrides
  const overrides = JSON.parse(fs.readFileSync(path.join(root, 'ui_overrides.json'), 'utf8'));
  assert.equal(overrides['Artifact'], undefined, 'Artifact must not be a global dictionary entry');
  assert.equal(overrides['Artifact Review Policy'], '成果审核策略');
  console.log('PASS: [Artifact Scoping] Header translation scoped and terminology unified to 成果');
}

// -------------------------------------------------------------
// 5. Bundle Patch Decoupling & Resilience Tests
// -------------------------------------------------------------
function testBundlePatchDecoupling() {
  const { patchBundle, STRUCTURAL_MARKERS, TEXT_MARKERS, MARKERS } = require(path.join(root, 'bundle_patch.js'));

  // Test A: Clean bundle with all markers
  const dummyBundle = MARKERS.flatMap((m) => Array(m.expectedCount || 1).fill(m.from)).join('\n/* --- */\n');
  const resultA = patchBundle(dummyBundle);
  assert.equal(resultA.applied, true);
  assert.equal(resultA.structuralApplied, true);
  assert.equal(resultA.skippedTextMarkers.length, 0);
  assert(resultA.source.includes('可在 [历史](notification://history) 中查看已归档对话。'));
  assert(resultA.source.includes('此对话已归档。'));
  assert(resultA.source.includes('正在创建终端...'));
  assert.equal(resultA.source.split('z.createElement(KZ,{text:"成果"})').length - 1, 2);

  // Test B: Resilience test - text marker missing, structural markers intact
  const bundleWithoutTextMarker = STRUCTURAL_MARKERS.map((m) => m.from).join('\n/* --- */\n');
  const resultB = patchBundle(bundleWithoutTextMarker);
  assert.equal(resultB.applied, true, 'Bundle should succeed even if text markers are missing');
  assert.equal(resultB.structuralApplied, true, 'Structural markers must remain applied');
  assert.equal(resultB.skippedTextMarkers.length, TEXT_MARKERS.length);
  assert.equal(resultB.skippedTextMarkers[0].reason, 'Not found');

  // Test C: Safety test - critical structural marker missing, safe abort without partial replacement
  const corruptedBundle = dummyBundle.replace(STRUCTURAL_MARKERS[0].from, 'CORRUPTED_MARKER');
  const resultC = patchBundle(corruptedBundle);
  assert.equal(resultC.applied, false, 'Missing structural marker must safely reject patch');
  assert.equal(resultC.structuralApplied, false);
  assert.equal(resultC.source, corruptedBundle, 'Must return original source untouched');

  console.log('PASS: [Bundle Patch] Decoupled structural and text markers with failure resilience');
}

testToastPositive();
testToastNegativeProseProtected();
testToastNegativeBrokenStructure();
testModelEffort();
testModelAriaLabel();
testArchivedChatBanner();
testArtifactScoping();
testBundlePatchDecoupling();
testUpdate2181Strings();

console.log('\n========================================');
console.log('ALL UNIT & NEGATIVE TESTS PASSED (100%)');
console.log('========================================\n');
