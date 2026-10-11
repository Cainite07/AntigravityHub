'use strict';

// Text tokens may move in Chinese; DOM tokens must remain in their original slots.
function protectText(text) {
  const values = [];
  const rules = [
    [/\bprompt engineering\b/gi, '提示词工程'],
    [/\bdomain-specific terminology\b/gi, '领域专用术语'],
    [/\bfree translation\b/gi, '免费翻译'],
    [/\bsuperior translation quality\b/gi, '更好的翻译质量'],
    [/\bzero-shot\b/gi, '零样本'], [/\bfew-shot\b/gi, '少样本'],
    [/\bRelease APK\b/g, 'Release 版 APK']
  ];
  if (/\b(?:React|render|component)\b/i.test(text)) rules.push([/\bprops\b/g, '属性']);
  if (/\b(?:code|DOM|preload|patch|script|render|button)\b/i.test(text)) rules.push([/\binjections?\b/gi, '注入']);
  if (/\b(?:conversation|chat|code|session|search)\b/i.test(text)) rules.push([/\btranscripts?\b/gi, '记录']);
  if (/\b(?:thinking|model|agent|LLM|prompt)\b/i.test(text)) {
    rules.push([/\btokens?\b/gi, 'Token'], [/\bprompts?\b/gi, '提示词'], [/\bagent turn\b/gi, '智能体轮次'], [/\bagents?\b/gi, '智能体']);
  }
  const save = (value) => { const token = 'ZXQHT' + values.length + 'QXZ'; values.push(value); return token; };
  // Shield identifiers first. Term rules cannot modify already protected values.
  let input = text.replace(/https?:\/\/[^\s<>"`]+|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|(?<![\w-])(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[\w./\\-]+|\b[\w.-]+\.(?:py|js|ts|tsx|jsx|json|md|lua|apk|exe|dll|asar|yaml|yml|toml|sh|ps1)\b|\b(?:Antigravity|scrcpy|MudLife|TranSmart|ADB|APK|GFM|React|Electron|Ollama)\b|\bHans\s+\d+\b/g, (value) => save(value));
  input = input.replace(/\badb(?:\s+(?:devices|mdns))?\b/g, (value) => save(value));
  input = input.replace(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z_]\w*_\w+\b/g, (value) => /^__(?:X\d+|HANS_T\d+)__$/.test(value) ? value : save(value));
  for (const [pattern, replacement] of rules) input = input.replace(pattern, () => save(replacement));
  return { input, values };
}

function restoreText(text, protectedText) {
  if (typeof text !== 'string') return null;
  const seen = new Set();
  let invalid = false;
  const result = text.replace(/ZXQHT(\d+)QXZ/g, (_, idText) => {
    const id = Number(idText);
    if (id >= protectedText.values.length || seen.has(id)) { invalid = true; return ''; }
    seen.add(id);
    return protectedText.values[id];
  });
  if (invalid || seen.size !== protectedText.values.length || /ZXQHT/.test(result)) return null;
  return result;
}

function validDomSlots(source, output) {
  if (typeof output !== 'string') return false;
  const markers = (value) => value.match(/__X\d+__/g) || [];
  if (JSON.stringify(markers(source)) !== JSON.stringify(markers(output))) return false;
  const sourceParts = source.split(/__X\d+__/g);
  const outputParts = output.split(/__X\d+__/g);
  return sourceParts.every((part, index) => part.trim() || !outputParts[index].trim());
}

function hasTranslatableText(input) {
  return /[A-Za-z]/.test(input.replace(/ZXQHT\d+QXZ|__X\d+__/g, ''));
}

module.exports = { protectText, restoreText, validDomSlots, hasTranslatableText };
