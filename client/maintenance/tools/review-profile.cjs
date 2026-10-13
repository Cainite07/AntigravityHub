'use strict';
// Development tool: review generated payloads before using a new profile.
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const asar=await import('@electron/asar');
  const packing=require('./prepare.cjs');
  const requestedVersion=process.argv[2] || '2.22.0';
  const profile=require('./profiles.cjs').forVersion(requestedVersion);
  if (!profile) throw Error('No reviewed profile for '+requestedVersion);
  const file=path.join(__dirname,profile.file);
  delete profile.file;
  const base=path.resolve(__dirname,profile.baseArchive);
  if(packing.sha(fs.readFileSync(base))!==profile.baseSha256)throw Error('Unreviewed base');
  const changes=require('./unified-build.cjs').changesFromBase(asar,base);
  const hubVersion=fs.readFileSync(path.resolve(__dirname,'../../../src/AntigravityHub/AntigravityHub.csproj'),'utf8').match(/<Version>(\d+\.\d+\.\d+)<\/Version>/)?.[1];
  if (!hubVersion) throw Error('Invalid Hub version');
  profile.release='AntigravityHub'+hubVersion+'+client'+requestedVersion;
  profile.reviewDate='2026-10-13';
  const priorRelease='835cc022ca97e30eea9efcb051e0c08aac2a6a00b7d8d29d172524da8985ef12';
  if (requestedVersion==='2.22.0' && !profile.allowedSourceHashes.includes(priorRelease)) profile.allowedSourceHashes.push(priorRelease);
  const priorArchive='a30906ce2887956131cbdafa50624a8509d1eda85c19d461686240484c1fa6f0';
  if (requestedVersion==='2.22.0' && !profile.allowedSourceHashes.includes(priorArchive)) profile.allowedSourceHashes.push(priorArchive);
  const previous223='094ab06db060dd6bcd64f063a8dcb9de537ff7de4998c58cce5fd164a03401f4';
  if (requestedVersion==='2.22.0' && !profile.allowedSourceHashes.includes(previous223)) profile.allowedSourceHashes.push(previous223);
  profile.targetModules=Object.fromEntries([...changes].map(([file,bytes])=>[file,packing.sha(bytes)]));
  fs.writeFileSync(file,JSON.stringify(profile,null,2)+'\n');
  const compatFile=path.join(__dirname,'compatibility.json'),compat=JSON.parse(fs.readFileSync(compatFile));
  compat.versions[profile.version] ||= {utils:require('./adapter2191.cjs').INPUTS.utils,tray:require('./adapter2191.cjs').INPUTS.tray};
  compat.versions[profile.version].patchedUtils=profile.targetModules['dist/utils.js'];
  compat.versions[profile.version].patchedTray=profile.targetModules['dist/tray.js'];
  fs.writeFileSync(compatFile,JSON.stringify(compat,null,2)+'\n');
  console.log('Reviewed profile generated for '+changes.size+' explicitly modified modules.');
})().catch(e=>{console.error(e.message);process.exit(1);});

