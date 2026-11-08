'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tools=path.resolve(__dirname,'../client/maintenance/tools');
const hans=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const reviewed=require(path.join(hans,'ui-source-2282'));
const profile=require(path.join(tools,'profiles.cjs')).forVersion('2.28.2');
assert.equal(profile.rendererSha256,reviewed.sha256);
assert.equal(require(path.join(tools,'profiles.cjs')).forVersion('99.0.0'),null);
assert(profile.targetModules['dist/hub-update-guard.js']);
for(const term of ['Mark All as Read','Remote Agents Data','Select Billing Model','Signed-in accounts','Open Links In','Trigger','Give Feedback',
 'Built-in Browser','External Browser','Configure link opening and built-in browser preferences.','Choose where links open by default when clicked.',
 'Search tabs, files, extensions, subagents, artifacts, commands...','Search tabs, files, extensions, artifacts, commands...'])
 assert(reviewed.patches.some(p=>p.from===JSON.stringify(term)),term);
for(const term of ['Google Docs','Firebase','Buganizer','Critique','Finder','Google Chrome','Gemini Enterprise'])
 assert(!reviewed.patches.some(p=>p.from===JSON.stringify(term)),term);
if(process.env.ANTIGRAVITY_RENDERER_2282){
 const original=fs.readFileSync(process.env.ANTIGRAVITY_RENDERER_2282,'utf8');
 const patched=require(path.join(hans,'bundle_patch')).patchBundle(original);
 assert(patched.applied);assert.equal(patched.structuralApplied,false);new vm.Script(patched.source);
 let end=0;const expected=[];
 for(const patch of reviewed.patches){assert.equal(original.slice(patch.start,patch.end),patch.from);expected.push(original.slice(end,patch.start),patch.to);end=patch.end;}
 expected.push(original.slice(end));assert.equal(patched.source,expected.join(''));
 const loaded=Object.keys(require.cache).filter(file=>/ui-source-\d+\.js$/.test(file));
 assert.equal(loaded.length,1,'Historical translation modules should not occupy memory for the current client');
 assert.equal(require(path.join(hans,'bundle_patch')).patchBundle(original+'\n').applied,false);
}
const calls=[],callbacks={};let spawnCount=0;
const moduleMock={exports:{}};
vm.runInNewContext(fs.readFileSync(path.join(tools,'hub-update-guard.js'),'utf8'),{module:moduleMock,require:name=>{
 if(name==='./hub-client-settings')return{read:()=>({localization:true})};
 if(name==='node:fs')return{readFileSync:()=>JSON.stringify({hubRoot:'C:/Program Files/Hub'}),existsSync:()=>true};
 if(name==='node:path')return path;
 if(name==='node:os')return{homedir:()=>'C:/User'};
 if(name==='node:child_process')return{spawn:(exe,args,options)=>{spawnCount++;calls.push({exe,args,options});return{unref(){}};}};
 throw Error(name);
}});
moduleMock.exports.install({app:{on:(event,callback)=>{callbacks[event]=callback;}}});
callbacks['before-quit']();callbacks['before-quit']();assert.equal(spawnCount,1);
assert.equal(calls[0].args[1],'--after-update');assert(calls[0].options.windowsHide);assert(calls[0].options.detached);assert.equal(calls[0].options.stdio,'ignore');
console.log('PASS: 2.28.2 reviewed UI spans/syntax, all unrelated renderer bytes retained, unknown fingerprints rejected, product names retained, normal-quit update handoff starts once with argument boundaries and no client termination.');
