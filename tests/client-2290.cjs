'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const tools = path.resolve(__dirname, '../client/maintenance/tools');
const { trusted } = require(path.join(tools, 'hud/hub-hud-main.js'));

// Exercise native restored and cascaded windows as well as the user's size override.
const display = { bounds: { x: 1920, y: 0, width: 1600, height: 1000 }, workArea: { x: 1920, y: 0, width: 1600, height: 960 } };
const native = { x: 2050, y: 120, width: 880, height: 610, isMaximized: true, isFullScreen: false };
let settings = { customSize: false, width: 1280, height: 750 };
let screenLookups = 0;
const screen = {
  getDisplayMatching(rect) { assert.equal(rect.x, native.x); screenLookups++; return display; },
  getPrimaryDisplay() { throw Error('Lost the saved monitor'); }
};
const mock = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(tools, 'layout.js'), 'utf8'), {
  module: mock, process: { argv: [] }, setImmediate, clearImmediate,
  require: name => name === 'electron' ? { screen } : { read: () => settings }
});
const layout = mock.exports;
assert.equal(layout.initialState(native), native);
assert.equal(screenLookups, 0);
settings.customSize = true;
assert.deepEqual({ ...layout.initialState(native) }, { x: 2080, y: 125, width: 1280, height: 750, isMaximized: false, isFullScreen: false });
assert.equal(native.isMaximized, true);
settings.customSize = false;

const win = new EventEmitter();
const primary = { mainFrame: { url: 'https://127.0.0.1:42000/' } };
win.webContents = primary;
win.isDestroyed = () => false;
win.show = () => { throw Error('Native window visibility changed on attach'); };
win.getBounds = () => { throw Error('Unexpected window state override'); };
layout.attach(win, { nativeVisibility: true });
const event = sender => ({ senderFrame: sender.mainFrame, sender });
const windows = { fromWebContents: () => null };
assert(trusted(event(primary), windows, layout.ownsWebContents));
const guest = { mainFrame: { url: primary.mainFrame.url } };
assert.equal(trusted(event(guest), windows, layout.ownsWebContents), false);
assert.equal(trusted({ senderFrame: guest.mainFrame, sender: primary }, windows, layout.ownsWebContents), false);
win.emit('closed');
assert.equal(trusted(event(primary), windows, layout.ownsWebContents), false);

(async () => {
  const profile = require(path.join(tools, 'profiles.cjs')).forVersion('2.29.0');
  const base = path.resolve(tools, profile.baseArchive);
  const asar = await import(pathToFileURL(path.join(tools, 'node_modules/@electron/asar/lib/asar.js')).href);
  const extract = name => asar.extractFile(base, path.normalize('dist/' + name + '.js'));
  const adapter = require(path.join(tools, 'adapter2191.cjs'));
  const { utils } = adapter.transform2191(extract('utils'), extract('tray'));
  new vm.Script(utils);
  assert.match(utils, /codexLayout\.initialState\(\(0, windowState_1\.resolveInitialWindowState\)\(/);
  assert.match(utils, /codexLayout\.attach\(win, \{ nativeVisibility: true \}\)/);
  for (const nativeCode of ['new electron_1.BrowserWindow(windowOptions)', 'new electron_1.BaseWindow',
    'cascadeFromWindow:', 'win.maximize?.()', 'win.setFullScreen?.(true)', 'windowState_1.trackWindowState',
    "hubContents.on('will-redirect', guardExternalNavigation)", 'hubContents.setZoomLevel(level)']) assert(utils.includes(nativeCode), nativeCode);
  assert.throws(() => adapter.transform2191(Buffer.concat([extract('utils'), Buffer.from('\n')]), extract('tray')), /Unreviewed/);
  const changesFromBase = require(path.join(tools, 'unified-build.cjs')).changesFromBase;
  const current = changesFromBase(asar, base);
  const prior = require(path.join(tools, 'profiles.cjs')).forVersion('2.28.2');
  const previous = changesFromBase(asar, path.resolve(tools, prior.baseArchive));
  const overrides = require(path.resolve(tools, '../../release-2.22.0/source/hans/ui-overrides-2290.json'));
  const menuEntry = '"All runs":' + JSON.stringify(overrides['All runs']);
  assert(current.get('dist/preload.js').toString().includes(menuEntry));
  assert(!previous.get('dist/preload.js').toString().includes(menuEntry));
  assert(current.has('dist/ui-source-2290.js'));
  assert.equal(JSON.parse(current.get('dist/ui-source-index.json'))[profile.rendererSha256], 'ui-source-2290');
  console.log('PASS: 2.29.0 native recovery, custom size/monitor, both window backends, primary HUD sender and version-specific translations.');
})().catch(error => { console.error(error); process.exitCode = 1; });
