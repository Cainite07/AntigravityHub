'use strict';
// Antigravity layout policy v1. All coordinates below are Electron DIPs.
const { screen } = require('electron');
const { read } = require('./hub-client-settings');
const windows = new Map();
let lastActive = null;
const keys = ['x', 'y', 'width', 'height'];

function targetBounds(win) {
    const display = win && !win.isDestroyed()
        ? screen.getDisplayMatching(win.getNormalBounds())
        : screen.getPrimaryDisplay();
    const area = display.workArea;
    const settings = read();
    const width = Math.min(settings.customSize ? settings.width : 1400, area.width);
    const height = Math.min(settings.customSize ? settings.height : 900, area.height);
    // Retain the requested full-screen center; clamp to the usable area.
    const x = Math.floor(display.bounds.x + (display.bounds.width - width) / 2);
    const y = Math.floor(display.bounds.y + (display.bounds.height - height) / 2);
    return {
        x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
        width, height,
    };
}

function applyBounds(win) {
    if (!read().customSize) return;
    const state = windows.get(win);
    const target = targetBounds(win);
    const current = win.getBounds();
    if (keys.every(key => current[key] === target[key])) return;
    // Some fractional-DPI/non-client-frame combinations add an extra DIP.
    // Learn that conversion offset with at most two writes; never poll.
    if (state.accepted && keys.every(key => state.target[key] === target[key] && state.accepted[key] === current[key])) return;
    let actual;
    for (let attempt = 0; attempt < 2; attempt++) {
        const requested = Object.fromEntries(keys.map(key => [key, target[key] - state.bias[key]]));
        win.setBounds(requested, false);
        actual = win.getBounds();
        if (keys.every(key => actual[key] === target[key])) break;
        for (const key of keys) state.bias[key] += actual[key] - target[key];
    }
    state.target = target;
    state.accepted = keys.every(key => Math.abs(actual[key] - target[key]) <= 1) ? actual : null;
}

function requestReset(win) {
    const state = windows.get(win);
    if (!state || win.isDestroyed() || !read().customSize) return;
    state.requested = true;
    if (state.job) return;
    state.job = setImmediate(() => {
        state.job = null;
        if (win.isDestroyed() || !state.requested || win.isMinimized()) return;
        if (win.isFullScreen()) {
            win.setFullScreen(false);
            return; // resume on leave-full-screen
        }
        if (win.isMaximized()) {
            win.unmaximize();
            if (!win.isMaximized()) requestReset(win);
            return;
        }
        state.requested = false;
        applyBounds(win);
    });
}

function attach(win) {
    if (windows.has(win)) return;
    const state = { job: null, requested: false, bias: { x: 0, y: 0, width: 0, height: 0 }, target: null, accepted: null };
    windows.set(win, state);
    lastActive = win;
    win.on('focus', () => { lastActive = win; });
    win.on('show', () => requestReset(win));
    win.on('restore', () => requestReset(win));
    win.on('unmaximize', () => requestReset(win));
    win.on('leave-full-screen', () => requestReset(win));
    win.once('closed', () => {
        if (state.job) clearImmediate(state.job);
        windows.delete(win);
        if (lastActive === win) lastActive = null;
    });
    applyBounds(win);
    win.show();
}

function selectWindow() {
    for (const win of windows.keys()) {
        if (!win.isDestroyed() && win.isFocused()) return win;
    }
    if (lastActive && windows.has(lastActive) && !lastActive.isDestroyed()) return lastActive;
    return [...windows.keys()].find(win => !win.isDestroyed()) || null;
}

function reveal(win) {
    if (!windows.has(win) || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isMinimized() && !win.isMaximized() && !win.isFullScreen()) applyBounds(win);
    requestReset(win);
    win.show();
    win.focus();
}

module.exports = { targetBounds, attach, selectWindow, reveal };
