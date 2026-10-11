'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const DEFAULTS = Object.freeze({localization:false, thinking:false, customSize:false, width:1400, height:900});
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {...DEFAULTS};
  const width = value.ClientWindowWidth, height = value.ClientWindowHeight;
  const validSize = Number.isInteger(width) && width >= 640 && width <= 7680 &&
    Number.isInteger(height) && height >= 480 && height <= 4320;
  return {
    localization:value.EnableClientLocalization === true,
    thinking:value.EnableThinkingTranslation === true,
    customSize:value.EnableClientWindowSize === true && validSize,
    width:validSize ? width : DEFAULTS.width,
    height:validSize ? height : DEFAULTS.height
  };
}
function read() {
  try {
    const file = path.join(os.homedir(), '.antigravity_hub', 'app_settings.json');
    const stat = fs.statSync(file);
    if (stat.size > 65536) return {...DEFAULTS};
    return normalize(JSON.parse(fs.readFileSync(file,'utf8')));
  } catch { return {...DEFAULTS}; }
}
// A same-user, per-process capability. Request the official quit lifecycle,
// rather than closing a window which may only move the app to the tray.
function installControl(app, {directory = path.join(os.homedir(), '.antigravity_hub', 'client_control'), pid = process.pid, now = Date.now} = {}) {
  fs.mkdirSync(directory, {recursive:true});
  const ready = path.join(directory, `ready-${pid}.json`);
  const request = path.join(directory, `request-${pid}.json`);
  const nonce = require('node:crypto').randomBytes(32).toString('hex');
  const consumed = new Set();
  function check() {
    try {
      if (fs.lstatSync(request).isSymbolicLink() || fs.statSync(request).size > 4096) return;
      const value = JSON.parse(fs.readFileSync(request, 'utf8'));
      if (value.pid !== pid || value.nonce !== nonce || value.action !== 'quit' ||
          !/^[0-9a-f-]{36}$/i.test(value.id || '') || consumed.has(value.id) ||
          !Number.isSafeInteger(value.issuedAt) || now()-value.issuedAt > 10000 || value.issuedAt-now() > 2000) return;
      fs.unlinkSync(request);
      consumed.add(value.id);
      if (consumed.size > 32) consumed.delete(consumed.values().next().value);
      app.quit();
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[Hub quit]', error.message); }
  }
  const watcher = fs.watch(directory, (_event, file) => { if (String(file) === path.basename(request)) check(); });
  fs.writeFileSync(ready, JSON.stringify({pid, nonce, executable:app.getPath('exe')}));
  function cleanup() {
    watcher.close();
    for (const file of [ready, request]) { try { fs.unlinkSync(file); } catch {} }
  }
  app.once('quit', cleanup);
  return {check, cleanup};
}
module.exports = {read, normalize, DEFAULTS, installControl};
