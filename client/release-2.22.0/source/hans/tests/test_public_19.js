'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleRoot = fs.existsSync(path.join(__dirname, 'rewrite')) ? path.join(__dirname, 'rewrite') : path.join(__dirname, '..');
const { createTranslator } = require(path.join(moduleRoot, 'hans-translator'));
const { validDomSlots } = require(path.join(moduleRoot, 'translation-policy'));
const samples = [
  'I am checking scrcpy in launch_scrcpy.py at 192.168.1.75:39959 via adb mdns.',
  'Prompt engineering helps the agent reason better.',
  'The thinking process took 1500 tokens in this agent turn.',
  'Avoid mutating props directly inside the React render cycle.',
  'Zero-shot prompt vs few-shot prompt comparison.',
  'Hans 19 represents the translation solution for Antigravity 2.17.0.',
  'The markdown rendering bug, displaying single tildes as strikethrough, stems from a misconfiguration within the markdown parsing library. The issue lies in how the __X0__ option is being defaulted to __X1__ when the __X2__ configuration is used. This behavior conflicts with the GFM specification, which mandates double tildes for strikethrough rendering. A hotfix leveraging the existing __X3__ framework appears to be the most appropriate solution.'
];
createTranslator('missing-test-config.json').translate(samples).then((results) => {
  assert(results.every((value) => typeof value === 'string'));
  for (const token of ['scrcpy', 'launch_scrcpy.py', '192.168.1.75:39959', 'adb mdns']) assert(results[0].includes(token));
  assert(results[1].includes('提示词工程'));
  assert(results[2].includes('Token'));
  assert(results[3].includes('属性'));
  assert(results[4].includes('零样本') && results[4].includes('少样本'));
  assert(results[5].includes('Antigravity'));
  assert(validDomSlots(samples[6], results[6]));
  console.log(JSON.stringify({ passed: true, results }));
}).catch((error) => { console.error(error); process.exitCode = 1; });
