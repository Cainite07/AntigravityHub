'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const moduleRoot = fs.existsSync(path.join(__dirname, 'rewrite')) ? path.join(__dirname, 'rewrite') : path.join(__dirname, '..');
const { protectText, restoreText, validDomSlots } = require(path.join(moduleRoot, 'translation-policy'));
const { createTranslator, splitLongText } = require(path.join(moduleRoot, 'hans-translator'));

async function main() {
  const original = 'Check scrcpy in launch_scrcpy.py at 192.168.1.75:5555 and adb devices. React props need code injection; search transcripts.';
  const protectedText = protectText(original);
  assert(!protectedText.input.includes('192.168.1.75:5555'));
  assert(!protectedText.input.includes('scrcpy'));
  const restored = restoreText(protectedText.input, protectedText);
  assert(restored.includes('launch_scrcpy.py'));
  assert(restored.includes('192.168.1.75:5555'));
  assert(restored.includes('属性'));
  assert(restored.includes('注入'));
  assert(restored.includes('记录'));
  const prose = protectText('Any risk/benefit analysis and high-risk/deletion operations need confirmation.');
  assert.equal(prose.input, 'Any risk/benefit analysis and high-risk/deletion operations need confirmation.');
  assert(protectText('Open /usr/local/bin and C:\\tools\\run.py').values.includes('/usr/local/bin'));
  assert.equal(restoreText(protectedText.input.replace('ZXQHT0QXZ', ''), protectedText), null);
  assert.equal(restoreText(protectedText.input + 'ZXQHT0QXZ', protectedText), null);
  const token = 'ZXQHT123QXZ';
  const long = 'a'.repeat(28) + token + 'b'.repeat(40);
  const chunks = splitLongText(long, 32);
  assert.equal(chunks.join(''), long);
  assert(chunks.some((chunk) => chunk.includes(token)));
  assert(!validDomSlots('__X0__ text __X1__', '多余__X0__ 中文 __X1__'));

  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      calls++;
      const payload = JSON.parse(body);
      const texts = JSON.parse(payload.messages[0].content.split('\n').pop());
      const outputs = texts.map((text) => {
        if (text.includes('configuration is used') && text.includes('__X0__')) return '当使用__X2__配置时，__X0__选项默认为__X1__。';
        if (text.trim() === 'option defaults to') return ' 选项默认为 ';
        if (text.trim() === 'when the') return '，条件是使用 ';
        if (text.trim() === 'configuration is used.') return ' 配置。';
        if (text.trim() === 'corrupt') return text;
        if (text.includes('corrupt')) return '标记被破坏';
        if (text.includes('droptoken') && /ZXQHT\d+QXZ/.test(text)) return '丢掉保护标记';
        return '中文：' + text;
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(outputs) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hans-policy-test-'));
  const config = path.join(directory, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ provider: 'openai-compatible', model: 'fixture', url: 'http://127.0.0.1:' + server.address().port }));
  try {
    const translator = createTranslator(config);
    const source = 'The __X0__ option defaults to __X1__ when the __X2__ configuration is used.';
    const [output] = await translator.translate([source]);
    assert.equal(output, '__X0__ 选项默认为 __X1__，条件是使用 __X2__ 配置。');
    assert(validDomSlots(source, output));
    const before = calls;
    assert.equal((await translator.translate([source]))[0], output);
    assert.equal(calls, before, 'Only validated assembled output should be cached');
    assert.equal((await translator.translate(['corrupt scrcpy']))[0], null);
    const afterFailure = calls;
    assert.equal((await translator.translate(['corrupt scrcpy']))[0], null);
    assert(calls > afterFailure, 'Invalid protected tokens must not enter cache');
    const safe = (await translator.translate(['droptoken scrcpy is working.']))[0];
    assert(safe.includes('scrcpy'), 'Missing technical token must recover from original slots');
    assert(!safe.includes('丢掉保护标记'), 'Rejected raw output must not leak into final fallback');
    console.log(JSON.stringify({ passed: true, fallback: output, identifierProtection: restored, calls }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'hans-policy-test-')) throw new Error('Unexpected test cleanup path');
    fs.rmSync(directory, { recursive: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
