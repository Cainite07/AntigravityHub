'use strict';
const crypto = require('node:crypto');
const { patchBundle } = require('./bundle_patch');
const REVIEWED_RENDERER_SHA256 = '47f36abaabd34f7d54a95df40d942b609c02db9f5c04d56b124a048571b9f16d';
const CURRENT_RENDERER_SHA256 = require('./ui-source-2230').sha256;
let installed = false;
let status = { version: 23, appVersion: '2.22.0', structuralApplied: false, reason: 'not-requested' };
const logged = new Set();
function getStatus() { return { ...status }; }
function isRendererBundle(request) {
  if (request.method !== 'GET') return false;
  try {
    const url = new URL(request.url);
    return url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.pathname === '/main.js';
  } catch { return false; }
}
function install(electron) {
  if (installed) return;
  installed = true;
  const { net, session } = electron;
  const appVersion=electron.app?.getVersion?.() || '2.22.0';
  session.defaultSession.protocol.handle('https', async request => {
    if (!isRendererBundle(request)) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    const response = await net.fetch(request.url, { bypassCustomProtocolHandlers: true, cache: 'no-store' });
    if (!response.ok) return response;
    if (!require('./hub-client-settings').read().localization) return response;
    const source = await response.text();
    const sha256 = crypto.createHash('sha256').update(source).digest('hex');
    const patched = [REVIEWED_RENDERER_SHA256,CURRENT_RENDERER_SHA256].includes(sha256) ? patchBundle(source) :
      { applied: false, structuralApplied: false, reason: 'Unreviewed renderer SHA-256', source };
    status = { version: 23, appVersion, rendererSha256: sha256,
      structuralApplied: !!patched.structuralApplied, uiSourceCount: patched.uiSourceCount || 0, contextualCount: patched.contextualCount || 0, textMarkers: patched.appliedTextMarkers || [],
      skippedTextMarkers: patched.skippedTextMarkers || [], reason: patched.reason || null };
    const logKey = JSON.stringify(status);
    if (!logged.has(logKey)) {
      logged.add(logKey);
      if (patched.applied) console.log('[Hans23] Renderer verified:', JSON.stringify(status));
      else console.warn('[Hans23] Renderer patch skipped:', JSON.stringify(status));
    }
    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'etag', 'last-modified']) headers.delete(name);
    headers.set('content-type', 'text/javascript; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(patched.source, { status: response.status, headers });
  });
}
module.exports = { install, getStatus, isRendererBundle };
