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
  const call = (method, params) => new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 6000);
    const onMessage = (event) => {
      const response = JSON.parse(event.data);
      if (response.id !== callId) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (response.error || response.result.exceptionDetails) reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else resolve(response.result.result?.value);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  const evaluate = (expression) => call('Runtime.evaluate', { expression, returnByValue: true });
  let opened = false;
  let changedTab = false;
  let restoreCustomizations = false;
  try {
    if (!await evaluate('!!document.querySelector("[data-testid=settings-nav-item-General]")')) {
      await evaluate('document.querySelector("[data-testid=settings-button]")?.click();true');
      opened = true;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    restoreCustomizations = await evaluate('!!document.querySelector("[data-testid=workspace-customizations-view]")?.getClientRects().length');
    if (!await evaluate('!![...document.querySelectorAll("[data-tooltip-id=preset-learn-more-tooltip]")].find(e=>e.getClientRects().length)')) {
      await evaluate('document.querySelector("[data-testid=settings-nav-item-General]")?.click();true');
      changedTab = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await evaluate('document.querySelector("[data-testid=settings-nav-item-App]")?.click();true');
    await new Promise((resolve) => setTimeout(resolve, 180));
    await evaluate('document.querySelector("[data-testid=settings-nav-item-General]")?.click();true');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const result = await evaluate('(() => {' +
      'const icon=[...document.querySelectorAll("[data-tooltip-id=preset-learn-more-tooltip]")].find(e=>e.getClientRects().length);' +
      'const row=icon?.parentElement;const before={label:row?.textContent,role:row?.getAttribute("role"),tabindex:row?.getAttribute("tabindex"),dataHans:row?.getAttribute("data-hans-preset-detail"),iconTooltipId:icon?.getAttribute("data-tooltip-id")};' +
      'return {...before,customPopupAfterTextClick:!!document.querySelector("#antigravity-hans-preset-detail")};})()');
    console.log(JSON.stringify(result));
    if (result.label !== '了解极速模式' || result.role !== null || result.tabindex !== null ||
        result.dataHans !== null || result.iconTooltipId !== 'preset-learn-more-tooltip' || result.customPopupAfterTextClick) process.exitCode = 1;
    const point = await evaluate('(() => {const icon=[...document.querySelectorAll("[data-tooltip-id=preset-learn-more-tooltip]")].find(e=>e.getClientRects().length);const r=icon.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await evaluate('(() => {const icon=[...document.querySelectorAll("[data-tooltip-id=preset-learn-more-tooltip]")].find(e=>e.getClientRects().length);icon?.dispatchEvent(new PointerEvent("pointerover",{bubbles:true,pointerType:"mouse",clientX:' + point.x + ',clientY:' + point.y + '}));return true})()');
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const tooltip = await evaluate('(() => {const visible=[...document.querySelectorAll("[role=tooltip]")].find(e=>e.getClientRects().length&&e.textContent?.includes("高风险模式"));return {text:visible?.textContent?.trim()||null,className:visible?.className||null}})()');
    console.log('NATIVE_HOVER ' + JSON.stringify(tooltip));
    if (!tooltip.text || !tooltip.className?.includes('compact-tooltip')) process.exitCode = 1;
    const afterTextClick = await evaluate('(() => {const icon=[...document.querySelectorAll("[data-tooltip-id=preset-learn-more-tooltip]")].find(e=>e.getClientRects().length);icon?.parentElement?.firstElementChild?.click();return !!document.querySelector("#antigravity-hans-preset-detail")})()');
    console.log('CUSTOM_AFTER_TEXT_CLICK ' + afterTextClick);
    if (afterTextClick) process.exitCode = 1;
  } finally {
    if (opened) await evaluate('document.querySelector("[data-testid=settings-button]")?.click();true').catch(() => {});
    else if (changedTab && restoreCustomizations) await evaluate('document.querySelector("[data-testid=settings-nav-item-Customizations]")?.click();true').catch(() => {});
    socket.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
