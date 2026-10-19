'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const {patchBundle}=require(path.join(root,'bundle_patch'));
for (const [version,module,environment] of [['2.23.0','ui-source-2230','ANTIGRAVITY_RENDERER_2230'],['2.23.1','ui-source-2231','ANTIGRAVITY_RENDERER_2231'],['2.24.0','ui-source-2240','ANTIGRAVITY_RENDERER_2240']]) {
const reviewed=require(path.join(root,module));
assert.equal(patchBundle('unknown renderer').applied,false);
const profile=require('../client/maintenance/tools/profiles.cjs').forVersion(version);
assert.equal(profile.rendererSha256,reviewed.sha256);
assert.equal(require('../client/maintenance/tools/profiles.cjs').forVersion('99.0.0'),null);
assert(reviewed.patches.length>3000);
for(const term of ['Request Review','Every command requires approval.','Ask before sensitive operations.','Run all commands without restrictions.','No custom agents yet.',...(version==='2.24.0'?[]:['No automations configured.']),'This chat is archived.','Restore'])
  assert(reviewed.patches.some(p=>p.from===JSON.stringify(term)),term);
for(const term of ['Google Docs','Firebase','Science','Chrome DevTools','Android CLI','Google Antigravity SDK'])
  assert(!reviewed.patches.some(p=>p.from===JSON.stringify(term)),term);
if(version==='2.24.0') {
  for(const term of ['Context window','Conversation turns','Refresh all credentials','Time Zone','Context Providers','Console Telemetry','Runs on'])
    assert(reviewed.patches.some(p=>p.from===JSON.stringify(term)),term);
  for(const term of ['This page is going away soon','Search conversations with','View archived in the sidebar (![filter](icon://filter_list) menu).'])
    assert(reviewed.patches.some(p=>p.from===JSON.stringify(term)),term);
  const dictionary=require(path.join(root,'ui_overrides.json'));
  for(const term of ['Credentials for one or more automations have expired.','Play a sound when your action is needed or the agent finishes.','Event triggers need Cloud'])
    assert(dictionary[term] && dictionary[term]!==term,term);
}
if(process.env[environment]){
  const source=fs.readFileSync(process.env[environment],'utf8');
  const result=patchBundle(source);
  assert.equal(result.applied,true);assert.equal(result.structuralApplied,false);
  new vm.Script(result.source);
  assert.equal(patchBundle(source+'\n').applied,false,'Changed source hash must reject all source edits');
  // Reconstruct the entire output from the reviewed display-only spans. Every
  // byte outside those spans, including streaming and permission logic, is retained.
  let position=0,expected='';
  for(const p of reviewed.patches){assert.equal(source.slice(p.start,p.end),p.from);expected+=source.slice(position,p.start)+p.to;position=p.end;}
  expected+=source.slice(position);assert.equal(result.source,expected);
  console.log(version+' PASS: exact renderer syntax, display-only edits, all other bytes retained, altered hash rejected.');
}
console.log(version+' PASS: profile, permission/empty/archive UI coverage, plugin/product names unchanged, unknown versions rejected.');

}
