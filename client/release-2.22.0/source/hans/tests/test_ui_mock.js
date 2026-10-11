const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = targets.find((target) => target.type === 'page' && target.url.startsWith('https://127.0.0.1:'));
  if (!page) throw new Error('No active page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 5000);
    const onMessage = (event) => {
      const response = JSON.parse(event.data);
      if (response.id !== callId) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (response.error || response.result.exceptionDetails) reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else resolve(response.result.result.value);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id: callId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  try {
    const risk = 'A high-risk mode that disables all safety barriers. The agent operates with full system access, auto-executes all terminal commands, and reads or writes to all local files without review prompts.';
    const credit = "When toggled on, Antigravity will use your AI credits to fulfill model requests once you're out of model quota. Antigravity will always use your model quota first before using AI credits.";
    const html = '<div data-testid="conversation-view"><p id="hans-user-content">App version</p>' +
      '<div data-testid="agent-input-box"><div contenteditable="true" aria-label="Message input">Ask anything, @ to mention, / for actions</div>' +
      '<p id="hans-placeholder" class="pointer-events-none absolute">Ask anything, @ to mention, / for actions</p>' +
      '<button data-testid="model-selector-trigger" id="hans-model-btn" aria-label="Select model, current: Gemini 3.8 Flash High"><span>Gemini 3.8 Flash<span class="opacity-70" id="hans-effort-high"> High</span></span></button>' +
      '<button data-testid="model-selector-trigger" id="hans-model-btn-thinking" aria-label="Select model, current: Claude 3.7 Sonnet Thinking"><span>Claude 3.7 Sonnet<span class="opacity-70" id="hans-effort-thinking"> Thinking</span></span></button></div>' +
      '<div data-testid="toast-notification"><div class="markdown prose"><p id="hans-archive-toast">可在 <a href="notification://history">历史</a> 中查看已归档对话。</p></div></div>' +
      '<button data-testid="tool-group-collapsible" aria-label="Running 3 commands"><span id="hans-running-commands" title="Running 3 commands">Running 3 commands</span></button>' +
      '<button data-testid="tool-group-collapsible"><span id="hans-ran-commands">Ran 3 commands</span></button>' +
      '<div data-mention-menu="" role="listbox"><div role="option"><span data-testid="menu-option-label" id="hans-mention-rules">Rules</span></div>' +
      '<div role="option"><span data-testid="menu-option-label" id="hans-mention-conversation">Conversation</span></div></div>' +
      '<label><input name="ask-question-demo"><span id="hans-recommended">(Recommended) 确认删除</span></label>' +
      '<input id="hans-other" placeholder="Other (write your answer)">' +
      '<button data-testid="ask-question-dismiss-button" id="hans-question-cancel">Cancel</button>' +
      '<button data-testid="interaction-skip-button" id="hans-question-skip">Skip</button>' +
      '<button data-testid="interaction-continue-button" id="hans-question-submit">Submit</button>' +
      '<div class="flex items-center gap-1 text-xs text-muted-foreground"><span></span><span class="truncate" id="hans-updated">Updated 21:45</span></div>' +
      '<div data-testid="agent-turn"><button data-testid="worked-for-collapsible"><span id="hans-worked">Worked for 4m</span></button>' +
      '<button data-testid="selection-quote-button"><span id="hans-quote">Quote</span><span>Ctrl+L</span></button>' +
      '</div>' +
      '<p id="hans-no-subagents">No subagents</p><p id="hans-no-files">No file changes</p>' +
      '<p id="hans-no-artifacts">No artifacts generated</p><p id="hans-no-terminals">No active terminals</p>' +
      '<p id="hans-skills-used">Skills Used</p><p id="hans-media">Media (Today 9:17 PM)</p>' +
      '<p id="hans-no-review">No changes to review</p></div>' +
      '<p id="hans-reset">Resets in 5d 23h</p><p id="hans-queue">Alt+Enter Queues after the turn</p>' +
      '<p id="hans-empty">Alt+Enter On empty prompt, sends next in queue</p>' +
      '<p id="hans-setting">To modify notification settings, open your operating system\'s system preferences.</p>' +
      '<p id="hans-version">App version</p><p id="hans-updates">Automatic Check for Updates</p>' +
      '<p id="hans-new-window">New Window</p><p id="hans-approval">Every command requires approval.</p>' +
      '<p id="hans-see-all">See all (20)</p>' +
      '<p id="hans-risk">' + risk + '</p>' +
      '<p id="hans-thinking-desc">Display and preserve intermediate thinking steps.</p>' +
      '<p id="hans-credit">' + credit + '</p>' +
      '<p id="hans-weekly">You have used some of your weekly limit, it will fully refresh in 5 days, 23 hours.</p>' +
      '<p id="hans-five-hour">You have used some of your 5-hour limit, it will fully refresh in 4 hours, 29 minutes.</p>' +
      '<p id="hans-model-group">Models within this group: Gemini Flash, Gemini Pro</p>' +
      '<p id="hans-browser-banner">Browser settings have moved</p>' +
      '<p id="hans-browser-banner-desc">Browser settings have moved to the Browser section of General settings.</p>' +
      '<p id="hans-browser-banner-link">Go to General settings</p>' +
      '<p id="hans-inherits">Inherits your Global Permissions when working in this project.</p>' +
      '<p id="hans-user-guidelines">User custom global execution guidelines and rules for all conversations and projects.</p>' +
      '<p id="hans-browser-split">Configure the browser subagent. It requires <a>Google Chrome</a> to be installed.</p>' +
      '<p id="hans-install-ide">Install Antigravity IDE to run and edit your workspace scripts.</p>' +
      '<p id="hans-strong">Strong</p>' +
      '<p id="hans-project-worktree">Project + Worktree</p><p id="hans-only-unread">Only Unread</p>' +
      '<p id="hans-limited-time">Limited time</p><p id="hans-claude-thinking">Claude Sonnet 4.6 (Thinking)</p>' +
      '<p id="hans-gpt-medium">GPT-OSS 120B (Medium)</p><p id="hans-maximize">Maximize Pane</p>' +
      '<p id="hans-new-terminal">New Terminal</p>' +
      '<p id="hans-pin">Pin</p><p id="hans-stop-execution">Stop Execution</p>' +
      '<p id="hans-mark-unread">Mark Unread</p><p id="hans-scheduled">Scheduled</p>' +
      '<p id="hans-new">New</p><p id="hans-no-scheduled">No scheduled tasks configured.</p>' +
      '<p id="hans-submit-tooltip">Submit (Enter)</p>' +
      '<p id="hans-file-error">Failed to read file content</p>' +
      '<p id="hans-file-limit">File exceeds the 20MB display limit (264MB).</p>' +
      '<button id="hans-show-explorer">Show in File Explorer</button>' +
      '<span id="hans-preset-row"><span>了解<span class="font-semibold">Turbo mode</span></span><span data-tooltip-id="mock-preset"><svg></svg></span></span>';
    await evaluate('(() => {const root=document.createElement("div");root.id="hans-ui-test";root.style.display="none";root.innerHTML=' + JSON.stringify(html) + ';document.body.append(root);return true;})()');
    await new Promise((resolve) => setTimeout(resolve, 650));
    const result = await evaluate('(() => {const root=document.querySelector("#hans-ui-test");const ids=["hans-placeholder","hans-reset","hans-queue","hans-empty","hans-setting","hans-version","hans-updates","hans-new-window","hans-approval","hans-see-all","hans-user-content","hans-risk","hans-thinking-desc","hans-credit","hans-weekly","hans-five-hour","hans-model-group","hans-browser-banner","hans-browser-banner-desc","hans-browser-banner-link","hans-inherits","hans-user-guidelines","hans-browser-split","hans-install-ide","hans-strong","hans-recommended","hans-question-cancel","hans-question-skip","hans-question-submit","hans-pin","hans-stop-execution","hans-mark-unread","hans-scheduled","hans-new","hans-no-scheduled","hans-submit-tooltip","hans-updated","hans-worked","hans-quote","hans-no-subagents","hans-no-files","hans-no-artifacts","hans-no-terminals","hans-skills-used","hans-media","hans-no-review","hans-project-worktree","hans-only-unread","hans-limited-time","hans-claude-thinking","hans-gpt-medium","hans-maximize","hans-new-terminal","hans-preset-row"];const values=Object.fromEntries(ids.map(id=>[id,root.querySelector("#"+id).textContent]));values.otherPlaceholder=root.querySelector("#hans-other").getAttribute("placeholder");values.editableText=root.querySelector("[contenteditable=true]").textContent;values.editableLabel=root.querySelector("[contenteditable=true]").getAttribute("aria-label");values.presetRole=root.querySelector("#hans-preset-row").getAttribute("role");return values;})()');
    console.log(JSON.stringify(result));
    const expected = {
      'hans-placeholder': '想问什么都可以，@ 引用，/ 执行动作',
      'hans-reset': '5 天 23 小时后重置',
      'hans-queue': 'Alt+Enter：当前轮次结束后加入队列',
      'hans-empty': 'Alt+Enter：输入框为空时发送队列中的下一条',
      'hans-setting': '若要修改通知设置，请打开操作系统的系统设置。',
      'hans-version': '应用版本',
      'hans-updates': '自动检查更新',
      'hans-new-window': '新窗口',
      'hans-approval': '每条命令都需要审核。',
      'hans-see-all': '查看全部（20）',
      'hans-user-content': 'App version',
      'hans-risk': '高风险模式：关闭所有安全防护。智能体将拥有完整的系统访问权限，自动执行所有终端命令，并可在无需审核的情况下读取或修改本机任何文件。',
      'hans-thinking-desc': '显示并保留中间思考步骤。',
      'hans-credit': '开启后，模型额度用尽时，Antigravity 会使用你的 AI 积分继续处理模型请求。系统始终优先使用模型额度，再消耗 AI 积分。',
      'hans-weekly': '你已使用部分每周额度，将在 5 天 23 小时后完全恢复。',
      'hans-five-hour': '你已使用部分 5 小时额度，将在 4 小时 29 分钟后完全恢复。',
      'hans-model-group': '此组包含的模型：Gemini Flash, Gemini Pro',
      'hans-browser-banner': '浏览器设置已迁移',
      'hans-browser-banner-desc': '浏览器设置已移至“常规”设置中的“浏览器”部分。',
      'hans-browser-banner-link': '前往常规设置',
      'hans-inherits': '在此项目中工作时，继承你的全局权限。',
      'hans-user-guidelines': '适用于所有对话和项目的自定义全局执行指引与规则。',
      'hans-browser-split': '配置浏览器子智能体。请先安装 Google Chrome 后才能使用。',
      'hans-install-ide': '安装 Antigravity IDE 后，即可运行和编辑工作区脚本。',
      'hans-strong': '高对比度',
      'hans-recommended': '（推荐） 确认删除',
      'hans-question-cancel': '取消',
      'hans-question-skip': '跳过',
      'hans-question-submit': '提交',
      'hans-pin': '固定',
      'hans-stop-execution': '停止执行',
      'hans-mark-unread': '标记为未读',
      'hans-scheduled': '定时任务',
      'hans-new': '新建',
      'hans-no-scheduled': '尚未配置定时任务。',
      'hans-submit-tooltip': '提交（Enter）',
      'hans-updated': '更新于 21:45',
      'hans-worked': '工作了 4 分钟',
      'hans-quote': '引用',
      'hans-no-subagents': '暂无子智能体',
      'hans-no-files': '没有文件改动',
      'hans-no-artifacts': '未生成成果',
      'hans-no-terminals': '没有活动终端',
      'hans-skills-used': '已使用技能',
      'hans-media': '媒体（今天 21:17）',
      'hans-no-review': '没有待审核的更改',
      'hans-project-worktree': '项目 + 工作树',
      'hans-only-unread': '仅未读',
      'hans-limited-time': '限时',
      'hans-claude-thinking': 'Claude Sonnet 4.6（思考）',
      'hans-gpt-medium': 'GPT-OSS 120B（中）',
      'hans-maximize': '最大化面板',
      'hans-new-terminal': '新建终端',
      'hans-preset-row': '了解极速模式',
      otherPlaceholder: '其他（自行填写）',
      presetRole: null,
      editableText: 'Ask anything, @ to mention, / for actions',
      editableLabel: '消息输入框'
    };
    if (Object.entries(expected).some(([key, value]) => result[key] !== value)) process.exitCode = 1;
    const finalDetails = await evaluate('(() => {const ids=["hans-mention-rules","hans-mention-conversation","hans-file-error","hans-file-limit","hans-show-explorer"];return Object.fromEntries(ids.map(id=>[id,document.getElementById(id).textContent]));})()');
    console.log('FINAL_DETAILS ' + JSON.stringify(finalDetails));
    const expectedDetails = {
      'hans-mention-rules': '规则',
      'hans-mention-conversation': '对话',
      'hans-file-error': '无法读取文件内容',
      'hans-file-limit': '文件大小为 264 MB，超过 20 MB 的预览上限。',
      'hans-show-explorer': '在文件资源管理器中显示'
    };
    if (Object.entries(expectedDetails).some(([key, value]) => finalDetails[key] !== value)) process.exitCode = 1;
    const commandHeaders = await evaluate('(()=>({running:document.getElementById("hans-running-commands").textContent,ran:document.getElementById("hans-ran-commands").textContent,title:document.getElementById("hans-running-commands").title,label:document.getElementById("hans-running-commands").parentElement.getAttribute("aria-label")}))()');
    console.log('COMMAND_HEADERS ' + JSON.stringify(commandHeaders));
    if (commandHeaders.running !== '正在执行 3 条命令' || commandHeaders.ran !== '已执行 3 条命令' || commandHeaders.title !== commandHeaders.running || commandHeaders.label !== commandHeaders.running) process.exitCode = 1;
    const modelAndToast = await evaluate('(()=>({highEffort:document.getElementById("hans-effort-high")?.textContent?.trim(),thinkingEffort:document.getElementById("hans-effort-thinking")?.textContent?.trim(),highLabel:document.getElementById("hans-model-btn")?.getAttribute("aria-label"),thinkingLabel:document.getElementById("hans-model-btn-thinking")?.getAttribute("aria-label"),archiveToast:document.getElementById("hans-archive-toast")?.textContent}))()');
    console.log('MODEL_AND_TOAST ' + JSON.stringify(modelAndToast));
    if (modelAndToast.highEffort !== '高' || modelAndToast.thinkingEffort !== '思考' || modelAndToast.highLabel !== '选择模型，当前：Gemini 3.8 Flash 高' || modelAndToast.thinkingLabel !== '选择模型，当前：Claude 3.7 Sonnet 思考' || modelAndToast.archiveToast !== '可在 历史 中查看已归档对话。') process.exitCode = 1;
    await evaluate('document.querySelector("#hans-reset").firstChild.nodeValue="Resets in 4h 43m";true');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const updated = await evaluate('document.querySelector("#hans-reset").textContent');
    console.log('UPDATED ' + updated);
    if (updated !== '4 小时 43 分钟后重置') process.exitCode = 1;
    await evaluate('document.querySelector("#hans-worked").firstChild.nodeValue="Worked for 7m";true');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const workedUpdated = await evaluate('document.querySelector("#hans-worked").textContent');
    console.log('WORKED_UPDATED ' + workedUpdated);
    if (workedUpdated !== '工作了 7 分钟') process.exitCode = 1;
  } finally {
    await evaluate('document.querySelector("#hans-ui-test")?.remove();true').catch(() => {});
    socket.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
