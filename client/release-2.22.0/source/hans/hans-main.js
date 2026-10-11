'use strict';

const path = require('node:path');
const { install: installBundleHook, getStatus } = require('./hans-bundle-hook');
const { createTranslator } = require('./hans-translator');

let installed = false;

function isTrustedSender(event) {
  try {
    const url = new URL(event.sender.getURL());
    const frame = new URL(event.senderFrame?.url || event.sender.getURL());
    return event.senderFrame === event.sender.mainFrame && url.protocol === 'https:' && url.hostname === '127.0.0.1' &&
      frame.origin === url.origin;
  } catch {
    return false;
  }
}

function install(electron) {
  if (installed) return;
  installed = true;
  installBundleHook(electron);
  electron.ipcMain.handle('hub-client:settings', event =>
    isTrustedSender(event) ? require('./hub-client-settings').read() : null);
  electron.ipcMain.handle('hans:status', (event) =>
    isTrustedSender(event) ? getStatus() : null);
  electron.ipcMain.handle('hans:translate-ui', () => []); // UI remains offline.
  const configPath = path.join(electron.app.getPath('userData'), 'hans-config.json');
  const translator = createTranslator(configPath, () => require('./hub-client-settings').read().thinking);
  electron.ipcMain.handle('hans:translate', async (event, texts) => {
    // Thinking translation is a separate explicit opt-in; UI never uses this channel.
    if (!require('./hub-client-settings').read().thinking || !isTrustedSender(event)) return Array.isArray(texts) ? texts.map(() => null) : [];
    try {
      const result = await translator.translate(texts);
      return require('./hub-client-settings').read().thinking ? result : texts.map(() => null);
    } catch (error) {
      console.warn('[Hans] Translation failed:', error.message);
      return Array.isArray(texts) ? texts.map(() => null) : [];
    }
  });
}

module.exports = { install };
