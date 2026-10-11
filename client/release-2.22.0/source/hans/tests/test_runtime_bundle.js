'use strict';
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const needles = {
    singleTildeDisabled: '()=>[[zvb.default,{singleTilde:!1}],Avb.remarkAlert',
    thoughtMounted: 'q||h==="thinking-collapsible-trigger"',
    archiveNotificationPatched: '可在 [历史](notification://history) 中查看已归档对话。',
    artifactDefaultPatched: 'z.createElement(KZ,{text:"成果"})',
    archivedBannerPatched: '"data-testid":"archived-chat-banner"',
    terminalCreatingPatched: '正在创建终端...'
  };
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = pages.find((item) => item.type === 'page' && item.url.startsWith('https://127.0.0.1:'));
  if (!page) throw new Error('No active Antigravity page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
        else resolve(message.result.result.value);
      });
      const checks = Object.entries(needles).map(([name, needle]) =>
        `${name}:s.includes(${JSON.stringify(needle)})`).join(',');
      const expression = `(async()=>{const s=await(await fetch("/main.js",{cache:"no-store"})).text();return {version:window.antigravityHansStatus?.get().version,${checks}}})()`;
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    console.log(JSON.stringify(result));
    if (result.version !== 23 || Object.keys(needles).some((name) => !result[name])) process.exitCode = 1;
  } finally { socket.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
