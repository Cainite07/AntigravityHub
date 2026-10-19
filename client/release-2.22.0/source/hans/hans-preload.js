/* Bundled into the official preload by installer.py. No local require() here:
   Antigravity's renderer is sandboxed and only Electron's preload API is present. */
(() => {
  'use strict';
  if (process.isMainFrame === false) return;
  if (window.__antigravityHans23) return;
  window.__antigravityHans23 = true;

  const { ipcRenderer, contextBridge } = require('electron');
  const options = typeof HUB_OPTIONS === 'object' ? HUB_OPTIONS : {localization:false,thinking:false};
  const UI_DICT = __UI_DICT_JSON__;
  const UI_LOWER = new Map(Object.entries(UI_DICT).map(([key, value]) => [key.toLowerCase(), value]));
  const CHROME_TEXT = new Set(['No subagents', 'No file changes', 'No artifacts generated',
    'No active terminals', 'Skills Used', 'No changes to review', 'Project + Worktree',
    'Workspace + Worktree', 'Only Unread', 'Limited time', 'Maximize Pane',
    'Restore Pane', 'New Terminal']);
  const TRIGGER = 'button[data-testid="thinking-collapsible-trigger"]';
  const CACHE_PREFIX = 'hans21-2191:';
  const CACHE_ORDER = 'hans21-2191:order';
  const PROTECTED = 'script,style,pre,code,kbd,samp,textarea,[contenteditable="true"],div.font-mono.leading-relaxed,[data-hans-external-content]';
  // Reviewed 2.22.0 customization layouts. Only their content fields are
  // protected; category headings, client buttons and empty notes stay localizable.
  const EXTERNAL_FIELDS = [
    '[data-testid="doc-row-modal"]', '[data-testid="hook-row-modal"]',
    'plugin-card', '[data-plugin-content]',
    '.relative.flex.items-center.gap-3.p-3.rounded-xl .flex-1.min-w-0.flex-col',
    '.flex.items-baseline.gap-2\\.5.min-w-0 > span:first-child',
    '.flex.items-baseline.gap-2\\.5.min-w-0 > span[title]',
    'h1.text-lg.font-medium.tracking-tight.leading-tight.text-foreground.truncate',
    '.w-full.px-4.pb-4.pt-1 p.text-sm.text-muted-foreground.leading-relaxed'
  ].join(',');
  function isExternalField(element) { return !!element?.closest(EXTERNAL_FIELDS); }
  function isConversationChrome(element) {
    if (!element?.closest('[data-testid="conversation-view"]') ||
        element.closest(PROTECTED + ',.prose,.markdown,[data-testid="user-input-step"]') || isExternalField(element)) return false;
    return element.matches('h1.sr-only,span[data-screenshot-volatile][data-tooltip-id].text-xs.text-muted-foreground.select-none.whitespace-nowrap') ||
      element.matches('button[aria-disabled][aria-label^="Load older messages"],button[aria-disabled][aria-label^="No more older messages"]') ||
      (element.matches('button[data-tooltip-id]') && /^(Copy|Copied|Good response|Bad response|复制|已复制|好评|差评)$/.test(element.getAttribute('aria-label') || ''));
  }

  const state = new WeakMap();
  const pending = new WeakSet();
  const cache = new Map();
  const retries = new Map();
  const statistics = { requests: 0, translated: 0, failures: 0, uiRequests: 0, uiTranslated: 0, uiFailures: 0 };
  let scanScheduled = false;
  let retryTimer = null;
  let retryWakeAt = Infinity;

  try {
    contextBridge.exposeInMainWorld('antigravityHansStatus', {
      get: () => ({ version: 23, appVersion: options.appVersion || '2.22.0', ...statistics }),
      bundle: () => ipcRenderer.invoke('hans:status')
    });
  } catch {}

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16) + ':' + text.length;
  }

  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
  }

  function getCached(key) {
    if (cache.has(key)) {
      const value = cache.get(key);
      remember(key, value);
      return value;
    }
    try {
      const stored = sessionStorage.getItem(CACHE_PREFIX + hash(key));
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      if (parsed.q !== key || typeof parsed.t !== 'string') return null;
      remember(key, parsed.t);
      return parsed.t;
    } catch {
      return null;
    }
  }

  function setCached(key, value) {
    remember(key, value);
    try {
      const storageKey = CACHE_PREFIX + hash(key);
      sessionStorage.setItem(storageKey, JSON.stringify({ q: key, t: value }));
      const order = JSON.parse(sessionStorage.getItem(CACHE_ORDER) || '[]');
      const old = order.indexOf(storageKey);
      if (old >= 0) order.splice(old, 1);
      order.push(storageKey);
      while (order.length > 240) sessionStorage.removeItem(order.shift());
      sessionStorage.setItem(CACHE_ORDER, JSON.stringify(order));
    } catch {}
  }

  function isProtected(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return true;
    if (element.closest(PROTECTED) || isExternalField(element)) return true;
    if (element.closest('[data-testid="agent-input-box"] p.pointer-events-none.absolute')) return false;
    if (element.closest('[data-testid="conversation-view"],[data-testid="conversation-row-sidebar"]')) return true;
    if (element.closest('.cursor-edit,.prose,.markdown,[data-testid="user-input-step"],[data-testid="agent-turn"]')) return true;
    return false;
  }

  // Only reviewed built-in server UI fields can use the existing translator.
  // User messages, skills and custom model names never enter this queue.
  const NOTICE_FIELD = '[data-hans-ui-notice-field]';
  const noticeQueue = new Set();
  const noticeCache = new Map();
  const noticeFailures = new Map();
  let noticeTimer = null;
  let noticeRunning = false;

  function noticeDate(value) {
    const match = value.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/);
    if (!match) return null;
    const months = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
      July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
    const month = months[match[1]], day = Number(match[2]), year = Number(match[3]);
    return month && day >= 1 && day <= new Date(year, month, 0).getDate()
      ? year + ' 年 ' + month + ' 月 ' + day + ' 日' : null;
  }

  function prepareNoticeText(text) {
    const values = [];
    const terms = { 'ai credits': 'AI 积分', credit: '积分', credits: '积分', 'model quota': '模型额度',
      'rate limit': '速率限制', 'rate limits': '速率限制', agent: '智能体', agents: '智能体' };
    const input = text.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b|\b(?:AI credits|credits?|model quota|rate limits?|agents?)\b|\b(?:Claude(?:\s+(?:Sonnet|Opus))?|Sonnet|Opus|Gemini|GPT(?:-OSS)?|Pro|Ultra|Google|Firebase|Chrome(?: DevTools)?|Puppeteer|Antigravity)(?:\s+\d+(?:\.\d+)*(?:B)?(?:\s+(?:Flash|Pro))?)?\b|\b\d+(?:[.,]\d+)*(?:%|B)?\b/g,
      // Dotted identifiers are shielded by the existing translator policy,
      // including its fragment fallback when a provider drops a token.
      (value) => { values.push(noticeDate(value) || terms[value.toLowerCase()] || value); return 'HansUi.t' + (values.length - 1); });
    return { input, values };
  }

  function restoreNoticeText(text, prepared) {
    if (typeof text !== 'string') return null;
    const seen = new Set();
    let invalid = false;
    const output = text.replace(/HansUi\.t(\d+)/g, (token, value) => {
      const index = Number(value);
      if (index >= prepared.values.length || seen.has(index)) { invalid = true; return ''; }
      seen.add(index); return prepared.values[index];
    });
    return invalid || seen.size !== prepared.values.length || /HansUi\.t/.test(output) ? null : output;
  }

  function translateModelAnnouncement(value) {
    const removal = value.match(/^(.{1,80}?) will be removed from Antigravity on ([A-Z][a-z]+ \d{1,2}, \d{4})\.$/);
    if (removal) {
      const date = noticeDate(removal[2]);
      return date ? removal[1] + ' 将于 ' + date + ' 从 Antigravity 中移除。' : null;
    }
    const match = value.match(/^(.{1,80}?) is now available on paid Pro and Ultra plans\. Third-party model access will no longer be available on your current plan starting on ([A-Z][a-z]+) (\d{1,2}), (\d{4})\.$/);
    if (!match) return null;
    const date = noticeDate(match[2] + ' ' + match[3] + ', ' + match[4]);
    return date ? match[1] + ' 现已向付费 Pro 和 Ultra 套餐开放。从 ' + date +
      '起，您当前的套餐将不再支持第三方模型。' : null;
  }

  function enqueueNotice(node) {
    if (!options.localization) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element || isProtected(element)) return;
    const parent = element.closest(NOTICE_FIELD);
    if (parent) noticeQueue.add(parent);
    for (const field of element.querySelectorAll?.(NOTICE_FIELD) || []) noticeQueue.add(field);
    if (noticeQueue.size && noticeTimer === null) noticeTimer = setTimeout(flushNotices, 80);
  }

  async function flushNotices() {
    noticeTimer = null;
    if (noticeRunning) return;
    noticeRunning = true;
    try {
      const groups = new Map(), prepared = new Map();
      let characters = 0;
      for (const element of noticeQueue) {
        noticeQueue.delete(element);
        if (!element.isConnected || isProtected(element) || stillApplied(element)) continue;
        restoreOwnTranslation(element);
        const job = capture(element, true);
        if (!job || job.input.length > 6000) continue;
        const local = translateModelAnnouncement(job.input.trim()) || translateUiValue(job.input.trim());
        if (local && job.markerCount === 0) {
          if (applyTranslation(job, local)) statistics.uiTranslated++;
          continue;
        }
        const cached = noticeCache.get(job.input);
        if (cached) { if (applyTranslation(job, cached)) statistics.uiTranslated++; continue; }
        const failure = noticeFailures.get(job.input);
        if (failure && (failure.count >= 3 || Date.now() < failure.nextAt)) continue;
        if (!/[A-Za-z]/.test(job.input)) continue;
        if (!groups.has(job.input)) {
          const protectedText = prepareNoticeText(job.input);
          if (!/[A-Za-z]/.test(protectedText.input.replace(/__X\d+__|HansUi\.t\d+/g, ''))) {
            const localTerms = restoreNoticeText(protectedText.input, protectedText);
            if (localTerms && localTerms !== job.input && applyTranslation(job, localTerms)) statistics.uiTranslated++;
            continue;
          }
          if (protectedText.input.length > 10000) continue;
          if (characters + protectedText.input.length > 60000) { noticeQueue.add(element); break; }
          prepared.set(job.input, protectedText);
          groups.set(job.input, []); characters += protectedText.input.length;
        }
        groups.get(job.input).push(job);
        if (groups.size >= 30 || characters >= 54000) break;
      }
      if (groups.size) {
        const keys = [...groups.keys()];
        let results;
        try { statistics.uiRequests++; results = await ipcRenderer.invoke('hans:translate-ui', keys.map(key => prepared.get(key).input)); } catch {}
        for (let index = 0; index < keys.length; index++) {
          const input = keys[index], jobs = groups.get(input), result = restoreNoticeText(results?.[index], prepared.get(input));
          const parts = typeof result === 'string' && result !== input && /[\u3400-\u9fff]/.test(result)
            ? splitTranslation(result, jobs[0].markerCount) : null;
          if (parts && parts.every((part, i) => jobs[0].slots[i].length || !part.trim())) {
            noticeCache.delete(input); noticeCache.set(input, result);
            while (noticeCache.size > 200) noticeCache.delete(noticeCache.keys().next().value);
            noticeFailures.delete(input);
            for (const job of jobs) if (applyTranslation(job, result)) statistics.uiTranslated++;
          } else {
            const count = (noticeFailures.get(input)?.count || 0) + 1;
            noticeFailures.set(input, { count, nextAt: Date.now() + 10000 * count });
            while (noticeFailures.size > 200) noticeFailures.delete(noticeFailures.keys().next().value);
            statistics.uiFailures++;
          }
        }
      }
    } finally {
      noticeRunning = false;
      if (noticeQueue.size && noticeTimer === null) noticeTimer = setTimeout(flushNotices, 80);
    }
  }

  function translateUiValue(value) {
    const argonQuota = value.match(/^(Gemini 4 Argon) (Weekly|Daily|5[ -]?hour) Limit( Remaining)?$/i);
    if (argonQuota) return argonQuota[1] + ' ' + ({weekly:'每周',daily:'每日','5-hour':'五小时','5 hour':'五小时','5hour':'五小时'}[argonQuota[2].toLowerCase()]) + (argonQuota[3] ? '剩余额度' : '额度');
    const earlier = value.match(/^(Load older messages|No more older messages), showing (\d+) of (\d+)$/);
    if (earlier) return (earlier[1] === 'Load older messages' ? '加载更早消息' : '没有更多早期消息') + '，已显示 ' + earlier[2] + ' / ' + earlier[3] + ' 条';
    const more = value.match(/^See (\d+) more(?: (plugins|skills and rules|custom agents))?$/);
    if (more) return '再显示 ' + more[1] + ' 项';
    const send = value.match(/^Send message\s+(Enter|Alt\+Enter|Ctrl\+Enter|⌘Enter)$/);
    if (send) return '发送消息 ' + send[1];
    const automationName = value.match(/^Enter automation name(?:\.\.\.|…)$/);
    if (automationName) return '输入自动化名称…';
    const flashIntro = value.match(/^Start using (Gemini \d+\.\d+ Flash), our best Flash model\.$/);
    if (flashIntro) return '开始使用 ' + flashIntro[1] + '，我们目前最出色的 Flash 模型。';
    const exact = UI_DICT[value] || UI_LOWER.get(value.toLowerCase());
    if (exact) return exact;
    const announcement = translateModelAnnouncement(value);
    if (announcement) return announcement;
    // Display only: scheduled-task storage and dropdown values remain AM/PM.
    const clock = value.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
    if (clock) return (clock[3] === 'AM' ? '上午 ' : '下午 ') + clock[1] + ':' + clock[2];
    const commandCount = value.match(/^(Running|Ran) (\d+) commands?$/);
    if (commandCount) return (commandCount[1] === 'Running' ? '正在执行 ' : '已执行 ') + commandCount[2] + ' 条命令';
    const punctuation = value.match(/^(.+?)([.!?])$/);
    if (punctuation) {
      const shorter = UI_DICT[punctuation[1]] || UI_LOWER.get(punctuation[1].toLowerCase());
      if (shorter) {
        const mark = punctuation[2] === '?' ? '？' : punctuation[2] === '!' ? '！' : '。';
        return /[。！？.!?]$/.test(shorter) ? shorter : shorter + mark;
      }
    }
    if (value === 'Resets in <1m') return '不到 1 分钟后重置';
    const reset = value.match(/^Resets in ((?:\d+[dhm])(?: \d+[dhm])?)$/);
    if (reset) {
      const units = { d: '天', h: '小时', m: '分钟' };
      return reset[1].split(' ').map((part) => part.slice(0, -1) + ' ' + units[part.slice(-1)]).join(' ') + '后重置';
    }
    const shortcut = value.match(/^(Enter|Alt\+Enter|⏎|⌥⏎) (Sends immediately|Queues after the turn|On empty prompt, sends next in queue)$/);
    if (shortcut) {
      const actions = {
        'Sends immediately': '立即发送',
        'Queues after the turn': '当前轮次结束后加入队列',
        'On empty prompt, sends next in queue': '输入框为空时发送队列中的下一条'
      };
      return shortcut[1] + '：' + actions[shortcut[2]];
    }
    const seeAll = value.match(/^See all \((\d+)\)$/);
    if (seeAll) return '查看全部（' + seeAll[1] + '）';
    const modelGroup = value.match(/^Models within this group: (.{1,200})$/);
    if (modelGroup) return '此组包含的模型：' + modelGroup[1];
    const sharedModels = value.match(/^Shared with: (.{1,200})$/);
    if (sharedModels) return '共享额度的模型：' + sharedModels[1];
    const breakdown = value.match(/^Show (\d+) breakdowns?$/);
    if (breakdown) return '显示 ' + breakdown[1] + ' 项明细';
    const activeConversations = value.match(/^(\d+) active conversations?$/);
    if (activeConversations) return activeConversations[1] + ' 个活跃对话';
    const fileLimit = value.match(/^File exceeds the 20MB display limit \((\d+)MB\)\.$/);
    if (fileLimit) return '文件大小为 ' + fileLimit[1] + ' MB，超过 20 MB 的预览上限。';
    const duration = value.match(/^(Worked for|Stopped after) ((?:\d+\s*[smhd])(?:\s+\d+\s*[smhd])*)$/i);
    if (duration) {
      const units = { s: '秒', m: '分钟', h: '小时', d: '天' };
      const parts = [...duration[2].matchAll(/(\d+)\s*([smhd])/gi)]
        .map((part) => part[1] + ' ' + units[part[2].toLowerCase()]);
      return duration[1].toLowerCase() === 'worked for'
        ? '工作了 ' + parts.join(' ')
        : '运行 ' + parts.join(' ') + '后停止';
    }
    const media = value.match(/^Media \((Today|Yesterday) (\d{1,2}):(\d{2}) (AM|PM)\)$/);
    if (media) {
      const hour = Number(media[2]) % 12 + (media[4] === 'PM' ? 12 : 0);
      return '媒体（' + (media[1] === 'Today' ? '今天 ' : '昨天 ') +
        String(hour).padStart(2, '0') + ':' + media[3] + '）';
    }
    const modelEffort = value.match(/^((?:Claude|GPT-OSS|Gemini|GPT)[^\n]{1,80}) \((Thinking|Medium|High|Low)\)$/);
    if (modelEffort) {
      const names = { Thinking: '思考', Medium: '中', High: '高', Low: '低' };
      return modelEffort[1] + '（' + names[modelEffort[2]] + '）';
    }
    const updated = value.match(/^Updated (.+)$/);
    if (updated) {
      const dated = updated[1].match(/^([A-Z][a-z]{2}) (\d{1,2}), (.+)$/);
      const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
        Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
      if (dated && months[dated[1]]) return '更新于 ' + months[dated[1]] + ' 月 ' + dated[2] + ' 日 ' + dated[3];
      return '更新于 ' + updated[1];
    }
    const creditOverage = value.match(/^When toggled on, (Antigravity(?: IDE)?) will use your AI credits to fulfill model requests once you're out of model quota\. \1 will always use your model quota first before using AI credits\.$/);
    if (creditOverage) {
      return '开启后，模型额度用尽时，' + creditOverage[1] +
        ' 会使用你的 AI 积分继续处理模型请求。系统始终优先使用模型额度，再消耗 AI 积分。';
    }
    const creditBalance = value.match(/^Available AI Credits: ([\d,.]+)$/);
    if (creditBalance) return '可用 AI 积分：' + creditBalance[1];
    const quota = value.match(/^You have used (some|all|none) of your (weekly|5-hour) limit, it will fully refresh in (.+)\.$/);
    if (quota) {
      const unitNames = { day: '天', hour: '小时', minute: '分钟', second: '秒' };
      const parts = quota[3].split(/,\s*|\s+and\s+/);
      const duration = [];
      for (const part of parts) {
        const time = part.match(/^(\d+)\s+(days?|hours?|minutes?|seconds?)$/);
        if (!time) return null;
        duration.push(time[1] + ' ' + unitNames[time[2].replace(/s$/, '')]);
      }
      const limit = quota[2] === 'weekly' ? '每周额度' : ' 5 小时额度';
      const used = quota[1] === 'all' ? '你已用尽' : quota[1] === 'none' ? '你尚未使用' : '你已使用部分';
      return used + limit + '，将在 ' + duration.join(' ') + '后完全恢复。';
    }
    return null;
  }

  function translateTrigger(button) {
    if (!options.localization) return;
    const label = button && button.firstElementChild;
    if (!label || label.tagName !== 'SPAN') return;
    const nodes = [...label.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE);
    if (!nodes.length) return;
    const value = nodes.map((node) => node.nodeValue).join('');
    let result = null;
    let match = value.match(/^Thinking for\s*(\d+)\s*s$/i);
    if (match) result = '正在思考 ' + match[1] + ' 秒';
    match = value.match(/^Thought for\s*(\d+)\s*s$/i);
    if (match) result = '思考了 ' + match[1] + ' 秒';
    if (value === 'Thought Process' || value === 'Thought') result = '思考过程';
    if (value === 'Thinking') result = '正在思考';
    if (value === 'Thinking...') result = '正在思考…';
    if (!result) return;
    if (button.getAttribute('aria-label') === value) button.setAttribute('aria-label', result);
    if (nodes.length === 3 && /^Thinking for\s*$/i.test(nodes[0].nodeValue) &&
        /^\d+$/.test(nodes[1].nodeValue) && /^s$/i.test(nodes[2].nodeValue)) {
      nodes[0].nodeValue = '正在思考 ';
      nodes[2].nodeValue = ' 秒';
    } else {
      nodes[0].nodeValue = result;
      for (let index = 1; index < nodes.length; index++) nodes[index].nodeValue = '';
    }
  }

  function translateStaticText(node) {
    if (!options.localization) return;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const element = node.parentElement;
    const value = node.nodeValue;
    const trimmed = value?.trim();
    if (isExternalField(element)) return;
    // Native archive notifications render the sentence as Markdown text and a
    // separate history link. Keep this exception inside the notification region
    // so the same wording in messages or plugin content remains untouched.
    const archiveParagraph = element?.closest('p');
    if (element?.closest('[role="region"][aria-label="Notifications"],[role="region"][aria-label="通知"]') &&
        archiveParagraph?.querySelector('a[href="notification://history"]')) {
      if (trimmed === 'View archived conversations in') { node.nodeValue = '可在'; return; }
      if (trimmed === 'history') { node.nodeValue = '历史'; return; }
      if (trimmed === '.') { node.nodeValue = '中查看已归档对话。'; return; }
    }
    if (element?.closest('[role="region"][aria-label="Notifications"],[role="region"][aria-label="通知"]') && archiveParagraph) {
      const archiveFragments = {'View archived in the sidebar (':'可在侧边栏的（', 'menu).':'菜单）中查看已归档对话。'};
      if (archiveFragments[trimmed]) { node.nodeValue = value.replace(trimmed, archiveFragments[trimmed]); return; }
    }
    if (isConversationChrome(element)) {
      const age = trimmed?.match(/^(\d+)(s|m|h|d|w|mo|y) ago$/);
      const units = {s:'秒',m:'分钟',h:'小时',d:'天',w:'周',mo:'个月',y:'年'};
      const translated = age ? age[1] + ' ' + units[age[2]] + '前' : translateUiValue(trimmed || '');
      if (translated) node.nodeValue = value.replace(trimmed, translated);
      return;
    }
    const protectedBody = element?.closest('.prose,.markdown,[data-testid="user-input-step"],[data-testid="agent-turn"],[contenteditable="true"]');
    const modelTrigger = element?.closest('button[data-testid="model-selector-trigger"]');
    if (modelTrigger && element !== modelTrigger) {
      const effortMap = { Thinking: '思考', High: '高', Medium: '中', Low: '低' };
      if (effortMap[trimmed] && /\b(?:Claude|GPT|Gemini)\b/.test(modelTrigger.textContent)) {
        node.nodeValue = value.replace(trimmed, effortMap[trimmed]);
        return;
      }
    }
    if (element?.closest('[data-hans-external-content]')) return;
    if (element?.closest(NOTICE_FIELD)) return;
    // Server renderer updates can rename React symbols. Match the reviewed
    // native layout instead of depending on the old injected bundle marker.
    const nativeUiAllowed = !protectedBody && !element?.closest(PROTECTED);
    if (nativeUiAllowed && ['New','新建','新增'].includes(trimmed) &&
        element?.matches?.('div.bg-secondary.rounded-full.px-1\\.5.text-xs') &&
        element.parentElement?.querySelector('[data-testid="model-selector-effort-group"]')) {
      for (const name of ['opacity-70','text-secondary-foreground']) {
        if (!element.classList.contains(name)) element.classList.add(name);
      }
      if (trimmed !== '新增') node.nodeValue = value.replace(trimmed, '新增');
      return;
    }
    const historyNotice = nativeUiAllowed ? element?.closest('div.flex.flex-col.gap-0\\.5.text-secondary-foreground') : null;
    if (/^(This page is going away soon|此页面即将停用)$/.test(historyNotice?.querySelector('span.font-medium.text-foreground')?.textContent || '') &&
        historyNotice.querySelector('[aria-label="search"],[aria-label="搜索"]') && historyNotice.querySelector('[aria-label="filter"],[aria-label="筛选"]')) {
      const historyText = {
        'This page is going away soon': '此页面即将停用',
        'Search conversations with': '搜索对话请点击',
        'in the top left.': '（位于左上角）。',
        'View archived in the sidebar': '查看已归档对话请打开侧边栏的',
        'menu)': '菜单）', '(': '（', '.': '。'
      };
      if (historyText[trimmed]) { node.nodeValue = value.replace(trimmed, historyText[trimmed]); return; }
    }
    const nativeArchiveBanner = nativeUiAllowed && element?.closest('[data-testid="conversation-view"]') ?
      element.closest('div.relative.flex.items-center.justify-center.gap-2.p-1.min-h-\\[80px\\].rounded-2xl.bg-muted.border.w-full.text-sm.text-secondary-foreground') : null;
    if (element?.closest('[data-testid="archived-chat-banner"]') ||
        nativeArchiveBanner?.querySelector('button')) {
      if (trimmed === 'This chat is archived.') {
        node.nodeValue = value.replace(trimmed, '此对话已归档。');
        return;
      }
      if (trimmed === 'Restore') {
        node.nodeValue = value.replace(trimmed, '恢复');
        return;
      }
    }
    if (element?.closest('button[data-testid="tool-group-collapsible"]') && /^(Running|Ran) \d+ commands?$/.test(trimmed || '')) {
      node.nodeValue = value.replace(trimmed, translateUiValue(trimmed));
      return;
    }
    if (element?.closest('[data-mention-menu] [data-testid="menu-option-label"]') &&
        (trimmed === 'Rules' || trimmed === 'Conversation')) {
      node.nodeValue = value.replace(trimmed, translateUiValue(trimmed));
      return;
    }
    if (element?.closest('[data-testid="worked-for-collapsible"]') &&
        /^(Worked for|Stopped after) \d/.test(trimmed || '')) {
      const translatedDuration = translateUiValue(trimmed);
      if (translatedDuration) node.nodeValue = value.replace(trimmed, translatedDuration);
      return;
    }
    if (element?.closest('[data-testid="selection-quote-button"]') && trimmed === 'Quote') {
      node.nodeValue = value.replace('Quote', '引用');
      return;
    }
    if (!protectedBody && (CHROME_TEXT.has(trimmed) ||
        /^Media \((Today|Yesterday) \d{1,2}:\d{2} (AM|PM)\)$/.test(trimmed || '') ||
        /^(?:Claude|GPT-OSS|Gemini|GPT)[^\n]{1,80} \((?:Thinking|Medium|High|Low)\)$/.test(trimmed || ''))) {
      const translatedChrome = translateUiValue(trimmed);
      if (translatedChrome) node.nodeValue = value.replace(trimmed, translatedChrome);
      return;
    }
    if (trimmed?.startsWith('(Recommended)') &&
        element?.closest('label')?.querySelector('input[name^="ask-question-"]')) {
      node.nodeValue = value.replace('(Recommended)', '（推荐）');
      return;
    }
    if (/^Updated .+$/.test(trimmed || '') && element?.matches('span.truncate') &&
        element.parentElement?.matches('div.flex.items-center.gap-1.text-xs.text-muted-foreground')) {
      node.nodeValue = value.replace(trimmed, translateUiValue(trimmed));
      return;
    }
    if (element?.closest('[data-testid="ask-question-dismiss-button"], [data-testid="interaction-skip-button"], [data-testid="interaction-continue-button"]')) {
      const translatedControl = translateUiValue(trimmed || '');
      if (translatedControl) node.nodeValue = value.replace(trimmed, translatedControl);
      return;
    }
    if (node.nodeValue.trim() === 'Also includes' && node.parentElement?.querySelector('.text-link')) {
      node.nodeValue = '此项目还会应用';
      const beforeLink = node.nextSibling;
      if (beforeLink?.nodeType === Node.TEXT_NODE && !beforeLink.nodeValue.trim()) beforeLink.nodeValue = '';
      const link = beforeLink?.nextSibling;
      const afterLink = link?.nextSibling;
      if (afterLink?.nodeType === Node.TEXT_NODE && !afterLink.nodeValue.trim()) afterLink.nodeValue = '';
      const sentenceEnd = afterLink?.nextSibling;
      if (sentenceEnd?.nodeType === Node.TEXT_NODE && sentenceEnd.nodeValue.trim() === 'when working in this project.') {
        sentenceEnd.nodeValue = '。';
      }
      return;
    }
    const trigger = node.parentElement && node.parentElement.closest(TRIGGER);
    if (trigger) {
      translateTrigger(trigger);
      return;
    }
    if (isProtected(node)) return;
    if (!value || !/[A-Za-z]/.test(value)) return;
    const replacement = translateUiValue(trimmed);
    if (replacement && replacement !== trimmed) node.nodeValue = value.replace(trimmed, replacement);
  }

  function translateStaticAttributes(element) {
    if (!options.localization) return;
    if (isExternalField(element)) return;
    // Only this reviewed client prompt field gets a translated placeholder.
    // Its value and all user-written text remain untouched.
    if (element?.matches('textarea[data-testid="new-sidecar-prompt"]')) {
      const placeholder = element.getAttribute('placeholder');
      if (placeholder === 'Enter a prompt for the agent to run...')
        element.setAttribute('placeholder', '输入供智能体执行的提示词…');
    }
    if (element?.closest('[role="region"][aria-label="Notifications"],[role="region"][aria-label="通知"]') && archiveParagraph) {
      const archiveFragments = {'View archived in the sidebar (':'可在侧边栏的（', 'menu).':'菜单）中查看已归档对话。'};
      if (archiveFragments[trimmed]) { node.nodeValue = value.replace(trimmed, archiveFragments[trimmed]); return; }
    }
    if (isConversationChrome(element)) {
      for (const name of ['aria-label', 'title']) {
        const value = element.getAttribute(name);
        const translated = value && translateUiValue(value);
        if (translated && translated !== value) element.setAttribute(name, translated);
      }
    }
    // Input controls are client chrome even when their enclosing conversation is
    // protected. Match reviewed controls, never message or plugin HTML.
    if (element?.closest('[data-testid="agent-input-box"]') &&
        !element.closest(PROTECTED + ',.prose,.markdown,[data-testid="user-input-step"],[data-testid="agent-turn"]') &&
        element.matches('button[data-testid="send-button"],button[data-tooltip-id="input-send-button-record-tooltip"],button[aria-label="Add context"][data-tooltip-id]')) {
      for (const name of ['aria-label', 'title']) {
        const value = element.getAttribute(name);
        const translated = value && translateUiValue(value);
        if (translated && translated !== value) element.setAttribute(name, translated);
      }
    }
    // Translate only attributes of the observed system controls inside protected rows.
    // User titles and any same-named text/attributes in message bodies stay protected.
    if (element?.matches('button[data-testid="conversation-kebab"],button[data-testid="conversation-pin-button"],button[data-testid="conversation-archive-button"]') &&
        element.closest('[data-testid="conversation-row-sidebar"]')) {
      const labels = { 'More options': '更多选项', 'Pin conversation': '固定对话',
        'Unpin conversation': '取消固定对话', 'Archive conversation': '归档对话' };
      for (const name of ['aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (labels[value]) element.setAttribute(name, labels[value]);
      }
    }
    if (element?.matches('button[aria-haspopup="menu"]') && !isProtected(element)) {
      const label = element.getAttribute('aria-label');
      const project = label?.match(/^Select project, current: (.{1,200})$/);
      if (project) element.setAttribute('aria-label', '选择项目，当前：' +
        (project[1] === 'No Project' ? '无项目' : project[1]));
    }
    if (element?.closest('button[data-testid="tool-group-collapsible"]')) {
      for (const name of ['aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (/^(Running|Ran) \d+ commands?$/.test(value || '')) element.setAttribute(name, translateUiValue(value));
      }
    }
    if (element?.matches('button[data-testid="model-selector-trigger"]')) {
      const label = element.getAttribute('aria-label');
      const match = label?.match(/^(Select model, current:\s*)(.+?)(?:\s+(Thinking|High|Medium|Low))?$/);
      if (match) {
        const effortMap = { Thinking: '思考', High: '高', Medium: '中', Low: '低' };
        const prefix = '选择模型，当前：';
        const modelName = match[2];
        const effort = match[3];
        const newLabel = effort ? `${prefix}${modelName} ${effortMap[effort] || effort}` : `${prefix}${modelName}`;
        element.setAttribute('aria-label', newLabel);
      }
    }
    if (element?.matches('[data-testid="toggle-maximize-pane"]')) {
      const label = element.getAttribute('aria-label');
      if (label === 'Maximize Pane' || label === 'Restore Pane') {
        element.setAttribute('aria-label', translateUiValue(label));
      }
    }
    if (element?.matches('input[placeholder="Other (write your answer)"],textarea[placeholder="Other (write your answer)"]')) {
      element.setAttribute('placeholder', '其他（自行填写）');
    }
    if (element?.getAttribute('contenteditable') === 'true' &&
        element.closest('[data-testid="agent-input-box"]') &&
        element.getAttribute('aria-label') === 'Message input') {
      element.setAttribute('aria-label', '消息输入框');
    }
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isProtected(element)) return;
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const trimmed = value.trim();
      const replacement = translateUiValue(trimmed);
      if (replacement && replacement !== trimmed) element.setAttribute(name, value.replace(trimmed, replacement));
    }
  }

  function visitAdded(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      translateStaticText(node);
      if (node.parentElement && node.parentElement.closest('.cursor-edit,.pl-2.border-l.border-border,' + TRIGGER)) scheduleScan();
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches('textarea[data-testid="new-sidecar-prompt"]')) translateStaticAttributes(node);
    if (node.closest(PROTECTED)) return;
    enqueueNotice(node);
    translateStaticAttributes(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (candidate) => candidate.nodeType === Node.ELEMENT_NODE
        ? (candidate.matches(PROTECTED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
        : NodeFilter.FILTER_ACCEPT
    });
    for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
      translateStaticText(textNode);
    }
    for (const element of node.querySelectorAll('[aria-label],[title],[placeholder]')) {
      translateStaticAttributes(element);
    }
    if (node.matches(TRIGGER + ',.cursor-edit,.pl-2.border-l.border-border') ||
        node.querySelector(TRIGGER + ',.cursor-edit,.pl-2.border-l.border-border') ||
        node.closest('.cursor-edit,.pl-2.border-l.border-border')) scheduleScan();
  }

  function capture(element, protectLinks = false) {
    const children = [...element.childNodes];
    const slots = [[]];
    let input = '';
    let markerCount = 0;
    const protectedNodes = [];
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        slots[slots.length - 1].push({ node, value: node.nodeValue || '' });
        input += node.nodeValue || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches(PROTECTED) || node.matches('img,svg,math') || (protectLinks && node.matches('a[href]'))) {
          protectedNodes.push({ node, value: node.textContent });
          input += '__X' + markerCount++ + '__';
          slots.push([]);
        } else {
          for (const child of node.childNodes) walk(child);
        }
      }
    }
    for (const child of children) walk(child);
    const sourceText = slots.flat().map((entry) => entry.value).join('');
    if (!/[A-Za-z]/.test(sourceText) || sourceText.trim().length < (protectLinks ? 2 : 3)) return null;
    return { element, children, slots, input, markerCount, protectedNodes };
  }

  function unchanged(captured) {
    const current = captured.element.childNodes;
    if (!captured.element.isConnected || current.length !== captured.children.length) return false;
    for (let index = 0; index < current.length; index++) {
      if (current[index] !== captured.children[index]) return false;
    }
    return captured.slots.every((slot) => slot.every((entry) => entry.node.isConnected && entry.node.nodeValue === entry.value)) &&
      captured.protectedNodes.every((entry) => entry.node.isConnected && entry.node.textContent === entry.value);
  }

  function stillApplied(element) {
    const previous = state.get(element);
    if (!previous || element.childNodes.length !== previous.children.length) return false;
    for (let index = 0; index < previous.children.length; index++) {
      if (element.childNodes[index] !== previous.children[index]) return false;
    }
    return previous.textNodes.every((entry) => entry.node.isConnected && entry.node.nodeValue === entry.applied) &&
      previous.protectedNodes.every((entry) => entry.node.isConnected && entry.node.textContent === entry.value);
  }

  function restoreOwnTranslation(element) {
    const previous = state.get(element);
    if (!previous) return;
    state.delete(element);
    for (const entry of previous.textNodes) {
      if (entry.node.isConnected && entry.node.nodeValue === entry.applied) {
        entry.node.nodeValue = entry.original;
      }
    }
  }

  function rememberApplied(captured) {
    const element = captured.element;
    state.set(element, {
      children: [...element.childNodes],
      textNodes: captured.slots.flat().map((entry) => ({
        node: entry.node, original: entry.value, applied: entry.node.nodeValue
      })),
      protectedNodes: captured.protectedNodes
    });
  }

  function splitTranslation(text, count) {
    const parts = [];
    const regex = /__X(\d+)__/g;
    let previous = 0;
    let match;
    let seen = 0;
    while ((match = regex.exec(text))) {
      if (Number(match[1]) !== seen || seen >= count) return null;
      parts.push(text.slice(previous, match.index));
      previous = regex.lastIndex;
      seen++;
    }
    if (seen !== count) return null;
    parts.push(text.slice(previous));
    return parts;
  }

  function addCodeSpacing(parts, captured) {
    if (!captured.markerCount) return;
    const elements = captured.protectedNodes.map((entry) => entry.node);
    for (let index = 0; index < elements.length; index++) {
      const value = (elements[index].textContent || '').trim();
      if (!/^[A-Za-z0-9_]/.test(value)) continue;
      if (/[\u3400-\u9fff]$/.test(parts[index])) parts[index] += ' ';
      if (/^[\u3400-\u9fff]/.test(parts[index + 1])) parts[index + 1] = ' ' + parts[index + 1];
    }
  }

  function applyTranslation(captured, translated) {
    if (typeof translated !== 'string' || !unchanged(captured)) return false;
    const parts = splitTranslation(translated, captured.markerCount);
    if (!parts || parts.length !== captured.slots.length) return false;
    for (let index = 0; index < parts.length; index++) {
      if (!captured.slots[index].length && parts[index].trim()) return false;
    }
    addCodeSpacing(parts, captured);
    for (let index = 0; index < parts.length; index++) {
      const slot = captured.slots[index];
      if (!slot.length) continue;
      slot[0].node.nodeValue = parts[index];
      for (let extra = 1; extra < slot.length; extra++) slot[extra].node.nodeValue = '';
    }
    rememberApplied(captured);
    statistics.translated++;
    return true;
  }

  function getBlockUnits(body) {
    const blockSelector = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,td,th,figcaption';
    const blocks = [...body.querySelectorAll(blockSelector)].filter((element) => {
      if (element.closest('pre,code')) return false;
      if (element.querySelector(blockSelector)) return false;
      return true;
    });
    return blocks;
  }

  function canRetry(key) {
    const entry = retries.get(key);
    if (entry && Date.now() < entry.nextAt) scheduleRetry(entry.nextAt);
    return !entry || Date.now() >= entry.nextAt;
  }

  function scheduleRetry(at) {
    if (at >= retryWakeAt) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryWakeAt = at;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryWakeAt = Infinity;
      scheduleScan();
    }, Math.max(0, at - Date.now()) + 10);
  }

  function recordFailure(key) {
    const old = retries.get(key);
    const count = Math.min(4, (old ? old.count : 0) + 1);
    retries.set(key, { count, nextAt: Date.now() + Math.min(60000, 3500 * 2 ** count) });
    scheduleRetry(retries.get(key).nextAt);
    while (retries.size > 240) retries.delete(retries.keys().next().value);
    statistics.failures++;
  }

  function handleUnit(element, allowNetwork, jobs) {
    if (stillApplied(element) || pending.has(element)) return false;
    restoreOwnTranslation(element);
    const captured = capture(element);
    if (!captured) return false;
    const cached = getCached(captured.input);
    if (cached && applyTranslation(captured, cached)) return false;
    if (!allowNetwork || !canRetry(captured.input)) return true;
    pending.add(element);
    jobs.push(captured);
    return true;
  }

  async function dispatch(jobs) {
    for (let start = 0; start < jobs.length;) {
      const batch = [];
      let characters = 0;
      while (start < jobs.length && batch.length < 30) {
        const job = jobs[start];
        if (batch.length && characters + job.input.length > 60000) break;
        batch.push(job);
        characters += job.input.length;
        start++;
      }
      let results = null;
      try {
        statistics.requests++;
        results = await ipcRenderer.invoke('hans:translate', batch.map((job) => job.input));
      } catch {}
      for (let index = 0; index < batch.length; index++) {
        const job = batch[index];
        const value = Array.isArray(results) ? results[index] : null;
        if (typeof value === 'string' && value !== job.input) {
          const parts = splitTranslation(value, job.markerCount);
          if (parts && parts.every((part, partIndex) => job.slots[partIndex].length || !part.trim())) {
            setCached(job.input, value);
            if (applyTranslation(job, value)) retries.delete(job.input);
          } else {
            recordFailure(job.input);
          }
        } else {
          recordFailure(job.input);
        }
        pending.delete(job.element);
      }
    }
    scheduleScan();
  }

  function scan() {
    scanScheduled = false;
    if (!options.thinking) return;
    const triggers = [...document.querySelectorAll(TRIGGER)];
    if (!triggers.length) return;
    const jobs = [];
    for (const trigger of triggers) {
      translateTrigger(trigger);
      const card = trigger.parentElement;
      const body = card && card.querySelector('.cursor-edit,div.pl-2.border-l.border-border');
      if (!body) continue;
      const allowNetwork = true;
      const running = /^(Thinking|正在思考)/i.test((trigger.firstElementChild?.textContent || '').trim());
      const blocks = getBlockUnits(body);
      for (let index = 0; index < blocks.length; index++) {
        if (running && index === blocks.length - 1) continue;
        const block = blocks[index];
        handleUnit(block, allowNetwork, jobs);
      }
    }
    if (jobs.length) void dispatch(jobs);
  }

  function scheduleScan() {
    if (!options.thinking) return;
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(scan, 90);
  }

  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'characterData') {
        translateStaticText(change.target);
        enqueueNotice(change.target);
        if (change.target.parentElement?.closest('.cursor-edit,.pl-2.border-l.border-border,' + TRIGGER)) scheduleScan();
      } else if (change.type === 'childList') {
        for (const node of change.addedNodes) visitAdded(node);
        enqueueNotice(change.target);
        if (change.target.closest?.('.cursor-edit,.pl-2.border-l.border-border,' + TRIGGER)) scheduleScan();
      } else if (change.type === 'attributes') {
        if (change.attributeName === 'aria-expanded') scheduleScan();
        else translateStaticAttributes(change.target);
      }
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'placeholder', 'aria-expanded']
  });


  function initialize() {
    if (options.localization && document.documentElement) document.documentElement.lang = 'zh-CN';
    if (document.body) visitAdded(document.body);
    scheduleScan();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
