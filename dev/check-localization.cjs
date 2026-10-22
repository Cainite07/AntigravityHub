'use strict';
// Packaging gate. Uses only checked-in client UI inventories, never user chats.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {audit}=require('./localization-audit.cjs');
const root=path.resolve(__dirname,'..'),hans=path.join(root,'client/release-2.22.0/source/hans');
const dict={...require(path.join(hans,'ui_dictionary.json')),...require(path.join(hans,'ui_overrides.json'))};
const outputIndex=process.argv.indexOf('--output');
const reports=[];let errors=0;
for(const dir of fs.readdirSync(path.join(root,'client')).filter(n=>n.startsWith('release-'))){
  const source=path.join(root,'client',dir,'source'),manifestPath=path.join(source,'ui-source-manifest.json');
  if(!fs.existsSync(manifestPath))continue;
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  // 2.22 predates the source-span reviewer and uses its original guarded rules.
  if(!manifest.patches || manifest.version==='2.19.1')continue;
  const inventoryPath=path.join(source,'ui-audit-inventory.json');
  if(!fs.existsSync(inventoryPath))throw Error('Missing UI inventory: '+dir);
  const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
  if(inventory.rendererSha256!==manifest.rendererSha256 || inventory.version!==manifest.version)throw Error('Stale UI inventory: '+dir);
  const runtime=path.join(hans,'ui-source-'+manifest.version.replaceAll('.','')+'.js');
  const shipped=require(runtime);
  if(shipped.sha256!==manifest.rendererSha256 || JSON.stringify(shipped.patches)!==JSON.stringify(manifest.patches.map(({start,end,from,to})=>({start,end,from,to}))))throw Error('Runtime patch mismatch: '+dir);
  let end=-1;
  for(const p of manifest.patches){if(p.start<end || p.from.length!==p.end-p.start)throw Error('Invalid UI marker: '+dir);end=p.end;}
  const digest=crypto.createHash('sha256').update(fs.readFileSync(runtime)).digest('hex');
  const profile=require('../client/maintenance/tools/profiles.cjs').forVersion(manifest.version);
  if(!profile || profile.rendererSha256!==manifest.rendererSha256 || profile.targetModules['dist/'+path.basename(runtime)]!==digest)throw Error('Client profile needs review: '+dir);
  const report=audit({...inventory,patches:manifest.patches},dict);
  errors+=(report.summary['known-unapplied']||0)+(report.summary['invalid-marker']||0);
  reports.push(report);
  console.log(dir+': '+JSON.stringify(report.summary));
}
if(!reports.length)throw Error('No localization inventories checked');
if(outputIndex>=0)fs.writeFileSync(process.argv[outputIndex+1],JSON.stringify({schema:1,reports},null,2)+'\n');
if(errors)throw Error(errors+' known UI translations or markers need review');
console.log('PASS: localization markers and known translations; unreviewed candidates remain manual review.');
