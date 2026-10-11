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
    const html = '<div class="relative"><button data-testid="thinking-collapsible-trigger" aria-expanded="false"><span>Thought for 5s</span></button>' +
      '<div class="cursor-edit"><p><span>Initial </span><span>investigation </span><span>found </span><span>a potential </span><span>cause in the React rendering path.</span></p></div></div>' +
      '<div class="relative"><button data-testid="thinking-collapsible-trigger" aria-label="Thought for 10s" aria-expanded="false"><span>Thought for 10s</span></button>' +
      '<div class="pl-2 border-l border-border mt-1"><p><span>Examining </span><span>the evolution </span><span>from prior versions, </span><span>the current system employs a layered architecture. </span><span>It modifies the language server renderer dynamically.</span></p>' +
      '<p>The patch is deployed in <code>app.asar</code> and preserves existing DOM nodes.</p>' +
      '<p id="hans-reordered-code">The markdown rendering bug stems from a misconfiguration. The issue lies in how the <code>singleTilde</code> option is being defaulted to <code>true</code> when the <code>gtb.default</code> configuration is used. A hotfix using <code>antigravity-hans</code> appears appropriate.</p>' +
      '<p id="hans-original-screenshot20">' + require('./test_screenshot20') + '</p></div></div>';
    await evaluate('(() => { const root=document.createElement("div");root.id="hans-fragment-test";root.style.display="none";root.setAttribute("data-testid","conversation-view");root.innerHTML=' + JSON.stringify(html) + ';window.__hansFragmentCode=root.querySelector("code");document.body.append(root);return true;})()');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const visibility = await evaluate('(()=>[...document.querySelectorAll("#hans-fragment-test .cursor-edit,#hans-fragment-test .pl-2")].map(e=>({visibility:getComputedStyle(e).visibility,waiting:e.hasAttribute("data-hans-waiting")})))()');
    console.log('IMMEDIATE_VISIBILITY ' + JSON.stringify(visibility));
    if (visibility.some((item) => item.visibility === 'hidden' || item.waiting)) process.exitCode = 1;
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const result = await evaluate('(() => {const root=document.querySelector("#hans-fragment-test");const p=[...root.querySelectorAll("p")];return {titles:[...root.querySelectorAll("button span")].map(x=>x.textContent),paragraphs:p.map(x=>x.textContent),spanCounts:p.map(x=>x.querySelectorAll("span").length),codePreserved:root.querySelector("code")===window.__hansFragmentCode,status:window.antigravityHansStatus?.get?.()};})()');
    console.log(JSON.stringify(result));
    if (result.paragraphs.at(-1).includes('Acknowledged') || !result.paragraphs.at(-1).match(/[\u3400-\u9fff]/)) process.exitCode = 1;
    const codeDetails = await evaluate('(() => {const p=document.querySelector("#hans-reordered-code");return {text:p.textContent,codes:[...p.querySelectorAll("code")].map(x=>x.textContent)};})()');
    console.log('CODE_FALLBACK ' + JSON.stringify(codeDetails));
    if (codeDetails.text.includes('configuration is used') || !codeDetails.text.match(/[\u3400-\u9fff]/) || JSON.stringify(codeDetails.codes) !== JSON.stringify(['singleTilde','true','gtb.default','antigravity-hans'])) process.exitCode = 1;
    if (result.paragraphs[0].includes('investigation') || result.paragraphs[1].includes('evolution') ||
        !result.paragraphs[0].match(/[\u3400-\u9fff]/) || !result.paragraphs[1].match(/[\u3400-\u9fff]/) ||
        !result.codePreserved || result.titles[0] !== '思考了 5 秒' || result.titles[1] !== '思考了 10 秒') {
      process.exitCode = 1;
    }
    await evaluate('(() => {const p=document.querySelector("#hans-fragment-test .cursor-edit p");p.querySelectorAll("span")[4].firstChild.nodeValue="a new root cause in the React rendering path.";return true;})()');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const updated = await evaluate('(() => document.querySelector("#hans-fragment-test .cursor-edit p").textContent)()');
    console.log('UPDATED ' + updated);
    if (!updated.match(/[\u3400-\u9fff]/) || updated.includes('investigation') || updated.includes('root cause')) {
      process.exitCode = 1;
    }
  } finally {
    await evaluate('document.querySelector("#hans-fragment-test")?.remove();true').catch(() => {});
    socket.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
