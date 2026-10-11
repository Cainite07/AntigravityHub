'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { patchBundle, MARKERS } = require('../bundle_patch');

const file = process.argv[2] || path.join(__dirname, '..', 'work', '2.19.1-main.clean.js');
const source = fs.readFileSync(file, 'utf8');
for (const marker of MARKERS) {
  const expected = marker.expectedCount || 1;
  const actual = source.split(marker.from).length - 1;
  assert.equal(actual, expected, `${marker.name}: expected ${expected} original anchor(s), found ${actual}`);
}
const patched = patchBundle(source);
assert.equal(patched.structuralApplied, true, patched.reason);
assert.deepEqual(patched.skippedTextMarkers, []);
assert.equal(patched.appliedTextMarkers.length, 5);
assert(patched.source.includes('singleTilde:!1'));
assert.equal(patched.source.split('z.createElement(KZ,{text:"成果"})').length - 1, 2);
assert(patched.source.includes('"data-testid":"archived-chat-banner"'));
assert(patched.source.includes('正在创建终端...'));
console.log(JSON.stringify({
  version: '2.19.1',
  renderer: path.resolve(file),
  structuralMarkers: 7,
  textMarkers: patched.appliedTextMarkers,
  skipped: patched.skippedTextMarkers
}));
