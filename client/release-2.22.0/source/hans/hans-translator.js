'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const querystring = require('node:querystring');
const { protectText, restoreText, validDomSlots, hasTranslatableText } = require('./translation-policy');

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestJson(endpoint, payload, contentType, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(new Error('Unsupported translation endpoint'));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const request = transport.request(url, {
      method: 'POST',
      agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: {
        'content-type': contentType,
        'content-length': Buffer.byteLength(body),
        'user-agent': 'Antigravity-Hans/21',
        ...extraHeaders
      }
    }, (response) => {
      const parts = [];
      let size = 0;
      response.on('data', (part) => {
        size += part.length;
        if (size > 1024 * 1024) {
          request.destroy(new Error('Translation response too large'));
          return;
        }
        parts.push(part);
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('Translation HTTP ' + response.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
        } catch {
          reject(new Error('Invalid translation JSON'));
        }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Translation timeout')), timeoutMs);
    request.on('error', reject);
    request.on('close', () => clearTimeout(deadline));
    request.end(body);
  });
}

function validTranslation(value, original) {
  if (typeof value !== 'string' || !value.trim() || value.trim() === original.trim()) return false;
  const source = original.replace(/__X\d+__|ZXQHT\d+QXZ/g, '');
  const output = value.replace(/__X\d+__|ZXQHT\d+QXZ/g, '');
  const sourceLatin = (source.match(/[A-Za-z]/g) || []).length;
  if (sourceLatin < 50) return true;
  const outputLatin = (output.match(/[A-Za-z]/g) || []).length;
  const outputChinese = (output.match(/[\u3400-\u9fff]/g) || []).length;
  return !(outputLatin > sourceLatin * 0.48 && outputChinese < sourceLatin * 0.18);
}

async function tencentBatch(texts) {
  const response = await requestJson(
    'https://transmart.qq.com/api/imt',
    {
      header: { fn: 'auto_translation', client_key: 'browser-chrome-122.0.0.0' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'en', text_list: texts },
      target: { lang: 'zh' }
    },
    'application/json',
    {},
    5500
  );
  const values = response && response.auto_translation;
  if (!Array.isArray(values) || values.length !== texts.length ||
      (response.header && response.header.ret_code && response.header.ret_code !== 'succ')) {
    throw new Error('Invalid Tencent translation response');
  }
  return values;
}

async function youdaoSingle(text) {
  const response = await requestJson(
    'https://aidemo.youdao.com/trans',
    querystring.stringify({ from: 'en', to: 'zh-CHS', q: text }),
    'application/x-www-form-urlencoded; charset=UTF-8',
    {},
    4500
  );
  if (response && String(response.errorCode || '0') === '411') {
    throw new Error('Youdao rate limit');
  }
  const value = response && response.translation && response.translation[0];
  if (!validTranslation(value, text)) throw new Error('Invalid Youdao translation');
  return value;
}

function readConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config && typeof config === 'object') return config;
  } catch {}
  return { provider: 'tencent' };
}

async function customBatch(texts, config) {
  const provider = config.provider;
  const model = String(config.model || '').trim();
  if (!model) throw new Error('Translation model is required');
  const prompt = 'Translate each English entry into natural Simplified Chinese. Preserve every marker such as __X0__ exactly. Return ONLY a JSON array of strings in the same order.\n' + JSON.stringify(texts);
  let raw;
  if (provider === 'ollama') {
    const endpoint = config.url || 'http://127.0.0.1:11434/api/generate';
    const result = await requestJson(endpoint, {
      model,
      prompt,
      stream: false,
      format: 'json'
    }, 'application/json', {}, 20000);
    raw = result && result.response;
  } else if (provider === 'openai-compatible') {
    const endpoint = String(config.url || '').trim();
    if (!endpoint) throw new Error('Translation URL is required');
    const headers = {};
    if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;
    const result = await requestJson(endpoint, {
      model,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    }, 'application/json', headers, 20000);
    raw = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  } else {
    throw new Error('Unsupported provider');
  }
  if (typeof raw !== 'string') throw new Error('Invalid model response');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Missing translation array');
  const values = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(values) || values.length !== texts.length || values.some((value) => typeof value !== 'string')) {
    throw new Error('Invalid model translation array');
  }
  return values;
}

function splitLongText(text, maxLength = 3500) {
  if (text.length <= maxLength) return [text];
  const result = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let boundary = Math.max(
      remaining.lastIndexOf('. ', maxLength),
      remaining.lastIndexOf('! ', maxLength),
      remaining.lastIndexOf('? ', maxLength),
      remaining.lastIndexOf('; ', maxLength),
      remaining.lastIndexOf(' ', maxLength)
    );
    if (boundary < maxLength / 2) boundary = maxLength;
    else boundary += 1;
    for (const marker of remaining.matchAll(/__X\d+__|ZXQHT\d+QXZ/g)) {
      if (marker.index < boundary && marker.index + marker[0].length > boundary) {
        boundary = marker.index || marker[0].length;
        break;
      }
    }
    result.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) result.push(remaining);
  return result;
}

function createTranslator(configPath, isEnabled = () => true) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastRemoteAt = 0;
  const config = readConfig(configPath);

  async function pace(minGapMs) {
    const wait = Math.max(0, lastRemoteAt + minGapMs - Date.now());
    if (wait) await delay(wait);
    lastRemoteAt = Date.now();
  }

  async function translateChunk(texts) {
    if (!isEnabled()) return texts.map(() => null);
    let values = null;
    const custom = config.provider === 'ollama' || config.provider === 'openai-compatible';
    const publicAllowed = !custom || config.allowPublicFallback === true;
    if (custom) {
      try {
        if (!isEnabled()) return texts.map(() => null);
        values = await customBatch(texts, config);
      } catch (error) {
        console.warn('[Hans] Configured translator failed:', error.message);
        if (!publicAllowed) return texts.map(() => null);
      }
    }
    if (!values && publicAllowed) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await pace(250);
          if (!isEnabled()) return texts.map(() => null);
          values = await tencentBatch(texts);
          break;
        } catch (error) {
          console.warn('[Hans] Tencent translation attempt failed:', error.message);
          if (attempt === 0) await delay(350);
        }
      }
    }
    const results = texts.map((text, index) => {
      const value = values && values[index];
      return validTranslation(value, text) ? value : null;
    });
    if (!publicAllowed) return results;
    for (let i = 0; i < results.length; i++) {
      if (results[i]) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await pace(650);
          if (!isEnabled()) return texts.map(() => null);
          results[i] = await youdaoSingle(texts[i]);
          break;
        } catch (error) {
          console.warn('[Hans] Youdao translation attempt failed:', error.message);
          if (attempt === 0) await delay(700);
        }
      }
    }
    return results;
  }

  async function translateRaw(texts) {
    const expanded = [];
    const ranges = texts.map((text) => {
      const chunks = splitLongText(text);
      const start = expanded.length;
      expanded.push(...chunks);
      return { start, count: chunks.length };
    });
    const translated = new Array(expanded.length);
    for (let start = 0; start < expanded.length; start += 12) {
      const batch = expanded.slice(start, start + 12);
      const values = await translateChunk(batch);
      for (let i = 0; i < values.length; i++) translated[start + i] = values[i];
    }
    return ranges.map(({ start, count }) => {
      const parts = translated.slice(start, start + count);
      return parts.every((part) => typeof part === 'string') ? parts.join('') : null;
    });
  }

  async function translateProtected(texts) {
    const prepared = texts.map(protectText);
    const requestIndices = prepared.map((item, index) => hasTranslatableText(item.input) ? index : -1).filter((index) => index >= 0);
    const raw = requestIndices.length ? await translateRaw(requestIndices.map((index) => prepared[index].input)) : [];
    const outputs = prepared.map((item) => item.input);
    requestIndices.forEach((index, offset) => { outputs[index] = raw[offset]; });
    const results = outputs.map((value, index) => restoreText(value, prepared[index]));
    const fragments = [];
    const fallbacks = [];
    prepared.forEach((item, index) => {
      if (results[index] !== null || !item.values.length) return;
      const parts = item.input.split(/(ZXQHT\d+QXZ)/g);
      const slots = [];
      parts.forEach((part, position) => {
        if (position % 2 || !hasTranslatableText(part)) return;
        if (/^\s*(?:the|a|an)\s+$/i.test(part)) { parts[position] = ''; return; }
        slots.push({ position, offset: fragments.length });
        fragments.push(part);
      });
      fallbacks.push({ index, parts, slots });
    });
    const translated = fragments.length ? await translateRaw(fragments) : [];
    for (const fallback of fallbacks) {
      if (fallback.slots.some((slot) => typeof translated[slot.offset] !== 'string')) continue;
      for (const slot of fallback.slots) fallback.parts[slot.position] = translated[slot.offset];
      results[fallback.index] = restoreText(fallback.parts.join(''), prepared[fallback.index]);
    }
    return results;
  }

  async function translateQueued(texts) {
    const results = await translateProtected(texts);
    const fragments = [];
    const fallbacks = [];
    texts.forEach((text, index) => {
      if (validDomSlots(text, results[index])) return;
      results[index] = null;
      if (!/__X\d+__/.test(text)) return;
      const parts = text.split(/(__X\d+__)/g);
      const slots = [];
      parts.forEach((part, position) => {
        if (position % 2 || !/[A-Za-z]/.test(part)) return;
        if (/^\s*(?:the|a|an)\s+$/i.test(part)) { parts[position] = ''; return; }
        if (/^\s*when(?: the)?\s*$/i.test(part)) { parts[position] = '，条件是使用 '; return; }
        if (/^\s*option (?:defaults|is being defaulted) to\s*$/i.test(part)) { parts[position] = ' 选项默认为 '; return; }
        let prefix = '';
        const configuration = part.match(/^\s*configuration is used\.(\s*[\s\S]*)$/i);
        if (configuration) {
          prefix = ' 配置。';
          part = configuration[1];
          if (!/[A-Za-z]/.test(part)) { parts[position] = prefix + part; return; }
        }
        slots.push({ position, offset: fragments.length, prefix });
        fragments.push(part);
      });
      fallbacks.push({ index, parts, slots });
    });
    const translatedFragments = fragments.length ? await translateProtected(fragments) : [];
    for (const fallback of fallbacks) {
      if (fallback.slots.some((slot) => typeof translatedFragments[slot.offset] !== 'string')) continue;
      for (const slot of fallback.slots) fallback.parts[slot.position] = slot.prefix + translatedFragments[slot.offset];
      const output = fallback.parts.join('');
      if (validDomSlots(texts[fallback.index], output)) results[fallback.index] = output;
    }
    return results;
  }

  function remember(source, translation) {
    cache.delete(source);
    cache.set(source, translation);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
  }

  function translate(texts) {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 30 ||
        texts.some((text) => typeof text !== 'string' || text.length < 1 || text.length > 20000) ||
        texts.reduce((sum, text) => sum + text.length, 0) > 60000) {
      return Promise.resolve(Array.isArray(texts) ? texts.map(() => null) : []);
    }
    const job = queue.then(async () => {
      const result = new Array(texts.length);
      const missing = [];
      const indices = [];
      for (let i = 0; i < texts.length; i++) {
        if (cache.has(texts[i])) {
          result[i] = cache.get(texts[i]);
          continue;
        }
        indices.push(i);
        missing.push(texts[i]);
      }
      if (missing.length) {
        const values = await translateQueued(missing);
        for (let i = 0; i < values.length; i++) {
          result[indices[i]] = values[i];
          if (values[i]) remember(missing[i], values[i]);
        }
      }
      return result;
    });
    queue = job.catch(() => {});
    return job;
  }

  return { translate };
}

module.exports = { createTranslator, splitLongText, validTranslation };
