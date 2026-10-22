'use strict';
// Exercise the same working directory as the hidden desktop maintenance flow.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const tools=path.resolve(__dirname,'../client/maintenance/tools');
for (const profile of require(path.join(tools,'profiles.cjs')).profiles) {
const base=path.resolve(tools,profile.baseArchive);
const inspected=spawnSync(process.execPath,[path.join(tools,'prepare.cjs'),'--inspect',base],{cwd:tools,encoding:'utf8'});
assert.equal(inspected.status,0,inspected.stderr);
const supported=JSON.parse(inspected.stdout);assert.equal(supported.version,profile.version);assert(supported.supported);
assert(supported.supportedVersions.includes('2.24.0') && supported.supportedVersions.includes('2.25.0'));

const out=path.resolve(__dirname,'../work/package-check-'+Date.now());
assert(fs.existsSync(path.join(tools,'package.json')));
const result=spawnSync(process.execPath,[path.join(tools,'prepare.cjs'),'--prepare',base,out],{cwd:tools,encoding:'utf8'});
assert.equal(result.status,0,result.stderr||result.stdout);
const verification=JSON.parse(fs.readFileSync(path.join(out,'verification.json')));
assert.equal(verification.unrelatedPayloadsPreserved,true);
assert.deepEqual(verification.integrityIssues,[]);
console.log('PASS: packaged maintenance working directory, original payload preservation and complete candidate integrity.');
}
