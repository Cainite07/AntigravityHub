'use strict';
// Development tool: review generated payloads before using a new profile.
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const asar=await import('@electron/asar');
  const packing=require('./prepare.cjs');
  const file=path.join(__dirname,'unified-profile.json'),profile=JSON.parse(fs.readFileSync(file));
  const base=path.resolve(__dirname,profile.baseArchive);
  if(packing.sha(fs.readFileSync(base))!==profile.baseSha256)throw Error('Unreviewed base');
  const changes=require('./unified-build.cjs').changesFromBase(asar,base);
  profile.release='AntigravityHub1.3.3+Hans23.2+session-speed';
  profile.reviewDate='2026-10-10';
  profile.targetModules=Object.fromEntries([...changes].map(([file,bytes])=>[file,packing.sha(bytes)]));
  fs.writeFileSync(file,JSON.stringify(profile,null,2)+'\n');
  const compatFile=path.join(__dirname,'compatibility.json'),compat=JSON.parse(fs.readFileSync(compatFile));
  compat.versions[profile.version].patchedUtils=profile.targetModules['dist/utils.js'];
  compat.versions[profile.version].patchedTray=profile.targetModules['dist/tray.js'];
  fs.writeFileSync(compatFile,JSON.stringify(compat,null,2)+'\n');
  console.log('Reviewed profile generated for '+changes.size+' explicitly modified modules.');
})().catch(e=>{console.error(e.message);process.exit(1);});

